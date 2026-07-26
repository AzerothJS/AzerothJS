/**
 * MODULE: kit/prerender - the build-time static pass
 *
 * Renders every `render: 'static'` page through the SSR bundle's renderer and
 * writes it into the client dist, after preserving the pristine SPA shell as
 * `shell.html` (what `mountPages` serves for `render: 'client'` pages and what
 * static pages splice over). A guard that redirects a static page is a BUILD
 * error - a prerendered redirect is a contradiction someone should hear about.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { flattenPages, prerenderFileFor, type PageRoute } from './index.ts';
import type { PageRenderer } from './ssr.ts';

/** The routes, client dist, and renderer the static {@link prerender} pass needs. */
export interface PrerenderOptions
{
    /** The route table - the same one passed to {@link mountPages}. */
    routes: PageRoute[];

    /** The built client directory (vite's dist); prerendered pages are written here. */
    clientDir: string;

    /** The per-url page renderer from the SSR bundle (`createPageRenderer(App, routes)`). */
    renderer: PageRenderer;
}

/** Runs the pass; returns the written page paths (for the build log). */
export async function prerender(options: PrerenderOptions): Promise<string[]>
{
    const indexPath = join(options.clientDir, 'index.html');
    const shellPath = join(options.clientDir, 'shell.html');
    if (!existsSync(indexPath))
    {
        throw new Error(`kit prerender: ${ indexPath } not found - run \`vite build\` first.`);
    }
    if (!existsSync(shellPath))
    {
        copyFileSync(indexPath, shellPath);
    }
    const shell = readFileSync(shellPath, 'utf8');

    const written: string[] = [];
    for (const page of flattenPages(options.routes))
    {
        if (page.render !== 'static')
        {
            continue;
        }
        if (page.path.includes(':') || page.path.includes('*'))
        {
            throw new Error(`kit prerender: "${ page.path }" is render: 'static' but has parameters - `
                + 'a parameterized page cannot prerender to one file; use render: \'server\'.');
        }
        const result = await options.renderer(page.path, shell);
        if (result.kind === 'redirect')
        {
            throw new Error(`kit prerender: "${ page.path }" redirected to "${ result.to }" during prerender - `
                + 'a static page cannot redirect; drop the guard or use render: \'server\'.');
        }
        // A static page that a guard blocks (or that doesn't match) cannot be a prerendered
        // file - both are contradictions someone should hear about at build time.
        if (result.kind === 'blocked')
        {
            throw new Error(`kit prerender: "${ page.path }" was blocked by a guard (status ${ result.status }) during prerender - `
                + 'a static page cannot be guarded; drop the guard or use render: \'server\'.');
        }
        if (result.status === 404)
        {
            throw new Error(`kit prerender: "${ page.path }" did not match any route during prerender - `
                + 'remove it from the static set or fix the route table.');
        }
        const file = join(options.clientDir, prerenderFileFor(page.path));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, result.html);
        written.push(page.path);
    }
    return written;
}
