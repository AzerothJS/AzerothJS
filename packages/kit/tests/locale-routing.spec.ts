// @vitest-environment node
//
// Locale-PREFIXED urls: `/fa/about` beside `/en/about`, with the bare path redirecting.
//
// This is the mode a site with search-engine ambitions needs, and the reason is mechanical rather
// than stylistic: `hreflang` annotates a relationship BETWEEN urls, so it can only say anything
// once each language has its own address. Prefixing also removes the negotiation from the cached
// response entirely - the url names the document, so `Vary` is not needed and a shared cache can
// hold every language at once.
import { describe, it, expect, afterAll } from 'vitest';
import { h, useLocale } from 'azerothjs';
import { resetHead } from 'azerothjs/internal';
import { App } from '@azerothjs/http';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    { path: '/', component: Page, render: 'server' },
    { path: '/about', component: Page, render: 'server' }
];

function serve(routing: 'prefix' | 'negotiate'): App
{
    const dir = mkdtempSync(join(tmpdir(), 'az-lroute-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    dirs.push(dir);
    const server = new App();
    mountPages(server, {
        routes,
        clientDir: dir,
        renderer: createPageRenderer(() => Page(), routes),
        locales: { supported: ['en', 'fa'], routing }
    });
    return server;
}

const seen = (html: string): string => /<p id="seen">(?:<!--\[-->)?([^<]*)/.exec(html)?.[1] ?? '';
const lang = (html: string): string => /<html[^>]*\blang="([^"]*)"/.exec(html)?.[1] ?? '';

describe('locale-prefixed urls', () =>
{
    it('serves each language at its own address, whatever the reader\'s headers say', async () =>
    {
        resetHead();
        const server = serve('prefix');

        // The header says English and the URL says Persian. The URL wins, because it IS the
        // request - anything else would make a shared link mean different things to different
        // people, which is the property the whole mode exists to provide.
        const persian = await server.handle(new Request('http://local/fa/about', {
            headers: { 'accept-language': 'en-US,en;q=0.9' }
        }));
        const persianHtml = await persian.text();
        expect(persian.status).toBe(200);
        expect(lang(persianHtml)).toBe('fa');
        expect(seen(persianHtml)).toBe('fa');

        const english = await server.handle(new Request('http://local/en/about', {
            headers: { 'accept-language': 'fa' }
        }));
        const englishHtml = await english.text();
        expect(lang(englishHtml)).toBe('en');
        expect(seen(englishHtml)).toBe('en');
    });

    it('does not make a prefixed page vary, because the url already says which one it is', async () =>
    {
        resetHead();
        const response = await serve('prefix').handle(new Request('http://local/fa/about'));
        await response.text();
        // A shared cache can hold every language at once. Naming Accept-Language here would
        // fragment the cache for a distinction the url already made.
        expect(response.headers.get('vary') ?? '').not.toMatch(/accept-language/i);
    });

    it('sends the bare path to the reader\'s own language', async () =>
    {
        resetHead();
        const server = serve('prefix');

        const persian = await server.handle(new Request('http://local/about', {
            headers: { 'accept-language': 'fa' }
        }));
        expect(persian.status).toBe(302);
        expect(persian.headers.get('location')).toBe('/fa/about');
        // The target depends on who asked, so it must not be replayed for the next reader.
        expect(persian.headers.get('vary') ?? '').toMatch(/accept-language/i);
        expect(persian.headers.get('cache-control') ?? '').toContain('no-store');

        const english = await server.handle(new Request('http://local/about', {
            headers: { 'accept-language': 'en' }
        }));
        expect(english.headers.get('location')).toBe('/en/about');
    });

    it('redirects the root and keeps the query', async () =>
    {
        resetHead();
        const server = serve('prefix');
        const root = await server.handle(new Request('http://local/', { headers: { 'accept-language': 'fa' } }));
        expect(root.status).toBe(302);
        expect(root.headers.get('location')).toBe('/fa');

        const withQuery = await server.handle(new Request('http://local/about?page=2', {
            headers: { 'accept-language': 'fa' }
        }));
        expect(withQuery.headers.get('location')).toBe('/fa/about?page=2');
    });

    it('lets a reader\'s stored choice decide where the bare path sends them', async () =>
    {
        resetHead();
        const response = await serve('prefix').handle(new Request('http://local/about', {
            headers: { 'accept-language': 'en', cookie: 'locale=fa' }
        }));
        expect(response.headers.get('location')).toBe('/fa/about');
    });

    it('annotates every language, reciprocally, with an x-default', async () =>
    {
        resetHead();
        const html = await (await serve('prefix').handle(new Request('http://local/fa/about'))).text();
        const head = html.slice(0, html.indexOf('</head>'));

        // The WHOLE set on every member, itself included: a crawler learns the group from any one
        // page, and a set that omits self is the most common way hand-built hreflang is wrong.
        expect(head).toContain('hreflang="en" href="http://local/en/about"');
        expect(head).toContain('hreflang="fa" href="http://local/fa/about"');
        expect(head).toContain('hreflang="x-default" href="http://local/about"');
    });

    it('emits NO hreflang when the languages share one url', async () =>
    {
        resetHead();
        const html = await (await serve('negotiate').handle(new Request('http://local/about', {
            headers: { 'accept-language': 'fa' }
        }))).text();
        // The control that keeps the feature honest: annotations that all name one address tell a
        // crawler nothing, and emitting them would look like the page was annotated when it was
        // not. Negotiate mode is still correct - it just carries Vary instead.
        expect(html).not.toContain('hreflang');
        expect(lang(html)).toBe('fa');
    });

    it('leaves a single-language site with plain paths and no redirect', async () =>
    {
        resetHead();
        const dir = mkdtempSync(join(tmpdir(), 'az-lroute-'));
        writeFileSync(join(dir, 'index.html'), SHELL);
        mkdirSync(join(dir, 'assets'));
        dirs.push(dir);
        const server = new App();
        mountPages(server, { routes, clientDir: dir, renderer: createPageRenderer(() => Page(), routes) });
        const response = await server.handle(new Request('http://local/about'));
        expect(response.status).toBe(200);
        expect(await response.text()).not.toContain('hreflang');
    });
});

describe('the bare-path redirect varies on exactly what decided it', () =>
{
    // The redirect's Vary comes from the one rule every negotiated answer uses, not from a
    // literal that would drift from it the moment a source is switched off.
    function redirectVary(locales: NonNullable<Parameters<typeof mountPages>[1]['locales']>): Promise<string | null>
    {
        resetHead();
        const dir = mkdtempSync(join(tmpdir(), 'az-lredir-'));
        writeFileSync(join(dir, 'index.html'), SHELL);
        mkdirSync(join(dir, 'assets'));
        dirs.push(dir);
        const server = new App();
        mountPages(server, { routes, clientDir: dir, renderer: createPageRenderer(() => Page(), routes), locales });
        return server.handle(new Request('http://local/about', { headers: { 'accept-language': 'fa' } }))
            .then((response) => response.headers.get('vary'));
    }

    it('names the header when only the header can decide, and the cookie when only the cookie can', async () =>
    {
        expect(await redirectVary({ supported: ['en', 'fa'], routing: 'prefix', cookie: false })).toBe('accept-language');
        expect(await redirectVary({ supported: ['en', 'fa'], routing: 'prefix', acceptLanguage: false })).toBe('cookie');
    });

    it('names nothing when every first visit goes to the same prefix', async () =>
    {
        expect(await redirectVary({ supported: ['en', 'fa'], routing: 'prefix', cookie: false, acceptLanguage: false })).toBeNull();
    });
});
