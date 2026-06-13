// Vite plugin that teaches Vite to load `.azeroth` files: compile() turns the
// markup into h() calls, then Vite strips any TS, yielding a normal JS module.
// Runs with `enforce: 'pre'` so it sees the raw source before Vite's other
// transforms.
//
// `vite` is a peer dependency, imported only at transform time via a dynamic
// import - so importing `@azerothjs/compiler` elsewhere (the playground, unit
// tests, an SSR build) never pulls Vite in.
//
// HMR: this plugin re-transforms a `.azeroth` file on every edit, so the
// updated module propagates through Vite's graph like any other. Because
// AzerothJS has no VDOM, the app accepts the update at its root and re-renders
// (see the demo's app.ts) - a flash-free swap with no page reload. State
// resets, which is the honest model for a framework with no component-instance
// tree.

import type { Plugin } from 'vite';
import { compile } from './compile.ts';
import { lintSource } from './lint.ts';
import { buildLineStarts, locationFor } from './sourcemap.ts';

/** Options for the AzerothJS Vite plugin. */
export interface AzerothPluginOptions
{
    /** File extension to handle. Default: `'.azeroth'`. */
    extension?: string;

    /**
     * Compile target for CLIENT transforms. `'dom'` emits template-cloning
     * output behind a render-mode guard: SSR and hydrate() ride the
     * universal h() branch, fresh client creation takes the clone path.
     * Costs the duplicated region code in the bundle. Default:
     * `'universal'`. SSR transforms always compile universal regardless
     * (the server bundle has no use for templates).
     */
    target?: 'universal' | 'dom';

    /**
     * Inject the dev error overlay (`@azerothjs/devtools-overlay`) into
     * index.html during `vite serve`. Never injected into builds. Default:
     * true.
     */
    overlay?: boolean;
}

/**
 * The AzerothJS Vite plugin. Add it to your Vite config so imports
 * of `.azeroth` files compile to runnable modules.
 *
 * Without azeroth(): call compile() on each `.azeroth` source yourself, then
 * run the result through a TS-to-JS step and feed it back into the bundler:
 *
 *     const compiled = compile(readFileSync(file, 'utf8'), file);
 *     const js = transformWithOxc(compiled.code, file, { lang: 'ts' });
 *     // wire js back into the build by hand; source maps to the markup are on you
 *
 * With azeroth(): drop it in `plugins` and Vite loads `.azeroth` files directly:
 *
 *     export default defineConfig({ plugins: [azeroth()] });
 *     // imports of *.azeroth just work; maps chain back to the original markup
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
export function azeroth(options: AzerothPluginOptions = {}): Plugin
{
    const extension = options.extension ?? '.azeroth';
    const clientTarget = options.target ?? 'universal';
    const overlay = options.overlay ?? true;
    let serving = false;

    return {
        name: 'azerothjs',
        enforce: 'pre',

        configResolved(config: { command: string })
        {
            serving = config.command === 'serve';
        },

        // Dev server only: load the error overlay before the app, so
        // uncaught reactive errors surface in the page instead of dying in
        // the console. Builds are never touched.
        transformIndexHtml()
        {
            if (!serving || !overlay)
            {
                return undefined;
            }
            return [{
                tag: 'script',
                attrs: { type: 'module' },
                children: "import { installOverlay } from '@azerothjs/devtools-overlay';\ninstallOverlay();",
                injectTo: 'head' as const
            }];
        },

        async transform(code: string, id: string, transformOptions?: { ssr?: boolean })
        {
            // Strip any `?query` suffix Vite appends to module ids.
            const filename = id.split('?')[0];
            if (!filename.endsWith(extension))
            {
                return null;
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
                this?.warn(`${ finding.code }: ${ finding.message }`, { line: loc.line + 1, column: loc.column });
            }

            // 1) markup -> runtime calls (plus a source map back to
            //    .azeroth). SSR must stay universal: template cloning has no
            //    string mode.
            const target = transformOptions?.ssr ? 'universal' : clientTarget;
            const compiled = compile(code, filename, { target });

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
