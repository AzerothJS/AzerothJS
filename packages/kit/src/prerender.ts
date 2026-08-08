/**
 * MODULE: kit/prerender - the build-time static pass
 *
 * Renders every `render: 'static'` page through the SSR bundle's renderer and
 * writes it into the client dist, after preserving the pristine SPA shell as
 * `shell.html` (what `mountPages` serves for `render: 'client'` pages and what
 * static pages splice over). A guard that redirects a static page is a BUILD
 * error - a prerendered redirect is a contradiction someone should hear about.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

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

/**
 * @internal One `:param` pattern resolved against one param set, segment-wise so a value
 * can never re-trigger substitution. A missing or path-shaped value is a BUILD error - a
 * bad slug must fail the build, never become a path segment silently.
 */
export function resolveStaticPath(pattern: string, params: Record<string, string>): string
{
    return pattern.split('/').map((segment) =>
    {
        if (!segment.startsWith(':'))
        {
            return segment;
        }
        const name = segment.slice(1);
        const value = params[name];
        if (value === undefined || value === '' || value === '.' || value === '..'
            || value.includes('/') || value.includes('\\') || value.includes('\0'))
        {
            throw new Error(`kit prerender: "${ pattern }" staticParams gave no usable value for ":${ name }" - `
                + `got ${ JSON.stringify(value) }; each set must map every param to a non-empty single segment.`);
        }
        return value;
    }).join('/');
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

    // Every file this pass touches, with whatever was there before, so a failure can undo it.
    // A half-generated page set is the one failure mode that LOOKS like a working build: the
    // exit code says no, but a deploy joined with `;` (or a Dockerfile's next RUN) ships
    // whatever landed on disk. For a static-only target - dist/ rsynced to a CDN, with no
    // renderer to fall through to - that is a live site missing most of its pages.
    //
    // `previous` is null for a file this pass CREATED and the prior bytes for one it
    // OVERWROTE. The root page overwrites vite's own index.html, so a rollback that only
    // deleted would strip the client shell and leave the site with no homepage at all.
    // In a normal build dist/ is fresh from vite, so exactly one file carries prior content.
    const emitted: Array<{ file: string; previous: string | null }> = [];

    async function renderAndWrite(path: string): Promise<void>
    {
        const result = await options.renderer(path, shell);
        if (result.kind === 'redirect')
        {
            throw new Error(`kit prerender: "${ path }" redirected to "${ result.to }" during prerender - `
                + 'a static page cannot redirect; drop the guard or use render: \'server\'.');
        }
        // A static page that a guard blocks (or that doesn't match) cannot be a prerendered
        // file - both are contradictions someone should hear about at build time.
        if (result.kind === 'blocked')
        {
            throw new Error(`kit prerender: "${ path }" was blocked by a guard (status ${ result.status }) during prerender - `
                + 'a static page cannot be guarded; drop the guard or use render: \'server\'.');
        }
        // Prerender never asks for streaming; anything but finished markup here is a
        // renderer bug worth a loud build failure, not a written file of garbage.
        if (result.kind !== 'html')
        {
            throw new Error(`kit prerender: "${ path }" produced a "${ result.kind }" result during prerender - `
                + 'the build renders buffered HTML only.');
        }
        if (result.status === 404)
        {
            throw new Error(`kit prerender: "${ path }" did not match any route during prerender - `
                + 'remove it from the static set or fix the route table.');
        }
        const file = resolve(options.clientDir, prerenderFileFor(path));
        const root = resolve(options.clientDir);
        if (!file.startsWith(root.endsWith(sep) ? root : `${ root }${ sep }`))
        {
            throw new Error(`kit prerender: "${ path }" resolves to ${ file }, outside the client dir - `
                + 'a page path cannot contain \'..\'; fix the route table.');
        }
        mkdirSync(dirname(file), { recursive: true });
        emitted.push({ file, previous: existsSync(file) ? readFileSync(file, 'utf8') : null });
        writeFileSync(file, result.html);
    }

    const written: string[] = [];
    try
    {
        await generate(options, renderAndWrite, written);
    }
    catch (failure)
    {
        // Undo this pass, leaving the client build exactly as vite left it. The next
        // successful build regenerates every page; nothing half-generated ships.
        for (const entry of emitted)
        {
            if (entry.previous === null)
            {
                rmSync(entry.file, { force: true });
            }
            else
            {
                writeFileSync(entry.file, entry.previous);
            }
        }
        throw failure;
    }
    return written;
}

/** @internal The page walk itself; `prerender` wraps it so a throw can roll back what it wrote. */
async function generate(
    options: PrerenderOptions,
    renderAndWrite: (path: string) => Promise<void>,
    written: string[]
): Promise<void>
{
    for (const page of flattenPages(options.routes))
    {
        if (page.render !== 'static')
        {
            continue;
        }
        const parameterized = page.path.includes(':') || page.path.includes('*');
        if (!parameterized && page.staticParams !== undefined)
        {
            throw new Error(`kit prerender: "${ page.path }" declares staticParams but has no parameters - `
                + 'remove staticParams or parameterize the path.');
        }
        if (parameterized)
        {
            // A parameterized ISR page with no enumeration has nothing to prerender -
            // the runtime cache fills per request; the build skips it silently.
            if (page.revalidate !== undefined && page.staticParams === undefined)
            {
                continue;
            }
            if (page.path.includes('*'))
            {
                throw new Error(`kit prerender: "${ page.path }" is render: 'static' but contains a wildcard - `
                    + 'a wildcard cannot be enumerated; use render: \'server\'.');
            }
            if (page.staticParams === undefined)
            {
                throw new Error(`kit prerender: "${ page.path }" is render: 'static' but has parameters - `
                    + 'declare staticParams to enumerate the pages, or use render: \'server\'.');
            }
            const seen = new Set<string>();
            for (const params of await page.staticParams())
            {
                const resolved = resolveStaticPath(page.path, params);
                if (seen.has(resolved))
                {
                    continue;
                }
                seen.add(resolved);
                await renderAndWrite(resolved);
                written.push(resolved);
            }
            continue;
        }
        await renderAndWrite(page.path);
        written.push(page.path);
    }
}
