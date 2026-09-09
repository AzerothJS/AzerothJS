// @vitest-environment node
//
// Caching a page whose language is negotiated.
//
// An ISR entry is keyed by URL, which was complete while a URL meant one document. Negotiation
// breaks that assumption: the same URL is a different document per reader, so a key that ignores
// the language serves the first reader's language to everyone who follows.
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

function serve(routes: PageRoute[]): App
{
    const dir = mkdtempSync(join(tmpdir(), 'az-lcache-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    dirs.push(dir);
    const server = new App();
    mountPages(server, {
        routes,
        clientDir: dir,
        renderer: createPageRenderer(() => Page(), routes),
        locales: { supported: ['en', 'fa'] }
    });
    return server;
}

async function languageOf(server: App, accept: string): Promise<{ lang: string; seen: string; vary: string | null }>
{
    const response = await server.handle(new Request('http://local/doc', { headers: { 'accept-language': accept } }));
    const html = await response.text();
    return {
        lang: /<html[^>]*\blang="([^"]*)"/.exec(html)?.[1] ?? '',
        seen: /<p id="seen">(?:<!--\[-->)?([^<]*)/.exec(html)?.[1] ?? '',
        vary: response.headers.get('vary')
    };
}

describe('a cached page whose language is negotiated', () =>
{
    it('does not serve one reader\'s language to the next', async () =>
    {
        resetHead();
        const server = serve([{ path: '/doc', component: Page, render: 'static', revalidate: 60 }]);

        // Persian reader first, so the entry that exists is the Persian one.
        const persian = await languageOf(server, 'fa');
        expect(persian.lang).toBe('fa');
        expect(persian.seen).toBe('fa');

        // The English reader must not be handed it. Without a language in the key this is the
        // Persian document, at 200, with `lang="fa"` - a wrong-language page for every reader
        // after the first until the entry expires.
        const english = await languageOf(server, 'en');
        expect(english.lang).toBe('en');
        expect(english.seen).toBe('en');

        // And the Persian reader still gets Persian afterwards: two entries, not one that
        // flip-flops, which a key that merely busted on change would also produce.
        expect((await languageOf(server, 'fa')).lang).toBe('fa');
    });

    it('tells shared caches that the language varies the response', async () =>
    {
        resetHead();
        const server = serve([{ path: '/doc', component: Page, render: 'static', revalidate: 60 }]);
        const { vary } = await languageOf(server, 'fa');
        // Without this a CDN in front of the app repeats the mistake the key just fixed, and
        // does it for every reader at once.
        expect(vary ?? '').toMatch(/accept-language/i);
    });

    it('varies a plain server-rendered page too, since a CDN may still cache it', async () =>
    {
        resetHead();
        const server = serve([{ path: '/doc', component: Page, render: 'server' }]);
        const { vary, lang } = await languageOf(server, 'fa');
        expect(lang).toBe('fa');
        expect(vary ?? '').toMatch(/accept-language/i);
    });

    it('says nothing about language on a site that declares no locales', async () =>
    {
        resetHead();
        const dir = mkdtempSync(join(tmpdir(), 'az-lcache-'));
        writeFileSync(join(dir, 'index.html'), SHELL);
        mkdirSync(join(dir, 'assets'));
        dirs.push(dir);
        const routes: PageRoute[] = [{ path: '/doc', component: Page, render: 'server' }];
        const server = new App();
        mountPages(server, { routes, clientDir: dir, renderer: createPageRenderer(() => Page(), routes) });
        const response = await server.handle(new Request('http://local/doc'));
        await response.text();
        // The control: a single-language site gains no header and no cache fragmentation.
        expect(response.headers.get('vary') ?? '').not.toMatch(/accept-language/i);
    });
});

describe('what a negotiated page tells a shared cache it varies on', () =>
{
    // Every source that CAN decide, not the one that did. A cache matches a stored response on
    // the fields THAT response named (RFC 9111 4.1), so a page stamped only with the header is
    // replayed to a reader whose cookie chose another language. The strings are exact, so a
    // later loosening cannot drop the cookie half this rule exists to add.
    const routes: PageRoute[] = [{ path: '/doc', component: Page, render: 'server' }];
    async function varyOf(locales: Parameters<typeof mountPages>[1]['locales']): Promise<string | null>
    {
        resetHead();
        const dir = mkdtempSync(join(tmpdir(), 'az-lvary-'));
        writeFileSync(join(dir, 'index.html'), SHELL);
        mkdirSync(join(dir, 'assets'));
        dirs.push(dir);
        const server = new App();
        mountPages(server, {
            routes, clientDir: dir, renderer: createPageRenderer(() => Page(), routes),
            ...(locales === undefined ? {} : { locales })
        });
        const response = await server.handle(new Request('http://local/doc', { headers: { 'accept-language': 'en' } }));
        await response.text();
        return response.headers.get('vary');
    }

    it('names the header AND the cookie for a reader who has not chosen, so their copy is never replayed to one who has', async () =>
    {
        expect(await varyOf({ supported: ['en', 'fa'] })).toBe('accept-language, cookie');
    });

    it('names only the sources that are on', async () =>
    {
        expect(await varyOf({ supported: ['en', 'fa'], cookie: false })).toBe('accept-language');
        expect(await varyOf({ supported: ['en', 'fa'], acceptLanguage: false })).toBe('cookie');
    });

    it('names nothing when nothing can vary', async () =>
    {
        // Both sources off: every reader gets the default.
        expect(await varyOf({ supported: ['en', 'fa'], cookie: false, acceptLanguage: false })).toBeNull();
        // One published language: one body for everyone, and a field would only fragment a
        // shared cache for a distinction that does not exist.
        expect(await varyOf({ supported: ['fa'] })).toBeNull();
    });
});
