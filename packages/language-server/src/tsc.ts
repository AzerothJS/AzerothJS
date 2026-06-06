// azeroth-tsc: a batch type-checker for `.azeroth` files, the vue-tsc
// equivalent for this framework. `tsc` itself cannot parse `.azeroth` markup,
// so this driver reuses the language service (which compiles each file to a
// virtual TypeScript module and maps diagnostics back to original positions)
// and prints them in the familiar `tsc` format. It is meant to run in CI and
// pre-commit, alongside `tsc` for the surrounding `.ts`.
//
// Scope: this reports type errors in `.azeroth` files. It does not emit `.js`
// (the Vite plugin / compiler does that) - like `tsc --noEmit`, it is a gate.

import path from 'node:path';
import ts from 'typescript';
import { AzerothLanguageService, pathToUri, DiagnosticSeverity } from '@azerothjs/language-service';

/** Options controlling a single check run. */
export interface TscOptions
{
    /** Directory to search for `.azeroth` files (default: cwd). */
    cwd?: string;

    /** Explicit tsconfig path; otherwise the nearest one is used. */
    project?: string;

    /** Sink for formatted output (default: stdout). */
    write?: (text: string) => void;
}

/** Outcome of a check run. */
export interface TscResult
{
    /** Number of `.azeroth` files checked. */
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

    const files = ts.sys.readDirectory(
        cwd,
        ['.azeroth'],
        ['**/node_modules/**', '**/dist/**', '**/.git/**'],
        ['**/*.azeroth']
    );

    const service = new AzerothLanguageService(cwd, options.project);
    let errorCount = 0;

    for (const file of files)
    {
        const source = ts.sys.readFile(file);
        if (source === undefined)
        {
            continue;
        }
        const uri = pathToUri(file);
        service.didOpen(uri, source);

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

    if (errorCount === 0)
    {
        write(`Checked ${ files.length } .azeroth file(s); no type errors.\n`);
    }
    else
    {
        write(`\nFound ${ errorCount } error(s) in ${ files.length } .azeroth file(s).\n`);
    }

    return { fileCount: files.length, errorCount };
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
