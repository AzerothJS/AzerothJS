/**
 * MODULE: compiler/vite - the AzerothJS Vite plugin
 *
 * Teaches Vite to load `.azeroth` files: generateModule() turns a component module into the unified
 * runtime output, then Vite strips any TS (via oxc), yielding a normal JS module. Runs with
 * `enforce: 'pre'` so it sees the raw source before Vite's other transforms.
 *
 * `vite` is a PEER dependency, imported only at transform time via a dynamic import - so importing
 * `@azerothjs/compiler` elsewhere (tooling, unit tests, an SSR build) never pulls Vite in.
 *
 * HMR: the plugin re-transforms a `.azeroth` file on every edit, so the updated module propagates
 * through Vite's graph like any other. Because AzerothJS has no VDOM, the app accepts the update at
 * its root and re-renders - a flash-free swap with no page reload. State resets, which is the honest
 * model for a framework with no component-instance tree.
 *
 * @see {@link azeroth} - the plugin factory
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, type Dirent } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, relative, dirname, basename, isAbsolute, sep } from 'node:path';

import type { Logger as ViteLogger, LogLevel as ViteLogLevel, Plugin } from 'vite';

import { lintSource } from './lint.ts';
import { buildLineStarts, locationFor } from './sourcemap.ts';
import { generateModule } from './codegen.ts';
import { diagnoseModule, diagnoseUnusedImports, escapeRegExp } from './diagnostics.ts';
import { createIncrementalChecker, type AzerothTypeChecker } from './typecheck-ts.ts';
import { emitDeclarationsWithMap, type DeclarationOutput } from './declarations.ts';
import { CompileError } from './markup-parser.ts';
import { azerothViteLogger } from './vite-logger.ts';
import { printBanner } from '@azerothjs/logger';

/** The Rollup plugin context when Vite binds it; unit tests invoke hooks bare, so it may be absent. */
type MaybeCtx = { warn?: (message: string, position?: { line: number; column: number }) => void; error?: (message: string, position?: { line: number; column: number }) => void } | undefined;

/**
 * Directory (under the project root) that holds the generated `.azeroth` type projections. Nested
 * under `.azeroth/` so that folder can namespace other generated `.azeroth` tooling output in future.
 */
const DECLARATIONS_DIR = '.azeroth/types';

/** Options for the AzerothJS Vite plugin. */
export interface AzerothPluginOptions
{
    /** File extension to handle. Default: `'.azeroth'`. */
    extension?: string;

    /**
     * Run the type-checking layer (real TypeScript Program) and FAIL the build on any type error - a
     * non-function event handler (`onClick={count}`), a wrong-typed component prop, or a missing
     * required prop, including across `.azeroth` file boundaries. **Default: `true`.**
     *
     * The check is sound (segment-scoped, so it never reports a false error; markup children are a
     * documented false negative - see the compiler README). All files share ONE incremental checker
     * (lib and dependency files parse once per build), so a typical component adds single-digit
     * milliseconds. Set it to `false` to skip type checking entirely.
     */
    typeCheck?: boolean;

    /**
     * Spaces per nesting level for markup TAGS, warned about at build time. `0` disables the
     * rule. **Default: `4`.**
     *
     * ESLint's own `indent` cannot cover markup: the eslint-plugin lints the PROJECTION, whose
     * whitespace the compiler re-flows, so a report there would name a column the author never
     * wrote. This rule reads the original source instead. It judges only tags that OPEN a line,
     * and never looks inside an expression hole - what is in there is TypeScript.
     */
    markupIndent?: number;

    /**
     * Emit a TypeScript projection of every `.azeroth` file so `.ts`/`.js` files that import them
     * resolve and type-check WITHOUT any editor plugin - in WebStorm/JetBrains as well as plain `tsc`.
     * **Default: `false`.**
     *
     * This is the same technique Vue (Volar) and Svelte (`svelte2tsx`) use - a TypeScript view of each
     * component that carries its real exported types - except those keep it in memory inside a language
     * server the IDE ships. WebStorm exposes no third-party API to feed such a projection in-memory, so
     * this writes the identical {@link emitDeclarations} projection to a hidden `.azeroth/types/` mirror
     * under the project root. Point TypeScript at it with `rootDirs` so imports resolve across the two:
     *
     *     // tsconfig.json
     *     { "compilerOptions": { "rootDirs": [".", "./.azeroth/types"] } }
     *
     * The mirror is generated - add `.azeroth/` to `.gitignore`. It is refreshed at `buildStart` and on
     * every transform/HMR edit, and only written when a projection actually changes.
     */
    emitDeclarations?: boolean;

    /**
     * Emit components for SSR/hydration as well as the client. **Default: `true`.**
     *
     * Set `false` for a client-only app: each compiled component drops its
     * `isStringMode()/isHydrating()` h()-tree branch and emits just the template-clone
     * path - roughly half the compiled output per component, and the SSR runtime
     * machinery tree-shakes out of the bundle. Do not disable this if anything in the
     * app calls `renderToString`/`hydrate`.
     */
    ssr?: boolean;

    /**
     * Forward browser logs to the dev terminal. **Default: `'errors'`** -
     * console.warn/console.error plus uncaught errors and unhandled rejections
     * (with source-mapped stacks). `'all'` adds console.log/console.info; `false`
     * turns the channel off. Rides vite's own `server.forwardConsole` transport
     * (which otherwise defaults on only under an AI agent); the plugin's logger
     * restyles the lines into a rate-limited `client` lane. A user-configured
     * `server.forwardConsole` wins. Dev server only.
     */
    clientLogs?: 'all' | 'errors' | false;
}

/** True when `path` is `dir` itself or sits under it (no `..` escape, no other root/drive). */
function contains(dir: string, path: string): boolean
{
    const rel = relative(dir, path);
    return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

/**
 * Writes `content` to `dtsPath` only when it differs, so the dev-server watcher does not churn.
 * `mirrorRoot` is re-checked here because this is the only place the compiler writes into a user's
 * tree: every derived name (both import forms, each `.d.ts` and its `.d.ts.map`) passes through it, so
 * a path that escaped the mirror can never reach writeFileSync.
 */
function writeIfChanged(dtsPath: string, content: string, mirrorRoot: string): void
{
    if (!contains(mirrorRoot, dtsPath))
    {
        return;
    }
    let prev: string | null;
    try
    {
        prev = readFileSync(dtsPath, 'utf8');
    }
    catch
    {
        prev = null;
    }
    if (prev !== content)
    {
        writeFileSync(dtsPath, content);
    }
}

/**
 * Writes the TypeScript projection for one `.azeroth` module into the hidden `.azeroth/types/` mirror,
 * preserving its path relative to the project root so `rootDirs` lines the two trees up. Two names are
 * written so both import conventions resolve (a project uses one; the other is inert):
 *   - `<mirror>/<rel>.d.ts`          resolves EXTENSIONLESS imports      - `import X from './x'`
 *   - `<mirror>/<rel>.azeroth.d.ts`  resolves EXPLICIT-extension imports - `import X from './x.azeroth'`
 * Each declaration gets a `.d.ts.map` pointing into the real `.azeroth` SOURCE (the emit remaps
 * TypeScript's declaration map through the projection), so an editor's go-to-definition follows it
 * onto the component declaration instead of stopping inside the generated mirror. A malformed source
 * (already reported with a located error by the compile/type-check gate) is swallowed so declaration
 * emit never crashes the build; any prior projection is left untouched.
 */
function writeDeclarationMirror(source: string, azerothFile: string, root: string, extension: string): void
{
    let output: DeclarationOutput;
    try
    {
        output = emitDeclarationsWithMap(source, azerothFile);
    }
    catch
    {
        return;
    }
    const mirrorRoot = join(root, DECLARATIONS_DIR);
    const rel = relative(root, azerothFile);
    const mirrorStem = join(mirrorRoot, rel.slice(0, -extension.length));
    // A module resolved OUTSIDE the root (a monorepo sibling, a linked workspace, a hoisted
    // node_modules copy) makes `rel` start with `..` segments, which join() normalises away - eating
    // `.azeroth/types` and then climbing past the root, where the write would land on a real file of the
    // user's. Emit only what stays inside the mirror; anything else has no mirror path and is skipped.
    if (!contains(mirrorRoot, mirrorStem))
    {
        return;
    }
    mkdirSync(dirname(mirrorStem), { recursive: true });
    // The map's `sources` must be relative to the map's own directory (the mirror folder).
    const sourceRel = relative(dirname(mirrorStem), azerothFile).replace(/\\/g, '/');
    for (const stem of [mirrorStem, mirrorStem + extension])
    {
        const dtsName = basename(stem) + '.d.ts';
        if (output.map === null)
        {
            writeIfChanged(stem + '.d.ts', output.dts, mirrorRoot);
            continue;
        }
        writeIfChanged(stem + '.d.ts', `${ output.dts }//# sourceMappingURL=${ dtsName }.map\n`, mirrorRoot);
        writeIfChanged(stem + '.d.ts.map', JSON.stringify({ ...output.map, file: dtsName, sources: [sourceRel] }), mirrorRoot);
    }
}

let cachedVersion: string | undefined | null = null;

/** @internal The compiler's own version, for the banner; a broken read just omits it. */
function compilerVersion(): string | undefined
{
    if (cachedVersion === null)
    {
        try
        {
            cachedVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version;
        }
        catch
        {
            cachedVersion = undefined;
        }
    }
    return cachedVersion;
}

/**
 * @internal Banner URL entries from the dev server's BOUND address: `Local` always,
 * one `Network` per non-internal IPv4 when the bind is unspecified - the same
 * addresses vite's suppressed identity block would have shown.
 */
function boundUrls(address: unknown): Array<readonly [string, string]>
{
    if (typeof address !== 'object' || address === null || typeof (address as { port?: unknown }).port !== 'number')
    {
        return [];
    }
    const { port, address: bound } = address as { port: number; address?: string };
    const entries: Array<readonly [string, string]> = [];
    if (bound === undefined || bound === '0.0.0.0' || bound === '::')
    {
        entries.push(['Local', `http://localhost:${ port }`]);
        for (const nets of Object.values(networkInterfaces()))
        {
            for (const net of nets ?? [])
            {
                if (net.family === 'IPv4' && !net.internal)
                {
                    entries.push(['Network', `http://${ net.address }:${ port }`]);
                }
            }
        }
    }
    else
    {
        const host = bound === '::1' || bound === '127.0.0.1' ? 'localhost' : bound;
        entries.push(['Local', `http://${ host }:${ port }`]);
    }
    return entries;
}

/** Recursively collects files ending in `ext` under `dir`, skipping dependency/output/hidden folders. */
function collectFiles(dir: string, ext: string, out: string[] = []): string[]
{
    let entries: Dirent[];
    try
    {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch
    {
        return out;
    }
    for (const entry of entries)
    {
        if (entry.isDirectory())
        {
            if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'build' && !entry.name.startsWith('.'))
            {
                collectFiles(join(dir, entry.name), ext, out);
            }
        }
        else if (entry.name.endsWith(ext))
        {
            out.push(join(dir, entry.name));
        }
    }
    return out;
}

/**
 * The dependency-scanner's view of `.azeroth` files. Vite's optimizer only crawls modules it
 * can read (JS extensions, html-likes, and `optimizeDeps.extensions` entries), and its scan
 * runs OUTSIDE the normal plugin pipeline - only plugins passed through
 * `optimizeDeps.rolldownOptions.plugins` participate. Without this shim the app's entry
 * `.azeroth` module is externalized at scan, ZERO dependencies are pre-bundled, and every dep
 * is discovered at runtime instead - where a mid-session re-optimization can invalidate an
 * in-flight dynamic import (`await import('@azerothjs/devtools')` dying on first load after a
 * fresh install was exactly this).
 *
 * The handler runs {@link generateModule} - the one lowering - with the SAME options the
 * transform hook passes (scan only exists for dev serves, so `dev` is true by construction),
 * so the scanner sees exactly the imports the served module will have, the injected
 * `azerothjs/internal` included. Output is handed to rolldown as TS (its oxc pass strips
 * types; the `.astro` scanner does the same). A file that fails to read or compile degrades
 * to an empty module: its deps stay runtime-discovered as before, and the transform hook
 * reports the real error with full diagnostics when Vite serves it.
 *
 * Both parameters are required: the extension's one default lives on
 * {@link AzerothPluginOptions.extension}, and restating it here would be a second copy.
 *
 * @internal Exported for unit tests.
 */
export function azerothDepScanPlugin(extension: string, ssr: boolean):
{ name: string; load: { filter: { id: RegExp }; handler(id: string): { code: string; moduleType: string } } }
{
    return {
        name: 'azerothjs:dep-scan',
        load: {
            filter: { id: new RegExp(`${ escapeRegExp(extension) }$`) },
            handler(id: string): { code: string; moduleType: string }
            {
                try
                {
                    const source = readFileSync(id, 'utf-8');
                    return { code: generateModule(source, id.replace(/\\/g, '/'), { ssr, dev: true }).code, moduleType: 'ts' };
                }
                catch
                {
                    return { code: '', moduleType: 'js' };
                }
            }
        }
    };
}

/**
 * Creates the Vite plugin that compiles `.azeroth` files. Add it to a Vite config and `.azeroth`
 * imports work like any other module; by default the build also type-checks each file and fails on a
 * type error (see {@link AzerothPluginOptions.typeCheck}). Runs `enforce: 'pre'` so it transforms the
 * raw source before Vite's other plugins.
 *
 * @param options - Plugin options; all optional. See {@link AzerothPluginOptions}.
 * @returns The Vite plugin object.
 * @example
 * // vite.config.ts
 * import { azeroth } from '@azerothjs/compiler';
 * export default { plugins: [azeroth()] };
 */
export function azeroth(options: AzerothPluginOptions = {}): Plugin
{
    const extension = options.extension ?? '.azeroth';
    const typeCheck = options.typeCheck ?? true;
    const emitDecls = options.emitDeclarations ?? false;
    const markupIndent = options.markupIndent ?? 4;
    const clientLogs = options.clientLogs ?? 'errors';
    // ONE incremental type-checker for the whole build: it binds lib.d.ts once and reuses it across
    // every `.azeroth` file (lazily created on first use), instead of building a fresh ts.Program per
    // file. Persists for the plugin instance, so dev-server HMR re-checks are incremental too.
    let checker: AzerothTypeChecker | null = null;
    let root = process.cwd();
    let dev = false;

    return {
        name: 'azerothjs',
        enforce: 'pre',

        // Client-only build (`ssr: false`): substitute the reactivity package's internal
        // render-mode module with its constant-mode client stub. The stub's getters return
        // literals, so the minifier folds every `if (isStringMode() || isHydrating())`
        // branch across the runtime and the SSR/hydration machinery those branches
        // reference drops out of the bundle. Matched by the RELATIVE specifier its
        // sibling modules use, scoped to the reactivity package's files.
        ...(options.ssr === false
            ? {
                resolveId(source: string, importer: string | undefined): string | null
                {
                    if (
                        (source === './render-mode.js' || source === './render-mode.ts') &&
                        importer !== undefined &&
                        /[\\/]reactivity[\\/](dist|src)[\\/]/.test(importer)
                    )
                    {
                        const clientName = source.replace('render-mode', 'render-mode-client');
                        return join(dirname(importer), clientName);
                    }
                    return null;
                }
            }
            : {}),

        // Register the extension with Vite's resolver so component imports may
        // omit it (e.g. `import Modal from './modal.component'`). Explicit
        // `.azeroth` specifiers keep working - this is purely additive. We must
        // preserve Vite's default list (setting `resolve.extensions` otherwise
        // replaces it and breaks `.ts`/`.js` resolution) and any user entries.
        config(
            config: {
                resolve?: { extensions?: string[] };
                logLevel?: ViteLogLevel;
                customLogger?: ViteLogger;
                server?: { forwardConsole?: unknown };
                optimizeDeps?: { extensions?: string[]; rolldownOptions?: { plugins?: unknown } };
            },
            env: { command?: string }
        )
        {
            // Vite's default extension list, minus `.jsx`/`.tsx`: an AzerothJS
            // project is `.ts` + `.azeroth`, so those are intentionally excluded.
            const defaults = ['.mjs', '.js', '.mts', '.ts', '.json'];
            const resolve = (config.resolve ??= {});
            const current = resolve.extensions ?? defaults;
            resolve.extensions = current.includes(extension)
                ? current
                : [...current, extension];

            if (env.command === 'serve')
            {
                // Dev serves speak with the framework's voice: vite's identity block is
                // dropped (the azeroth banner carries version + URLs), HMR notices are
                // restyled, diagnostics pass through untouched. A user-configured logger
                // always wins, and builds keep vite's own reporter.
                if (config.customLogger === undefined)
                {
                    config.customLogger = azerothViteLogger(config.logLevel);
                }

                // Browser logs reach the dev terminal through vite's own forwarding
                // (which source-maps error stacks and defaults ON only under an AI
                // agent); `clientLogs` turns it on for everyone and the injected
                // logger above restyles the lines into the `client` lane. A
                // user-configured `server.forwardConsole` wins.
                const server = (config.server ??= {});
                if (server.forwardConsole === undefined)
                {
                    server.forwardConsole = clientLogs === false
                        ? false
                        : {
                            unhandledErrors: true,
                            logLevels: clientLogs === 'all' ? ['error', 'warn', 'log', 'info'] : ['error', 'warn']
                        };
                }

                // Dependency scanner: without these, `.azeroth` modules fail vite's
                // isScannable gate, the entry is externalized at scan, and NOTHING is
                // pre-bundled (see azerothDepScanPlugin). Both merges are additive over
                // user config; `plugins` is nested rather than spread because vite
                // accepts promises and nested arrays there and flattens them itself.
                const optimizeDeps = (config.optimizeDeps ??= {});
                const scanExtensions = optimizeDeps.extensions ?? [];
                if (!scanExtensions.includes(extension))
                {
                    optimizeDeps.extensions = [...scanExtensions, extension];
                }
                const rolldownOptions = (optimizeDeps.rolldownOptions ??= {});
                const scanShim = azerothDepScanPlugin(extension, options.ssr !== false);
                rolldownOptions.plugins = rolldownOptions.plugins === undefined
                    ? [scanShim]
                    : [rolldownOptions.plugins, scanShim];
            }
        },

        // Capture the resolved project root so buildStart can locate every `.azeroth` file, and
        // whether this is the dev server (keyword declarations then carry their identifiers as
        // devtools debug names; a production build's output is unchanged).
        configResolved(resolved: { root?: string; command?: string })
        {
            if (resolved.root)
            {
                root = resolved.root;
            }
            dev = resolved.command === 'serve';
        },

        // The framework's face on the dev server: one banner when the server is up,
        // carrying what the COMPILER knows (component count, whether the type-check
        // gate guards this session). Vite's own block keeps the URLs; this one keeps
        // the identity. printBanner self-gates: TTY only, never in production.
        async configureServer(server: {
            httpServer?: { once(event: string, fn: () => void): void; address?: () => unknown } | null;
            watcher?: { on(event: string, fn: (path: string) => void): void };
        })
        {
            // By definition vite is running here; the import cost is paid once at startup.
            const viteVersion = (await import('vite') as { version?: string }).version;
            // The incremental checker caches dependency snapshots for its lifetime; without
            // these notices, a plain `.ts` file edited mid-session stays pinned at its first
            // snapshot and every later `.azeroth` check resolves imports against the STALE
            // copy (phantom "unknown" prop-type errors until a server restart).
            if (typeCheck && server.watcher !== undefined)
            {
                const notice = (path: string): void => checker?.invalidate(path);
                server.watcher.on('change', notice);
                server.watcher.on('add', notice);
                server.watcher.on('unlink', notice);
            }

            const startedAt = performance.now();
            const httpServer = server.httpServer;
            httpServer?.once('listening', () =>
            {
                const components = collectFiles(root, extension).length;
                printBanner({
                    version: compilerVersion(),
                    subtitle: 'dev',
                    entries:
                    [
                        // Vite's identity block is suppressed by the injected logger, so
                        // the banner carries the URLs it would have printed. Addresses
                        // come from the BOUND socket - `resolvedUrls` is not assigned
                        // until listen() resolves, after this event.
                        ...boundUrls(httpServer.address?.()),
                        ['Components', String(components)],
                        ['Type check', typeCheck ? 'on' : 'off'],
                        ...(viteVersion === undefined ? [] : [['Vite', `v${ viteVersion }`] as const])
                    ],
                    readyMs: performance.now() - startedAt
                });
            });
        },

        // Build the type-checker ONCE per build and PRIME it with the whole project's `.azeroth` files,
        // so the shared TypeScript Program is constructed a single time (lib + every file bound once)
        // instead of growing - and being incrementally rebuilt - as files are transformed one by one.
        buildStart()
        {
            // Discover every `.azeroth` file once, then share the list between priming the checker and
            // seeding the projection mirror - so a project-wide type-view exists before any `.ts` import
            // resolves (WebStorm/tsc see it without waiting for each file to be transformed).
            const files = (typeCheck || emitDecls) ? collectFiles(root, extension) : [];
            if (typeCheck)
            {
                checker = createIncrementalChecker();
                checker.prime(files);
            }
            if (emitDecls)
            {
                for (const file of files)
                {
                    writeDeclarationMirror(readFileSync(file, 'utf8'), file, root, extension);
                }
            }
        },

        async transform(code: string, id: string)
        {
            // Strip any `?query` suffix Vite appends to module ids.
            const filename = id.split('?')[0] ?? id;
            if (!filename.endsWith(extension))
            {
                return null;
            }

            // Keep the projection mirror fresh on every edit (HMR), from the live source so it reflects
            // the in-flight change. Only writes when the projection text actually changes.
            if (emitDecls)
            {
                writeDeclarationMirror(code, filename, root, extension);
            }

            // Lint before compiling: the rules catch mistakes the type
            // system can't (onClick={save()}, duplicate attributes), and a
            // build is where they reliably reach every contributor.
            const lineStarts = buildLineStarts(code);
            for (const finding of lintSource(code, { markupIndent }))
            {
                const loc = locationFor(finding.start, lineStarts);
                // Optional call: vite always binds the plugin context, but
                // unit tests invoke transform bare.
                (this as MaybeCtx)?.warn?.(`${ finding.code }: ${ finding.message }`, { line: loc.line + 1, column: loc.column });
            }

            // 0) Optional type-check (real TypeScript Program). When enabled, a type error
            //    (non-function handler, wrong-typed component prop) fails the build here, BEFORE
            //    compiling - no type-unsafe module reaches codegen. Off by default (see options).
            if (typeCheck)
            {
                // Pass the filename so relative imports of other `.azeroth` files resolve from disk
                // and cross-file component prop types are checked. One shared incremental checker
                // across the build (binds lib once) instead of a fresh ts.Program per file.
                checker ??= createIncrementalChecker();
                for (const finding of checker.check(filename, code))
                {
                    const loc = locationFor(finding.start, lineStarts);
                    (this as MaybeCtx)?.error?.(`${ finding.code }: ${ finding.message }`, { line: loc.line + 1, column: loc.column });
                    throw new Error(`${ finding.code }: ${ finding.message }`);
                }
            }

            // 1) Compile. generateModule is the SINGLE enforcement gate: it throws a
            //    located CompileError for any error-severity diagnostic, malformed/unclosed
            //    markup, or an illegal write (e.g. assigning a `derived`). The plugin and
            //    standalone callers therefore reject identical input - no silent emit on
            //    either path. The output is one mode-dispatched artifact (clone in the DOM,
            //    serialize in SSR string mode, adopt during hydration).
            let compiled: ReturnType<typeof generateModule>;
            try
            {
                compiled = generateModule(code, filename, { ssr: options.ssr !== false, dev });
            }
            catch (err)
            {
                const offset = err instanceof CompileError ? err.offset : 0;
                const loc = locationFor(offset, lineStarts);
                const message = err instanceof Error ? err.message : String(err);
                // Plugin context error() throws and fails the build; the rethrow covers
                // bare (non-plugin) invocations (e.g. unit tests calling transform directly).
                (this as MaybeCtx)?.error?.(message, { line: loc.line + 1, column: loc.column });
                throw (err instanceof Error ? err : new Error(message));
            }

            // 2) Warning-severity diagnostics. The compile succeeded, so diagnoseModule
            //    parses cleanly and reports no errors; surface the warnings non-blocking.
            // Unused-import detection needs the COMPILED JS (markup lowered to calls) + the source, so
            // it runs here rather than inside diagnoseModule (which would recurse into the compiler).
            for (const finding of [...diagnoseModule(code), ...diagnoseUnusedImports(code, compiled.code)])
            {
                if (finding.severity !== 'warning')
                {
                    continue;
                }
                const loc = locationFor(finding.start, lineStarts);
                (this as MaybeCtx)?.warn?.(`${ finding.code }: ${ finding.message }`, { line: loc.line + 1, column: loc.column });
            }

            // 3) TS -> JS (the compiled module may still contain types). Vite
            //    transforms via oxc; passing our map as `inMap` chains it, so
            //    the final map points all the way back to the original
            //    `.azeroth` source. `lang: 'ts'` is explicit since `.azeroth`
            //    doesn't imply TS.
            const { transformWithOxc } = await import('vite');
            return transformWithOxc(
                compiled.code,
                filename,
                { lang: 'ts' },
                compiled.map ?? undefined
            );
        }
    };
}
