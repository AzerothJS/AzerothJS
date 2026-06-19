// azeroth-tsc: a combined `.ts` + `.azeroth` type-checker, the vue-tsc
// equivalent for this framework. `tsc` itself cannot parse `.azeroth` markup, so
// this driver builds ONE TypeScript program containing both the project's real
// `.ts` files AND every `.azeroth` file (compiled to a virtual TS module by the
// language service). Because both live in the same program:
//   - a `.ts` file importing `'./x.component.azeroth'` resolves the component's
//     REAL default/named/type exports (no `declare module '*.azeroth'` shim);
//   - `.azeroth` <-> `.azeroth` and `.azeroth` <-> `.ts` imports resolve both ways;
//   - `.azeroth` internals are still checked.
// Diagnostics map back to original `.ts`/`.azeroth` positions and print in the
// familiar `tsc` format. It does not emit `.js` (the Vite plugin / compiler does
// that) - like `tsc --noEmit`, it is a gate that REPLACES `tsc && azeroth-tsc`.

import path from 'node:path';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import ts from 'typescript';
import { AzerothLanguageService, pathToUri, DiagnosticSeverity } from '@azerothjs/language-service';

/** Options controlling a single check run. */
export interface TscOptions
{
    /** Directory to search for `.azeroth` files (default: cwd). */
    cwd?: string;

    /** Explicit tsconfig path; otherwise the nearest one is used. */
    project?: string;

    /** Re-check on every `.azeroth` change instead of running once. */
    watch?: boolean;

    /** Sink for formatted output (default: stdout). */
    write?: (text: string) => void;
}

/** A running watch session. */
export interface TscWatcher
{
    /** Runs one full check pass now (re-reading files from disk). */
    recheck: () => TscResult;

    /** Stops watching and releases the file-system watcher. */
    close: () => void;
}

/** Outcome of a check run. */
export interface TscResult
{
    /** Number of files checked (`.azeroth` + `.ts`). */
    fileCount: number;

    /** Number of error-severity diagnostics found. */
    errorCount: number;
}

/** Parses the argv subset this CLI understands into {@link TscOptions}. */
export function parseArgs(argv: string[]): TscOptions
{
    const options: TscOptions = {};
    for (let i = 0; i < argv.length; i++)
    {
        const arg = argv[i];
        if (arg === '--project' || arg === '-p')
        {
            options.project = argv[++i];
        }
        else if (arg.startsWith('--project='))
        {
            options.project = arg.slice('--project='.length);
        }
        else if (arg === '--watch' || arg === '-w')
        {
            options.watch = true;
        }
        else if (!arg.startsWith('-'))
        {
            options.cwd = arg;
        }
    }
    return options;
}

/**
 * Type-checks every `.azeroth` file under `cwd` against the project's tsconfig,
 * printing `tsc`-style diagnostics. Returns the file/error counts; the caller
 * decides the process exit code.
 *
 * @example
 * ```ts
 * const { errorCount } = runTsc({ cwd: 'app' });
 * process.exit(errorCount > 0 ? 1 : 0);
 * ```
 */
export function runTsc(options: TscOptions = {}): TscResult
{
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const write = options.write ?? ((text: string): void =>
    {
        process.stdout.write(text);
    });

    // rootProjectFiles: pull the project's real `.ts` files into the same
    // program as the `.azeroth` virtual modules, so the `.ts` side is checked and
    // the `.ts` -> `.azeroth` import boundary resolves real types.
    const service = new AzerothLanguageService(cwd, options.project, { rootProjectFiles: true });
    return checkPass(service, cwd, write, new Set());
}

/**
 * Runs one diagnostic pass over every `.azeroth` file under `cwd` using the
 * given (possibly long-lived) service. `open` tracks which document URIs were
 * open after the previous pass so files deleted since then are closed - this is
 * what lets a single service be reused across watch passes without leaking
 * stale documents. On return, `open` holds exactly the URIs seen this pass.
 */
function checkPass(
    service: AzerothLanguageService,
    cwd: string,
    write: (text: string) => void,
    open: Set<string>
): TscResult
{
    const files = ts.sys.readDirectory(
        cwd,
        ['.azeroth'],
        ['**/node_modules/**', '**/dist/**', '**/.git/**'],
        ['**/*.azeroth']
    );

    // On a reused service (watch), a file created or deleted since the last pass
    // changes the program's root set; refresh discovery so cross-file resolution
    // stays correct. Skipped on the first pass - the constructor just discovered.
    if (open.size > 0 && files.length !== open.size)
    {
        service.refreshWorkspace();
    }

    const seen = new Set<string>();
    let errorCount = 0;

    // 1) The `.azeroth` files: diagnostics map back to original markup positions.
    for (const file of files)
    {
        const source = ts.sys.readFile(file);
        if (source === undefined)
        {
            continue;
        }
        const uri = pathToUri(file);
        seen.add(uri);
        // didChange opens-or-updates: it bumps the version and invalidates just
        // this file's virtual cache, so the reused service always reflects disk.
        service.didChange(uri, source);

        for (const diag of service.getDiagnostics(uri))
        {
            const isError = diag.severity === DiagnosticSeverity.Error;
            if (isError)
            {
                errorCount++;
            }
            write(formatDiagnostic(cwd, file, diag, isError) + '\n');
        }
    }

    // 2) The project's real `.ts` files (from tsconfig), checked in the
    // same program - this is what lets a `.ts` barrel importing a `.azeroth`
    // component type-check against real types, so the consumer can delete its
    // `declare module '*.azeroth'` shim.
    const tsFiles = service.getProjectTsFiles();
    for (const file of tsFiles)
    {
        for (const diag of service.getTsDiagnostics(file))
        {
            const isError = diag.severity === DiagnosticSeverity.Error;
            if (isError)
            {
                errorCount++;
            }
            write(formatDiagnostic(cwd, file, diag, isError) + '\n');
        }
    }

    // Drop documents whose files vanished since the previous pass.
    for (const uri of open)
    {
        if (!seen.has(uri))
        {
            service.didClose(uri);
        }
    }
    open.clear();
    for (const uri of seen)
    {
        open.add(uri);
    }

    const total = files.length + tsFiles.length;
    if (errorCount === 0)
    {
        write(`Checked ${ total } file(s) (${ files.length } .azeroth, ${ tsFiles.length } .ts); no type errors.\n`);
    }
    else
    {
        write(`\nFound ${ errorCount } error(s) across ${ total } file(s) (${ files.length } .azeroth, ${ tsFiles.length } .ts).\n`);
    }

    return { fileCount: total, errorCount };
}

/**
 * Runs an initial check, then re-checks whenever a `.azeroth` file under `cwd`
 * changes. A single language service is reused across passes (each pass re-reads
 * changed files from disk and bumps their version), so unchanged files and the
 * lib/node_modules program are not re-parsed every time. Returns a handle:
 * `recheck()` forces a pass (used by tests and the file watcher); `close()`
 * stops watching. The returned watcher keeps the process alive via the
 * underlying fs watcher.
 *
 * @example
 * ```ts
 * const w = watchTsc({ cwd: 'app' }); // checks now, then on every change
 * // ... later: w.close();
 * ```
 */
export function watchTsc(options: TscOptions = {}): TscWatcher
{
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const write = options.write ?? ((text: string): void =>
    {
        process.stdout.write(text);
    });

    // One service for the whole session: lib.d.ts, node_modules and unchanged
    // `.azeroth` files are parsed once and reused across passes via the document
    // registry, instead of building a fresh program on every change. `open`
    // tracks the open document set so deleted files are closed between passes.
    const service = new AzerothLanguageService(cwd, options.project, { rootProjectFiles: true });
    const open = new Set<string>();

    const recheck = (): TscResult =>
    {
        write('\n[azeroth-tsc] checking...\n');
        try
        {
            // Re-scan + bump the project version so on-disk edits to BOTH
            // `.ts` and `.azeroth` files are re-read this pass (the first pass
            // skips it - the constructor just discovered).
            if (open.size > 0)
            {
                service.refreshWorkspace();
            }
            return checkPass(service, cwd, write, open);
        }
        catch (error)
        {
            // A bad tsconfig or an unreadable file must not kill the watch loop;
            // report it and keep watching.
            const message = error instanceof Error ? error.message : String(error);
            write(`[azeroth-tsc] check failed: ${ message }\n`);
            return { fileCount: 0, errorCount: 0 };
        }
    };

    recheck();

    let debounce: ReturnType<typeof setTimeout> | null = null;
    let watcher: FSWatcher | undefined;
    try
    {
        watcher = fsWatch(cwd, { recursive: true }, (_event, fileName) =>
        {
            // Recursive watch reports every file; only react to source the
            // combined checker covers. AzerothJS projects are `.ts` + `.azeroth`
            // (markup lives in `.azeroth`), so those two extensions.
            if (fileName && !/\.(?:azeroth|ts)$/.test(String(fileName)))
            {
                return;
            }
            if (debounce)
            {
                clearTimeout(debounce);
            }
            debounce = setTimeout(recheck, 120);
        });
        write(`[azeroth-tsc] watching ${ cwd } for .azeroth changes (Ctrl+C to exit)\n`);
    }
    catch
    {
        // Recursive watch isn't supported on every platform; fall back to a
        // one-shot check rather than crashing.
        write('[azeroth-tsc] file watching unavailable on this platform; ran a single check\n');
    }

    return {
        recheck,
        close: (): void =>
        {
            if (debounce)
            {
                clearTimeout(debounce);
            }
            watcher?.close();
        }
    };
}

/** Formats one diagnostic in `tsc`'s `file(line,col): error TSxxxx: msg` shape. */
function formatDiagnostic(
    cwd: string,
    file: string,
    diag: { range: { start: { line: number; character: number } }; message: string; code?: string | number },
    isError: boolean
): string
{
    const rel = path.relative(cwd, file).replace(/\\/g, '/');
    const line = diag.range.start.line + 1;
    const column = diag.range.start.character + 1;
    const severity = isError ? 'error' : 'warning';
    const code = typeof diag.code === 'number' ? ` TS${ diag.code }` : '';
    return `${ rel }(${ line },${ column }): ${ severity }${ code }: ${ diag.message }`;
}
