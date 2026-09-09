// @vitest-environment node
//
// A STATIC site in more than one language.
//
// Negotiation at request time is not available to a static host - there is no request-time code
// to negotiate with - so a multilingual static build has to produce a real artifact per language.
// The build writes them side by side and the mount serves the reader's own; the unsuffixed file
// is still written, because it is what a host with no negotiation serves and what replaces vite's
// index.html at the root.
import { describe, it, expect, afterAll } from 'vitest';
import { h, useLocale } from 'azerothjs';
import { resetHead } from 'azerothjs/internal';
import { App } from '@azerothjs/http';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import { prerender } from '@azerothjs/kit/prerender';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHELL = '<!doctype html><html lang="en"><head><title>Shell</title></head>'
    + '<body><div id="root"></div></body></html>';

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

const Page = (): HTMLElement =>
{
    const locale = useLocale();
    return h('main', {}, h('p', { id: 'seen' }, locale()));
};

const routes: PageRoute[] = [
    { path: '/', component: Page, render: 'static' },
    { path: '/about', component: Page, render: 'static' }
];

function clientDir(): string
{
    const dir = mkdtempSync(join(tmpdir(), 'az-lstatic-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    dirs.push(dir);
    return dir;
}

describe('a static site in more than one language', () =>
{
    it('writes one file per language, beside the unsuffixed one', async () =>
    {
        resetHead();
        const dir = clientDir();
        await prerender({
            routes,
            clientDir: dir,
            renderer: createPageRenderer(() => Page(), routes),
            locales: ['en', 'fa']
        });

        expect(existsSync(join(dir, 'about', 'index.html'))).toBe(true);
        expect(existsSync(join(dir, 'about', 'index.en.html'))).toBe(true);
        expect(existsSync(join(dir, 'about', 'index.fa.html'))).toBe(true);

        // Each carries its own language, in the markup AND on the document element.
        const persian = readFileSync(join(dir, 'about', 'index.fa.html'), 'utf8');
        expect(persian).toContain('lang="fa"');
        expect(persian).toContain('dir="rtl"');
        expect(persian).toContain('>fa</p>');

        const english = readFileSync(join(dir, 'about', 'index.en.html'), 'utf8');
        expect(english).toContain('lang="en"');
        expect(english).toContain('>en</p>');
    });

    it('serves the reader their own file', async () =>
    {
        resetHead();
        const dir = clientDir();
        await prerender({
            routes,
            clientDir: dir,
            renderer: createPageRenderer(() => Page(), routes),
            locales: ['en', 'fa']
        });

        const server = new App();
        mountPages(server, { routes, clientDir: dir, locales: { supported: ['en', 'fa'] } });

        const persian = await server.handle(new Request('http://local/about', { headers: { 'accept-language': 'fa' } }));
        const persianHtml = await persian.text();
        expect(persian.status).toBe(200);
        expect(persianHtml).toContain('lang="fa"');
        expect(persianHtml).toContain('>fa</p>');

        const english = await server.handle(new Request('http://local/about', { headers: { 'accept-language': 'en' } }));
        const englishHtml = await english.text();
        expect(englishHtml).toContain('lang="en"');
        expect(englishHtml).toContain('>en</p>');
        // The discriminating pair: one build, two readers, two documents. Serving one file to
        // both is exactly the failure a static multilingual site otherwise has.
        expect(englishHtml).not.toContain('>fa</p>');
    });

    it('falls back to the unsuffixed file when a build predates the locale config', async () =>
    {
        resetHead();
        const dir = clientDir();
        // A single-language build: only the unsuffixed files exist.
        await prerender({ routes, clientDir: dir, renderer: createPageRenderer(() => Page(), routes) });
        expect(existsSync(join(dir, 'about', 'index.fa.html'))).toBe(false);

        const server = new App();
        mountPages(server, { routes, clientDir: dir, locales: { supported: ['en', 'fa'] } });
        const response = await server.handle(new Request('http://local/about', { headers: { 'accept-language': 'fa' } }));
        // Serves rather than 404s: a missing translation of a page is not a missing page.
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('id="seen"');
    });

    it('leaves a single-language build byte-identical', async () =>
    {
        resetHead();
        const one = clientDir();
        await prerender({ routes, clientDir: one, renderer: createPageRenderer(() => Page(), routes) });
        const files = ['index.html', join('about', 'index.html')];
        for (const file of files)
        {
            expect(existsSync(join(one, file)), file).toBe(true);
        }
        // No stray language files, so nothing about the layout changed for a site with one.
        expect(existsSync(join(one, 'about', 'index.en.html'))).toBe(false);
    });
});

describe('an enumerated static page tells a shared cache what it varies on', () =>
{
    // The handler for a parameterised static route has two file returns, and neither was
    // stamped: a shared cache was told it MAY store the page and told nothing about the
    // language that chose its bytes, so one reader's language went to everyone after them.
    // The arm is pinned to the FILE branch - it runs the prerender pass and proves the served
    // body is the artifact - because the live-render fall-through was always stamped, and an
    // arm that merely asks twice passes on the unfixed handler whenever the file is absent.
    const posts: PageRoute[] = [
        { path: '/post/:slug', component: Page, render: 'static', staticParams: () => Promise.resolve([{ slug: 'hello' }]) }
    ];
    // Written INTO the artifacts after the build, so a served body carrying it came from the
    // file and one without it came from the live render - a discriminator that owes nothing to
    // the handoff's shape.
    const marker = '<!--artifact-->';
    function stampArtifacts(dir: string, files: string[]): void
    {
        for (const file of files)
        {
            appendFileSync(join(dir, file), marker);
        }
    }

    async function served(dir: string, path: string, accept: string): Promise<{ response: Response; html: string }>
    {
        const server = new App();
        mountPages(server, { routes: posts, clientDir: dir, renderer: createPageRenderer(() => Page(), posts), locales: { supported: ['en', 'fa'] } });
        const response = await server.handle(new Request(`http://local${ path }`, { headers: { 'accept-language': accept } }));
        return { response, html: await response.text() };
    }

    it('on the prerendered artifact, in every language, and on the fall-through beside it', async () =>
    {
        resetHead();
        const dir = clientDir();
        await prerender({ routes: posts, clientDir: dir, renderer: createPageRenderer(() => Page(), posts), locales: ['en', 'fa'] });
        expect(existsSync(join(dir, 'post', 'hello', 'index.fa.html'))).toBe(true);
        stampArtifacts(dir, [join('post', 'hello', 'index.en.html'), join('post', 'hello', 'index.fa.html')]);

        const persian = await served(dir, '/post/hello', 'fa');
        // The artifact, not a live render: the file's own lang, and the marker only a file has.
        expect(persian.html).toContain('lang="fa"');
        expect(persian.html).toContain(marker);
        expect(persian.response.headers.get('vary')).toBe('accept-language, cookie');

        const english = await served(dir, '/post/hello', 'en');
        expect(english.html).toContain('lang="en"');
        expect(english.html).toContain(marker);
        expect(english.response.headers.get('vary')).toBe('accept-language, cookie');

        // A param the enumeration did not list falls through to the live render: the control.
        const live = await served(dir, '/post/unlisted', 'fa');
        expect(live.html).not.toContain(marker);
        expect(live.response.headers.get('vary')).toBe('accept-language, cookie');
    });

    it('on the unsuffixed fallback too, which is the live path for every missing translation', async () =>
    {
        resetHead();
        const dir = clientDir();
        // A build that predates the locale config: only the unsuffixed artifact exists.
        await prerender({ routes: posts, clientDir: dir, renderer: createPageRenderer(() => Page(), posts) });
        expect(existsSync(join(dir, 'post', 'hello', 'index.fa.html'))).toBe(false);
        stampArtifacts(dir, [join('post', 'hello', 'index.html')]);

        const { response, html } = await served(dir, '/post/hello', 'fa');
        expect(response.status).toBe(200);
        expect(html).toContain(marker);
        expect(response.headers.get('vary')).toBe('accept-language, cookie');
    });
});

describe('two languages of one page never share a validator', () =>
{
    // One prerender pass writes both language files at one length, a millisecond apart, and a
    // reproducible build makes their mtimes identical - so a validator from size and mtime
    // alone collided, and a reader who chose Persian revalidating with the English tag got a
    // 304 that kept the English document. The fix under test lives in static file serving, so
    // BOTH negotiated static shapes are asserted: an arm over one of them passes a fix scoped
    // to the other.
    const plain: PageRoute[] = [{ path: '/about', component: Page, render: 'static' }];
    const enumerated: PageRoute[] = [
        { path: '/post/:slug', component: Page, render: 'static', staticParams: () => Promise.resolve([{ slug: 'hello' }]) }
    ];

    async function collide(routes: PageRoute[], files: [string, string]): Promise<App>
    {
        resetHead();
        const dir = clientDir();
        await prerender({ routes, clientDir: dir, renderer: createPageRenderer(() => Page(), routes), locales: ['en', 'fa'] });
        // Force the collision the build only makes likely: one mtime, and one size by
        // construction (the page prints the two-letter tag).
        const when = new Date('2026-01-01T00:00:00Z');
        for (const file of files)
        {
            utimesSync(join(dir, file), when, when);
        }
        const [a, b] = files.map((file) => readFileSync(join(dir, file)).length);
        expect(a).toBe(b);
        const server = new App();
        mountPages(server, { routes, clientDir: dir, renderer: createPageRenderer(() => Page(), routes), locales: { supported: ['en', 'fa'] } });
        return server;
    }

    for (const [label, routes, path, files] of [
        ['a plain static page', plain, '/about', [join('about', 'index.en.html'), join('about', 'index.fa.html')]],
        ['an enumerated static page', enumerated, '/post/hello', [join('post', 'hello', 'index.en.html'), join('post', 'hello', 'index.fa.html')]]
    ] as const)
    {
        it(`${ label }: distinct tags, a foreign tag is a 200, the own tag is a 304 that names it`, async () =>
        {
            const server = await collide(routes, [...files]);
            const get = (accept: string, headers: Record<string, string> = {}): Promise<Response> =>
                server.handle(new Request(`http://local${ path }`, { headers: { 'accept-language': accept, ...headers } }));

            const english = await get('en');
            const persian = await get('fa');
            const englishTag = english.headers.get('etag');
            const persianTag = persian.headers.get('etag');
            expect(englishTag).not.toBeNull();
            expect(englishTag).not.toBe(persianTag);

            // A Persian reader revalidating with the English validator must get Persian bytes.
            const crossed = await get('fa', { 'if-none-match': englishTag as string });
            expect(crossed.status).toBe(200);
            expect(await crossed.text()).toContain('lang="fa"');

            // And revalidation still WORKS: the same representation's own tag is a 304 that
            // carries the tag it matched - and the same Vary its 200 carried.
            const own = await get('fa', { 'if-none-match': persianTag as string });
            expect(own.status).toBe(304);
            expect(own.headers.get('etag')).toBe(persianTag);
            expect(own.headers.get('vary')).toBe(persian.headers.get('vary'));
        });
    }
});

// An ENUMERATED static page under prefix routing names its file per request. The name comes
// from the raw remainder decoded one segment at a time, never from the re-joined matched path,
// so a param carrying an encoded separator can never name a sibling page's file.
describe('an enumerated static page under prefix routing serves its own file', () =>
{
    const enumerated: PageRoute[] = [
        { path: '/', component: Page, render: 'static' },
        { path: '/docs/:slug', component: Page, render: 'static', staticParams: () => Promise.resolve([{ slug: 'intro' }]) },
        { path: '/post/:slug', component: Page, render: 'static', staticParams: () => Promise.resolve([{ slug: 'hello' }]) }
    ];

    async function build(): Promise<{ dir: string; server: App }>
    {
        resetHead();
        const dir = clientDir();
        await prerender({
            routes: enumerated,
            clientDir: dir,
            renderer: createPageRenderer(() => Page(), enumerated),
            locales: ['en', 'fa'],
            routing: 'prefix'
        });
        // Markers pin which FILE answered; a live render carries none.
        appendFileSync(join(dir, 'docs', 'intro', 'index.fa.html'), '<!--file:docs/intro/fa-->');
        appendFileSync(join(dir, 'docs', 'intro', 'index.html'), '<!--file:docs/intro/plain-->');
        // A sibling page's file the enumeration never listed, and a nested one a re-joined
        // `%2F` would land on.
        mkdirSync(join(dir, 'docs', 'private'), { recursive: true });
        writeFileSync(join(dir, 'docs', 'private', 'index.fa.html'), '<html><body><!--file:docs/private/fa--></body></html>');
        mkdirSync(join(dir, 'post', 'a', 'b'), { recursive: true });
        writeFileSync(join(dir, 'post', 'a', 'b', 'index.fa.html'), '<html><body><!--file:post/a/b/fa--></body></html>');
        const server = new App();
        mountPages(server, {
            routes: enumerated,
            clientDir: dir,
            renderer: createPageRenderer(() => Page(), enumerated),
            locales: { supported: ['en', 'fa'], routing: 'prefix' }
        });
        return { dir, server };
    }

    const get = (server: App, path: string, headers: Record<string, string> = {}): Promise<Response> =>
        server.handle(new Request(`http://local${ path }`, { headers: { accept: 'text/html', ...headers } }));

    it('serves the language file with an etag, a 304, and with a trailing slash too', async () =>
    {
        const { server } = await build();
        const first = await get(server, '/fa/docs/intro');
        const html = await first.text();
        expect(first.status).toBe(200);
        expect(html).toContain('<!--file:docs/intro/fa-->');
        expect(html).toContain('lang="fa"');
        const etag = first.headers.get('etag');
        expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+-[0-9a-f]{8}"$/);
        expect((await get(server, '/fa/docs/intro', { 'if-none-match': etag as string })).status).toBe(304);
        expect(await (await get(server, '/fa/docs/intro/')).text()).toContain('<!--file:docs/intro/fa-->');
        expect(await (await get(server, '/%66a/docs/intro')).text()).toContain('<!--file:docs/intro/fa-->');
    });

    it('the artifact carries the hreflang set as root-relative hrefs', async () =>
    {
        const { dir, server } = await build();
        const file = readFileSync(join(dir, 'docs', 'intro', 'index.fa.html'), 'utf8');
        const hrefs = [...file.matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)].map((m) => `${ m[1] }=${ m[2] }`);
        expect(hrefs).toEqual(['en=/en/docs/intro', 'fa=/fa/docs/intro', 'x-default=/docs/intro']);
        expect(await (await get(server, '/fa/docs/intro')).text()).toContain('hreflang="fa" href="/fa/docs/intro"');
    });

    it('falls back to the unsuffixed file when the language file is absent', async () =>
    {
        const { dir, server } = await build();
        rmSync(join(dir, 'docs', 'intro', 'index.fa.html'));
        expect(await (await get(server, '/fa/docs/intro')).text()).toContain('<!--file:docs/intro/plain-->');
    });

    it('an encoded separator in a param never names a sibling page: the page live-renders', async () =>
    {
        const { server } = await build();
        const control = await (await get(server, '/fa/docs/private')).text();
        expect(control).toContain('<!--file:docs/private/fa-->');
        const smuggled = await (await get(server, '/fa/docs/%2Fprivate')).text();
        expect(smuggled).not.toContain('<!--file:');
        expect(smuggled).toContain('lang="fa"');
        const nested = await (await get(server, '/fa/post/a%2Fb')).text();
        expect(nested).not.toContain('<!--file:');
    });
});

describe('the prerender pass writes hreflang only under prefix routing', () =>
{
    it('a negotiate build and a single-language build carry no hreflang link', async () =>
    {
        resetHead();
        const dir = clientDir();
        await prerender({ routes, clientDir: dir, renderer: createPageRenderer(() => Page(), routes), locales: ['en', 'fa'] });
        expect(readFileSync(join(dir, 'about', 'index.fa.html'), 'utf8')).not.toContain('hreflang');
        const single = clientDir();
        await prerender({ routes, clientDir: single, renderer: createPageRenderer(() => Page(), routes), routing: 'prefix' });
        expect(readFileSync(join(single, 'about', 'index.html'), 'utf8')).not.toContain('hreflang');
    });

    it('a prefix build writes the set into every file, the unsuffixed one included', async () =>
    {
        resetHead();
        const dir = clientDir();
        await prerender({ routes, clientDir: dir, renderer: createPageRenderer(() => Page(), routes), locales: ['en', 'fa'], routing: 'prefix' });
        for (const name of ['index.html', 'index.en.html', 'index.fa.html'])
        {
            const file = readFileSync(join(dir, 'about', name), 'utf8');
            expect(file).toContain('hreflang="en" href="/en/about"');
            expect(file).toContain('hreflang="fa" href="/fa/about"');
            expect(file).toContain('hreflang="x-default" href="/about"');
        }
        expect(readFileSync(join(dir, 'index.fa.html'), 'utf8')).toContain('hreflang="fa" href="/fa"');
    });
});
