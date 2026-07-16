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
import { join, relative, dirname, basename } from 'node:path';

import type { Plugin } from 'vite';

import { lintSource } from './lint.ts';
import { buildLineStarts, locationFor } from './sourcemap.ts';
import { generateModule } from './codegen.ts';
import { diagnoseModule, diagnoseUnusedImports } from './diagnostics.ts';
import { createIncrementalChecker, type AzerothTypeChecker } from './typecheck-ts.ts';
import { emitDeclarationsWithMap, type DeclarationOutput } from './declarations.ts';
import { CompileError } from './markup-parser.ts';

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
     * The check is sound (segment-scoped, so it never reports a false error). Set it to `false` to
     * skip type checking - e.g. to shave build time on a large project, since each `.azeroth` file is
     * checked with its own TypeScript Program (a shared incremental Program is a future optimization).
     */
    typeCheck?: boolean;

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
}

/** Writes `content` to `dtsPath` only when it differs, so the dev-server watcher does not churn. */
function writeIfChanged(dtsPath: string, content: string): void
{
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
    const rel = relative(root, azerothFile);
    const mirrorStem = join(root, DECLARATIONS_DIR, rel.slice(0, -extension.length));
    mkdirSync(dirname(mirrorStem), { recursive: true });
    // The map's `sources` must be relative to the map's own directory (the mirror folder).
    const sourceRel = relative(dirname(mirrorStem), azerothFile).replace(/\\/g, '/');
    for (const stem of [mirrorStem, mirrorStem + extension])
    {
        const dtsName = basename(stem) + '.d.ts';
        if (output.map === null)
        {
            writeIfChanged(stem + '.d.ts', output.dts);
            continue;
        }
        writeIfChanged(stem + '.d.ts', `${ output.dts }//# sourceMappingURL=${ dtsName }.map\n`);
        writeIfChanged(stem + '.d.ts.map', JSON.stringify({ ...output.map, file: dtsName, sources: [sourceRel] }));
    }
}

/**
 * azeroth
 *
 * PURPOSE:
 * The AzerothJS Vite plugin. Add it to your Vite config so imports of `.azeroth` files compile to
 * runnable modules - with source maps back to the markup and build-time lint/diagnostics.
 *
 * WHY IT EXISTS:
 * It is the supported, batteries-included integration path. Without it you'd hand-wire generateModule
 * plus a TS->JS step plus source-map chaining plus extension resolution yourself:
 *
 *     const compiled = generateModule(readFileSync(file, 'utf8'), file);
 *     const js = transformWithOxc(compiled.code, file, { lang: 'ts' });
 *     // wire js back into the build by hand; source maps to the markup are on you
 *
 * With azeroth(): drop it in `plugins` and Vite loads `.azeroth` files directly, maps included.
 *
 * COMPILER / RUNTIME ROLE:
 * Build-time, compiler; the package's PRIMARY public API. Bridges the compiler to Vite for both CSR
 * and SSR builds (one artifact serves both).
 *
 * INPUT CONTRACT:
 * - options.extension?: the file extension to handle (default '.azeroth').
 *
 * OUTPUT CONTRACT:
 * - A Vite {@link Plugin} with `config` (registers the extension) and `transform` (compiles matching
 *   files) hooks, running at `enforce: 'pre'`.
 *
 * WHY THIS DESIGN:
 * `enforce: 'pre'` so it sees raw source before other transforms. The extension is added ADDITIVELY to
 * resolve.extensions (preserving Vite's defaults, so .ts/.js still resolve) so component imports may
 * omit it. Lint + semantic diagnostics run BEFORE compiling and surface as build warnings (catching
 * mistakes the type system can't). Compilation emits ONE unified, mode-dispatched artifact (clone in
 * the DOM, serialize in SSR, adopt on hydrate), and the compiler's source map is chained through oxc's
 * `inMap` so the final map points all the way back to the `.azeroth` source. `vite` is imported
 * dynamically so non-Vite consumers never pull it in.
 *
 * WHEN TO USE:
 * Any Vite-based AzerothJS app (CSR or SSR).
 *
 * WHEN NOT TO USE:
 * Non-Vite builds - call generateModule yourself and run a TS->JS step (the "without" snippet above).
 *
 * EDGE CASES:
 * - A `?query` suffix on the module id is stripped before the extension check.
 * - `this?.warn` is optional-chained, so bare (non-Vite) unit-test calls to `transform` don't crash.
 * - Non-matching files return null (Vite falls through to its normal handling).
 *
 * PERFORMANCE NOTES:
 * One transform per `.azeroth` file (and again on each HMR edit); lint/diagnose are linear in source.
 *
 * DEVELOPER WARNING:
 * Requires `vite` as a peer dependency at >= 6 (where `transformWithOxc` exists; vite 5 hard-crashes
 * the transform). HMR RESETS app state - there is no component-instance tree to preserve it.
 *
 * @param options - Plugin options (`extension`, `typeCheck`, `emitDeclarations`)
 * @returns A Vite {@link Plugin}
 * @see {@link AzerothPluginOptions}
 * @see {@link generateModule}
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from 'vite';
 * import { azeroth } from '@azerothjs/compiler';
 *
 * export default defineConfig({ plugins: [azeroth()] });
 * ```
 */
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
    // ONE incremental type-checker for the whole build: it binds lib.d.ts once and reuses it across
    // every `.azeroth` file (lazily created on first use), instead of building a fresh ts.Program per
    // file. Persists for the plugin instance, so dev-server HMR re-checks are incremental too.
    let checker: AzerothTypeChecker | null = null;
    let root = process.cwd();

    return {
        name: 'azerothjs',
        enforce: 'pre',

        // Register the extension with Vite's resolver so component imports may
        // omit it (e.g. `import Modal from './modal.component'`). Explicit
        // `.azeroth` specifiers keep working - this is purely additive. We must
        // preserve Vite's default list (setting `resolve.extensions` otherwise
        // replaces it and breaks `.ts`/`.js` resolution) and any user entries.
        config(config: { resolve?: { extensions?: string[] } })
        {
            // Vite's default extension list, minus `.jsx`/`.tsx`: an AzerothJS
            // project is `.ts` + `.azeroth`, so those are intentionally excluded.
            const defaults = ['.mjs', '.js', '.mts', '.ts', '.json'];
            const resolve = (config.resolve ??= {});
            const current = resolve.extensions ?? defaults;
            resolve.extensions = current.includes(extension)
                ? current
                : [...current, extension];
        },

        // Capture the resolved project root so buildStart can locate every `.azeroth` file.
        configResolved(resolved: { root?: string })
        {
            if (resolved.root)
            {
                root = resolved.root;
            }
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
            for (const finding of lintSource(code))
            {
                const loc = locationFor(finding.start, lineStarts);
                // Optional call: vite always binds the plugin context, but
                // unit tests invoke transform bare.
                (this as MaybeCtx)?.warn?.(`${ finding.code }: ${ finding.message }`, { line: loc.line + 1, column: loc.column });
            }

            // 0) Optional U1 type-check (real TypeScript Program). When enabled, a type error
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
                compiled = generateModule(code, filename);
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

            // 2) TS -> JS (the compiled module may still contain types). Vite
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
