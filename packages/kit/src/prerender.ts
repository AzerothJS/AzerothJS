/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The build-time static pass.
 *
 * Renders every `render: 'static'` page through the SSR bundle's renderer and
 * writes it into the client dist, after preserving the pristine SPA shell as
 * `shell.html` (what `mountPages` serves for `render: 'client'` pages and what
 * static pages splice over). A GUARD anywhere on a static page's chain is a BUILD
 * error - declaration-based, verdict irrespective: a prerendered file is served without
 * ever running guards, so even a guard that passes at build time is a contradiction
 * someone should hear about, and so is a static page that redirects.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { setBuildContext } from 'azerothjs/internal';

import { guardedMatch, isLanguageTag } from 'azerothjs/internal';

import { alternatesOf } from './alternates.ts';
import { flattenPages, prerenderFileFor, type PageRoute } from './index.ts';
import { carriesBaseStamp } from './isr.ts';
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

    /**
     * The languages to build each static page in - the same list `mountPages` publishes.
     *
     * Every page is rendered once per language into its own file, so a static site has a real
     * artifact for each reader instead of one language's copy negotiated at request time (which a
     * static host cannot do at all). Omit for a single-language build, which is unchanged.
     */
    locales?: readonly string[];

    /**
     * The url mode the site is mounted in. Under `'prefix'` every artifact carries the hreflang
     * set for its languages, as root-relative hrefs; the default carries none, because outside
     * prefix mode there are no per-language urls to name.
     */
    routing?: 'negotiate' | 'prefix';
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
    for (const tag of options.locales ?? [])
    {
        if (!isLanguageTag(tag))
        {
            throw new Error(`kit prerender: "${ tag }" is not a language tag - alphanumeric segments joined by hyphens, `
                + 'such as "en" or "zh-Hant".');
        }
    }
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

    // The same shell-hash identity the runtime mount computes, so build-emitted handoffs
    // and runtime pages agree on the deployment they belong to.
    const buildStamp = createHash('sha256').update(shell).digest('hex').slice(0, 16);

    async function renderAndWrite(path: string, revalidate?: number, locale?: string): Promise<void>
    {
        // A page WITH a revalidation window is ISR: its prerendered seed file is served
        // verbatim later, so it carries `at` and heals by age like any ISR copy. A page
        // WITHOUT one is build-static by contract and adopts fresh forever.
        const alternates = options.routing === 'prefix' ? alternatesOf(options.locales ?? [], path, '') : [];
        // Under prefix routing each language's file lives at its own prefixed url, so it is
        // rendered under that base: stamped for the client router, anchors already prefixed.
        const base = options.routing === 'prefix' && locale !== undefined ? `/${ locale }` : undefined;
        const result = await options.renderer(path, shell, {
            handoffMeta: revalidate !== undefined
                ? { build: buildStamp, at: Date.now() }
                : { build: buildStamp, static: true },
            ...(locale !== undefined ? { locale } : {}),
            ...(base !== undefined ? { base } : {}),
            ...(alternates.length > 0 ? { alternates } : {})
        });
        if (result.kind === 'redirect')
        {
            throw new Error(`kit prerender: "${ path }" redirected to "${ result.to }" during prerender - `
                + 'a static page cannot redirect; drop the guard or use render: \'server\'.');
        }
        if (result.kind === 'refused-redirect')
        {
            throw new Error(`kit prerender: "${ path }" redirected off-origin to "${ result.target }" during `
                + 'prerender - a redirect target that leaves the app\'s origin is refused; redirect to a path, '
                + 'or wrap a deliberate off-origin target in unsafeUrl(...).');
        }
        // A static page that a guard blocks (or that doesn't match) cannot be a prerendered
        // file - both are contradictions someone should hear about at build time.
        if (result.kind === 'blocked')
        {
            throw new Error(`kit prerender: "${ path }" was blocked by a guard (status ${ result.status }) during prerender - `
                + 'a static page cannot be guarded; drop the guard or use render: \'server\'.');
        }
        // A loader that rejected still renders a page - at 500, with that level showing its
        // failure UI. Serving that live is right; WRITING it as a build artifact is not, since
        // the file would outlive the outage and be served as content forever.
        if (result.kind === 'error')
        {
            throw new Error(`kit prerender: "${ path }" could not load its data - a loader rejected during `
                + 'the prerender pass, and a page built from a failed load must not be written. The reason '
                + 'was reported through the render\'s error observer.');
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
        // A renderer that ignored the base would write a file the prefixed mount refuses to serve.
        if (base !== undefined && !carriesBaseStamp(result.html))
        {
            throw new Error(`kit prerender: "${ path }" rendered for "${ base }" carries no data-azeroth-base stamp - `
                + 'the renderer must apply the base it is given (createPageRenderer does).');
        }
        const file = resolve(options.clientDir, prerenderFileFor(path, locale));
        const root = resolve(options.clientDir);
        if (!file.startsWith(root.endsWith(sep) ? root : `${ root }${ sep }`))
        {
            throw new Error(`kit prerender: "${ path }" resolves to ${ file }, outside the client dir - `
                + 'a page path cannot contain \'..\'; fix the route table.');
        }
        mkdirSync(dirname(file), { recursive: true });
        // Read directly and catch the read's own failure rather than asking existsSync first: a
        // separate existence check leaves a window in which the file can be removed or replaced
        // before the read, and "absent" is exactly what the null means here anyway.
        emitted.push({ file, previous: readPrevious(file) });
        writeFileSync(file, result.html);
    }

    const written: string[] = [];
    // Build context: the render entry points latch server mode, and outside any request
    // scope the data cache disables itself - correct at build time, and SILENT (the
    // install-a-request-root diagnostic is server advice, not build advice).
    setBuildContext(true);
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
    finally
    {
        setBuildContext(false);
    }
    return written;
}

/**
 * @internal A file's current contents for the rollback record, or null when there are none.
 *
 * The read IS the existence check. Asking `existsSync` first and reading after describes the file
 * twice and can get two different answers, and every failure mode - absent, unreadable, replaced
 * by a directory - means the same thing to the caller: there is nothing here to restore.
 */
function readPrevious(file: string): string | null
{
    try
    {
        return readFileSync(file, 'utf8');
    }
    catch
    {
        return null;
    }
}

/** @internal The page walk itself; `prerender` wraps it so a throw can roll back what it wrote. */
async function generate(
    options: PrerenderOptions,
    renderAndWrite: (path: string, revalidate?: number, locale?: string) => Promise<void>,
    written: string[]
): Promise<void>
{
    // `undefined` FIRST and always: the unsuffixed file is what a host without negotiation serves,
    // what an older mount looks for, and what replaces vite own index.html at the root - so it is
    // written whether or not the site is multilingual. The language-suffixed copies join it.
    const buildLocales: ReadonlyArray<string | undefined> = [undefined, ...(options.locales ?? [])];

    // A foreign guarded chain can win the url of an unguarded static page, and a file written
    // for it would be served without the guard. The declaration check below is the first line;
    // this is the second, once per resolved path.
    const refuseGuardedUrl = (path: string, pattern: string): void =>
    {
        if (guardedMatch(options.routes, path))
        {
            throw new Error(`kit prerender: "${ path }" (from "${ pattern }") matches a guarded route chain - `
                + 'a prerendered page is served without running guards. Move the guard, or use render: \'server\'.');
        }
    };

    for (const page of flattenPages(options.routes))
    {
        if (page.render !== 'static')
        {
            continue;
        }
        // Declaration-based, not verdict-based: a guard that happens to PASS at build time
        // still owns the route per-request, and a file written here is served without ever
        // running it. The verdict-based checks below (redirect/blocked) stay as the
        // backstop for a renderer whose table differs. The wildcard-without-revalidate
        // shape falls through to its own existing error; mountPages exempts it because it
        // never serves files.
        if (page.guardedBy !== undefined && !(page.path.includes('*') && page.revalidate === undefined))
        {
            throw new Error(`kit prerender: "${ page.path }" is render: 'static' but its route chain is `
                + `guarded at "${ page.guardedBy }" - a prerendered page is served without running guards. `
                + 'Move the guard into a server-rendered subtree, throw redirect() from a loader '
                + '(live-rendered requests only; it never runs for prerendered bytes), or use '
                + 'render: \'server\'.');
        }
        // The same declaration rule, for the same reason: a prerendered file has no request to
        // mint a form token for, so the form it carries cannot submit without JavaScript.
        if (page.action !== undefined && !(page.path.includes('*') && page.revalidate === undefined))
        {
            throw new Error(`kit prerender: "${ page.path }" is render: 'static' but declares an action - `
                + 'a prerendered page carries no per-request token, so its form cannot submit without '
                + 'JavaScript. Use render: \'server\' for a page that receives a form.');
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
                refuseGuardedUrl(resolved, page.path);
                for (const locale of buildLocales)
                {
                    await renderAndWrite(resolved, page.revalidate, locale);
                }
                written.push(resolved);
            }
            continue;
        }
        refuseGuardedUrl(page.path, page.path);
        for (const locale of buildLocales)
        {
            await renderAndWrite(page.path, page.revalidate, locale);
        }
        written.push(page.path);
    }
}
