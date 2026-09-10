// @vitest-environment node
//
// The language of a served page, decided end to end over a real mountPages server.
//
// The gap this closes: the built shell carries ONE `<html lang="en">` and it was emitted verbatim
// for every request, so a bilingual site served its Persian pages labelled English with no `dir`
// at all - laid out left-to-right for the reader and mislabelled for the crawler. The language is
// now negotiated per request by the host, which is the only thing that can see the cookie and the
// headers, and pinned for the render so the markup and its label are decided together.
import { describe, it, expect, afterAll } from 'vitest';
import { RouterProvider, Routes, Suspense, createMemoryHistory, createResource, createRouter, h, useLocale } from 'azerothjs';
import type { LoaderHandoff } from 'azerothjs';
import { resetHead } from 'azerothjs/internal';
import { App } from '@azerothjs/http';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHELL = '<!doctype html><html lang="en" data-keep="1"><head><title>Shell</title></head>'
    + '<body><div id="root"></div></body></html>';

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

function serve(routes: PageRoute[], locales?: { supported: readonly string[]; default?: string; cookie?: string }): App
{
    const dir = mkdtempSync(join(tmpdir(), 'az-locale-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    dirs.push(dir);
    const app = (props: { url?: string; handoff?: LoaderHandoff }): HTMLElement => RouterProvider({
        router: createRouter({
            routes,
            history: createMemoryHistory(props.url ?? '/'),
            initialLoaderData: props.handoff
        }),
        children: () => Routes({ fallback: () => h('h1', {}, 'not found') })
    }) as HTMLElement;
    const server = new App();
    mountPages(server, {
        routes,
        clientDir: dir,
        renderer: createPageRenderer(app, routes),
        ...(locales !== undefined ? { locales } : {})
    });
    return server;
}

/** Asks for the locale from INSIDE a streamed boundary, where the main pass's pin is gone. */
const LateChild = (props: { text: () => string }): HTMLElement =>
{
    const locale = useLocale();
    return h('p', { id: 'late-locale' }, () => locale() + ':' + props.text());
};

/** Reports the locale the RENDER saw, so the markup and the label can be compared. */
const Page = (): HTMLElement =>
{
    const locale = useLocale();
    return h('main', {}, h('p', { id: 'seen' }, locale()));
};

const openTag = (html: string): string => /<html[^>]*>/i.exec(html)?.[0] ?? '';

async function get(server: App, path: string, headers: Record<string, string> = {}): Promise<string>
{
    const response = await server.handle(new Request(`http://local${ path }`, { headers }));
    return response.text();
}

describe('the language of a served page', () =>
{
    it('is left alone when the site declares no locales', async () =>
    {
        resetHead();
        const html = await get(serve([{ path: '/', component: Page, render: 'server' }]),
            '/', { 'accept-language': 'fa' });
        // The single-language site is the control: nothing negotiated, the shell stands.
        expect(openTag(html)).toBe('<html lang="en" data-keep="1">');
    });

    it('is negotiated from Accept-Language and carries its direction', async () =>
    {
        resetHead();
        const server = serve([{ path: '/', component: Page, render: 'server' }], { supported: ['en', 'fa'] });
        const html = await get(server, '/', { 'accept-language': 'fa-IR,fa;q=0.9,en;q=0.5' });
        expect(openTag(html)).toContain('lang="fa"');
        expect(openTag(html)).toContain('dir="rtl"');
        // The shell's other attributes survive the rewrite.
        expect(openTag(html)).toContain('data-keep="1"');
        // And the RENDER saw the same language the document is labelled with - the two being
        // decided separately is the whole class of bug this prevents.
        expect(html).toContain('<p id="seen">fa</p>');
    });

    it('serves the reader\'s first choice, not one they merely tolerate', async () =>
    {
        resetHead();
        const server = serve([{ path: '/', component: Page, render: 'server' }], { supported: ['en', 'fa'] });
        const html = await get(server, '/', { 'accept-language': 'en-US,fa;q=0.9' });
        expect(openTag(html)).toContain('lang="en"');
        expect(openTag(html)).toContain('dir="ltr"');
    });

    it('lets a reader\'s own choice outrank their browser\'s guess', async () =>
    {
        resetHead();
        const server = serve([{ path: '/', component: Page, render: 'server' }], { supported: ['en', 'fa'] });
        const html = await get(server, '/', { 'accept-language': 'en', cookie: 'locale=fa' });
        expect(openTag(html)).toContain('lang="fa"');
        expect(html).toContain('<p id="seen">fa</p>');
    });

    it('resolves the cookie rather than trusting it - it is reader-supplied text', async () =>
    {
        resetHead();
        const server = serve([{ path: '/', component: Page, render: 'server' }], { supported: ['en', 'fa'] });
        const html = await get(server, '/', { cookie: 'locale="><script>alert(1)</script>' });
        // Falls back, and nothing of the payload reaches the document element.
        expect(openTag(html)).toBe('<html lang="en" dir="ltr" data-keep="1">');
        expect(html).not.toContain('alert(1)');
    });

    it('labels a CLIENT-rendered page too, where no render exists to carry it', async () =>
    {
        resetHead();
        const dir = mkdtempSync(join(tmpdir(), 'az-locale-'));
        writeFileSync(join(dir, 'index.html'), SHELL);
        mkdirSync(join(dir, 'assets'));
        dirs.push(dir);
        const routes: PageRoute[] = [{ path: '/', component: Page, render: 'client' }];
        const server = new App();
        // No renderer at all: the shell IS the served document, and it still has a language.
        mountPages(server, { routes, clientDir: dir, locales: { supported: ['en', 'fa'] } });
        const html = await get(server, '/', { 'accept-language': 'fa' });
        expect(openTag(html)).toContain('lang="fa"');
        expect(openTag(html)).toContain('dir="rtl"');
    });

    it('keeps a STREAMED page in one language, boundaries included', async () =>
    {
        resetHead();
        let release!: (value: string) => void;
        const pending = new Promise<string>((resolve) =>
        {
            release = resolve;
        });
        const Streamed = (): HTMLElement =>
        {
            const locale = useLocale();
            const late = createResource<string>(() => pending);
            return h('main', {},
                h('p', { id: 'shell-locale' }, locale()),
                Suspense({
                    fallback: () => h('p', {}, 'wait'),
                    on: [late],
                    // The child asks for the locale ITSELF, inside the continuation. That is
                    // the case the pin has to cover: a continuation renders long after the
                    // call that started the stream returned, so a locale scoped to that call
                    // has unwound by the time this runs, and the deferred half would answer in
                    // the default language while the half above it speaks the reader's.
                    children: (): HTMLElement => LateChild({ text: () => late.data() ?? '' })
                }));
        };
        const server = serve([{ path: '/', component: Streamed, render: 'stream' }], { supported: ['en', 'fa'] });
        const response = await server.handle(new Request('http://local/', { headers: { 'accept-language': 'fa' } }));
        release('late');
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let out = '';
        for (;;)
        {
            const { done, value } = await reader.read();
            if (done)
            {
                break;
            }
            out += decoder.decode(value, { stream: true });
        }
        expect(openTag(out)).toContain('lang="fa"');
        expect(out).toContain('<p id="shell-locale">fa</p>');
        // The positive control: the continuation really did render.
        expect(out).toContain('late');
        expect(out).toContain('fa:late');
        expect(out).not.toContain('en:late');
    });
});

describe('the base stamp on a site with no locales', () =>
{
    function serveShell(shell: string): App
    {
        resetHead();
        const dir = mkdtempSync(join(tmpdir(), 'az-locale-'));
        writeFileSync(join(dir, 'index.html'), shell);
        mkdirSync(join(dir, 'assets'));
        dirs.push(dir);
        const routes: PageRoute[] = [
            { path: '/', component: Page, render: 'server' },
            { path: '/client', component: Page, render: 'client' }
        ];
        const server = new App();
        mountPages(server, { routes, clientDir: dir, renderer: createPageRenderer((props) => app(routes, props), routes) });
        return server;
    }
    const app = (routes: PageRoute[], props: { url?: string; handoff?: LoaderHandoff }): HTMLElement => RouterProvider({
        router: createRouter({ routes, history: createMemoryHistory(props.url ?? '/'), initialLoaderData: props.handoff }),
        children: () => Routes({ fallback: () => h('h1', {}, 'not found') })
    }) as HTMLElement;

    it('strips a stale stamp and leaves the shell\'s own lang alone, on the render and on the bare shell', async () =>
    {
        const server = serveShell('<!doctype html><html lang="en" data-azeroth-base="/de"><head><title>t</title></head><body><div id="root"></div></body></html>');
        expect(openTag(await get(server, '/'))).toBe('<html lang="en">');
        expect(openTag(await get(server, '/client'))).toBe('<html lang="en">');
    });

    it('serves a shell with nothing to strip byte for byte', async () =>
    {
        const server = serveShell('<!doctype html><html lang="en" ><head><title>t</title></head><body><div id="root"></div></body></html>');
        expect(openTag(await get(server, '/'))).toBe('<html lang="en" >');
        expect(openTag(await get(server, '/client'))).toBe('<html lang="en" >');
    });
});
