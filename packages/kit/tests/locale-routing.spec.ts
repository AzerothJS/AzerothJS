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
import { Link, RouterProvider, Routes, createMemoryHistory, createRouter, forbidden, h, redirect, unsafeUrl, useLocale } from 'azerothjs';
import type { LoaderHandoff } from 'azerothjs';
import { resetHead } from 'azerothjs/internal';
import { App, csrfToken } from '@azerothjs/http';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import type { PageRenderOptions, PageResult } from '@azerothjs/kit/ssr';
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

// The kernel decodes segments before matching, so `/%66a/about` reaches the `/fa` mount and
// must be peeled like `/fa/about`; the rest of the path keeps its spelling.
describe('a language prefix is decided on the decoded first segment, and the rest keeps its spelling', () =>
{
    const echo = (url: string, shell: string, options?: PageRenderOptions): Promise<PageResult> =>
        Promise.resolve({
            kind: 'html', status: 200,
            html: shell.replace('<div id="root"></div>', `<div id="root">URL=${ url } LOCALE=${ options?.locale ?? '-' } BASE=${ options?.base ?? '-' } ALT=${ (options?.alternates ?? []).map((a) => a.href).join(',') } END</div>`)
        });

    function mount(): App
    {
        const dir = mkdtempSync(join(tmpdir(), 'az-lroute-'));
        writeFileSync(join(dir, 'index.html'), SHELL);
        mkdirSync(join(dir, 'assets'));
        dirs.push(dir);
        const server = new App();
        mountPages(server, {
            routes: [...routes, { path: '/post/:slug', component: Page, render: 'server' }],
            clientDir: dir,
            renderer: echo,
            locales: { supported: ['en', 'fa'], default: 'en', routing: 'prefix' }
        });
        return server;
    }

    async function read(server: App, path: string): Promise<{ status: number; vary: string | null; url: string; locale: string; base: string; alt: string }>
    {
        const response = await server.handle(new Request(`http://local${ path }`, { headers: { accept: 'text/html' } }));
        const html = await response.text();
        return {
            status: response.status,
            vary: response.headers.get('vary'),
            url: /URL=(\S+) LOCALE/.exec(html)?.[1] ?? '',
            locale: /LOCALE=(\S+) BASE/.exec(html)?.[1] ?? '',
            base: /BASE=(\S+) ALT/.exec(html)?.[1] ?? '',
            alt: /ALT=(\S*) END/.exec(html)?.[1] ?? ''
        };
    }

    it('an encoded prefix is the language it names: same app path, same language, no Vary, canonical hrefs', async () =>
    {
        const server = mount();
        const plain = await read(server, '/fa/about');
        expect(plain).toEqual({ status: 200, vary: null, url: '/about', locale: 'fa', base: '/fa', alt: 'http://local/en/about,http://local/fa/about,http://local/about' });
        for (const spelling of ['/%66a/about', '/%66%61/about', '/f%61/about'])
        {
            expect(await read(server, spelling), spelling).toEqual(plain);
        }
    });

    it('the prefix alone is the root page, with the query kept', async () =>
    {
        const server = mount();
        expect(await read(server, '/fa')).toMatchObject({ url: '/', locale: 'fa', vary: null });
        expect(await read(server, '/%66a')).toMatchObject({ url: '/', locale: 'fa', vary: null });
        expect(await read(server, '/%66a?p=2')).toMatchObject({ url: '/?p=2', locale: 'fa', vary: null });
    });

    it('the remainder is not decoded: an encoded separator in a param stays one segment', async () =>
    {
        const server = mount();
        expect(await read(server, '/fa/post/a%2Fb')).toMatchObject({ url: '/post/a%2Fb', locale: 'fa' });
        expect(await read(server, '/%66a/post/a%2Fb')).toMatchObject({ url: '/post/a%2Fb', locale: 'fa' });
    });

    it('a double-encoded prefix is not a prefix: it negotiates like any unprefixed url', async () =>
    {
        const server = mount();
        const seen = await read(server, '/%2566a/about');
        expect(seen.locale).toBe('en');
        expect(seen.base).toBe('-');
        expect(seen.url).toBe('/%2566a/about');
        expect(seen.vary).toContain('accept-language');
    });
});

// The url prefix reaches the client the way the language does: pinned for the render, stamped
// on the document, and applied to every anchor, form and redirect the server writes.
describe('the url prefix reaches the client', () =>
{
    const COOKIE = 'azcsrf';
    const sendTo = (to: string) => async (): Promise<undefined> =>
    {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the documented redirect sentinel
        throw redirect(to);
    };
    const marker = (text: string): HTMLElement => h('p', { id: 'marker' }, text);
    const withLinks = (text: string) => (): HTMLElement =>
        h('main', {}, marker(text), Link({ to: '/', children: 'home' }), Link({ to: '/users/1', children: 'user' }));
    const table: PageRoute[] = [
        { path: '/', component: withLinks('HOME'), render: 'server' },
        { path: '/about', component: withLinks('ABOUT'), render: 'server' },
        { path: '/users/:id', component: withLinks('USER'), render: 'server' },
        { path: '/client', component: withLinks('CLIENT'), render: 'client' },
        { path: '/members', component: withLinks('MEMBERS'), render: 'server', guard: () => true },
        { path: '/guarded', component: withLinks('GUARDED'), render: 'server', guard: () => forbidden(), action: () => Promise.resolve(undefined) },
        { path: '/redirecting', component: withLinks('R'), render: 'server', guard: () => '/login' },
        { path: '/relative', component: withLinks('R'), render: 'server', guard: () => 'login' },
        { path: '/query', component: withLinks('R'), render: 'server', guard: () => '?page=2' },
        { path: '/vetted', component: withLinks('R'), render: 'server', guard: () => unsafeUrl('/\\evil') },
        { path: '/bare', component: withLinks('R'), render: 'server', guard: () => '\\evil' },
        { path: '/hand', component: withLinks('R'), render: 'server', guard: () => '/fa/login' },
        { path: '/todos', component: withLinks('TODOS'), render: 'server', action: () => Promise.resolve(undefined) },
        { path: '/refuse', component: withLinks('REFUSE'), render: 'server', action: () => Promise.resolve({ fields: { text: 'Required' } }) },
        { path: '/thanks-action', component: withLinks('T'), render: 'server', action: sendTo('/thanks') },
        { path: '/rel-login', component: withLinks('T'), render: 'server', action: sendTo('login') },
        { path: '/rel-query', component: withLinks('T'), render: 'server', action: sendTo('?page=2') },
        { path: '/dotty', component: withLinks('T'), render: 'server', action: sendTo('../up') },
        { path: '/gated-post', component: withLinks('T'), render: 'server', guard: () => 'login', action: () => Promise.resolve(undefined) },
        {
            path: '/refuse-loader', component: withLinks('T'), render: 'server',
            loader: (): never =>
            {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- the documented redirect sentinel
                throw redirect('/login');
            },
            action: () => Promise.resolve({ fields: { text: 'Required' } })
        }
    ];

    const app = (props: { url?: string; handoff?: LoaderHandoff }): HTMLElement => RouterProvider({
        router: createRouter({ routes: table, history: createMemoryHistory(props.url ?? '/'), initialLoaderData: props.handoff }),
        children: () => h('div', {}, h('nav', {}, Link({ to: '/', children: 'nav-home' })), Routes({ fallback: () => marker('NOT-FOUND') }))
    }) as HTMLElement;

    function mount(locales?: { supported: string[]; routing?: 'prefix'; default?: string }, shell = SHELL, renderer = createPageRenderer(app, table)): App
    {
        const dir = mkdtempSync(join(tmpdir(), 'az-prefix-'));
        writeFileSync(join(dir, 'index.html'), shell);
        mkdirSync(join(dir, 'assets'));
        dirs.push(dir);
        const server = new App();
        mountPages(server, { routes: table, clientDir: dir, renderer, csrf: { cookie: COOKIE }, ...(locales !== undefined ? { locales } : {}) });
        return server;
    }
    const PREFIX = { supported: ['en', 'fa'], routing: 'prefix' as const };
    const NEGOTIATE = { supported: ['en', 'fa'] };

    const get = (server: App, path: string, headers: Record<string, string> = {}): Promise<Response> =>
        server.handle(new Request(`http://local${ path }`, { headers: { accept: 'text/html', ...headers } }));
    const post = (server: App, path: string, headers: Record<string, string> = {}): Promise<Response> =>
    {
        const token = csrfToken();
        return server.handle(new Request(`http://local${ path }`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${ COOKIE }=${ token }`, origin: 'http://local', ...headers },
            body: new URLSearchParams({ _csrf: token, text: 'x' }).toString()
        }));
    };
    const main = (html: string): string => html.slice(html.indexOf('<main'), html.indexOf('</main>'));
    const openTag = (html: string): string => /<html[^>]*>/i.exec(html)?.[0] ?? '';
    const handoffPath = (html: string): string | undefined =>
        (JSON.parse(/id="__azeroth-loader-handoff">([^<]*)</.exec(html)?.[1] ?? 'null') as { path?: string } | null)?.path;

    it('serves a prefixed page stamped, pinned and with every anchor under the prefix', async () =>
    {
        resetHead();
        const html = await (await get(mount(PREFIX), '/fa/about')).text();
        expect(openTag(html)).toContain('data-azeroth-base="/fa"');
        expect(openTag(html)).toContain('lang="fa"');
        expect(html).toContain('id="marker">ABOUT');
        expect(html).not.toContain('NOT-FOUND');
        expect(main(html)).toContain('href="/fa"');
        expect(main(html)).toContain('href="/fa/users/1"');
        expect(handoffPath(html)).toBe('/about');
        // The encoded spelling of the prefix is the same document.
        expect(main(await (await get(mount(PREFIX), '/%66a/about')).text())).toBe(main(html));
    });

    it('a negotiate-mode page and a single-language page carry no stamp and unprefixed anchors', async () =>
    {
        resetHead();
        for (const server of [mount(NEGOTIATE), mount()])
        {
            const html = await (await get(server, '/about', { 'accept-language': 'fa' })).text();
            expect(openTag(html)).not.toContain('data-azeroth-base');
            expect(main(html)).toContain('href="/users/1"');
            expect(main(html)).not.toContain('href="/fa');
        }
    });

    it('a client-rendered page carries the stamp with no handoff', async () =>
    {
        resetHead();
        const html = await (await get(mount(PREFIX), '/fa/client')).text();
        expect(openTag(html)).toContain('data-azeroth-base="/fa"');
        expect(html).not.toContain('__azeroth-loader-handoff');
    });

    it('the catch-all 404 is stamped under a prefix and bare at a bare url', async () =>
    {
        resetHead();
        const server = mount(PREFIX);
        const prefixed = await get(server, '/fa/nope');
        const prefixedHtml = await prefixed.text();
        expect(prefixed.status).toBe(404);
        expect(openTag(prefixedHtml)).toContain('data-azeroth-base="/fa"');
        expect(prefixedHtml).toContain('href="/fa"');
        expect(prefixedHtml).toContain('NOT-FOUND');
        const bare = await get(server, '/nope');
        const bareHtml = await bare.text();
        expect(bare.status).toBe(404);
        expect(openTag(bareHtml)).not.toContain('data-azeroth-base');
        expect(bareHtml).toContain('href="/"');
    });

    it('a guarded chain under a prefix keeps the guarded stamp', async () =>
    {
        resetHead();
        const response = await get(mount(PREFIX), '/fa/members');
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(openTag(await response.text())).toContain('data-azeroth-base="/fa"');
    });

    it('the guard-veto re-render of a prefixed POST carries the stamp and prefixed anchors', async () =>
    {
        resetHead();
        const response = await post(mount(PREFIX), '/fa/guarded');
        const html = await response.text();
        expect(response.status).toBe(403);
        expect(openTag(html)).toContain('data-azeroth-base="/fa"');
        expect(html).toContain('href="/fa"');
    });

    it('a server redirect is answered in the request\'s url space, and relative targets are the browser\'s', async () =>
    {
        resetHead();
        const server = mount(PREFIX);
        const location = async (path: string): Promise<string | null> => (await get(server, path)).headers.get('location');
        expect(await location('/fa/redirecting')).toBe('/fa/login');
        expect(await location('/fa/relative')).toBe('login');
        expect(await location('/fa/query')).toBe('?page=2');
        expect(await location('/fa/vetted')).toBe('/\\evil');
        expect(await location('/fa/bare')).toBe('/fa\\evil');
        expect(await location('/fa/hand')).toBe('/fa/fa/login');
        expect((await get(mount(NEGOTIATE), '/redirecting')).headers.get('location')).toBe('/login');
    });

    it('a host renderer\'s redirect is answered in the request\'s url space too', async () =>
    {
        const host = (): Promise<PageResult> => Promise.resolve({ kind: 'redirect', to: '/login', replace: false });
        expect((await get(mount(PREFIX, SHELL, host), '/fa/about')).headers.get('location')).toBe('/fa/login');
    });

    it('a form action refusal re-renders stamped, a write returns to the prefixed page, a redirect is joined', async () =>
    {
        resetHead();
        const server = mount(PREFIX);
        const refused = await post(server, '/fa/refuse');
        expect(refused.status).toBe(422);
        expect(openTag(await refused.text())).toContain('data-azeroth-base="/fa"');
        const written = await post(server, '/fa/todos');
        expect(written.status).toBe(303);
        expect(written.headers.get('location')).toBe('/fa/todos');
        const sent = await post(server, '/fa/thanks-action');
        expect(sent.headers.get('location')).toBe('/fa/thanks');
        expect(await (await post(server, '/fa/thanks-action', { accept: 'application/json' })).json()).toEqual({ ok: true, redirect: '/thanks' });
    });

    it('a relative redirect target reaches the native and the enhanced submit at one url', async () =>
    {
        resetHead();
        const server = mount(PREFIX);
        const json = { accept: 'application/json' };
        // Resolved once against the prefixed request url: the browser and the client router agree.
        expect((await post(server, '/fa/rel-login?page=1')).headers.get('location')).toBe('/fa/login');
        expect(await (await post(server, '/fa/rel-login?page=1', json)).json()).toEqual({ ok: true, redirect: '/login' });
        expect((await post(server, '/fa/rel-query?page=1')).headers.get('location')).toBe('/fa/rel-query?page=2');
        expect(await (await post(server, '/fa/rel-query?page=1', json)).json()).toEqual({ ok: true, redirect: '/rel-query?page=2' });
        expect((await post(server, '/fa/gated-post')).headers.get('location')).toBe('/fa/login');
        expect(await (await post(server, '/fa/gated-post', json)).json()).toEqual({ ok: true, redirect: '/login' });
        // A target that climbs out of the prefix has no app path: refused, in both representations.
        expect((await post(server, '/fa/dotty?page=1')).status).toBe(500);
        expect((await post(server, '/fa/dotty?page=1', json)).status).toBe(500);
        // Without a base both representations are what the action said.
        const negotiate = mount(NEGOTIATE);
        expect((await post(negotiate, '/rel-login?page=1')).headers.get('location')).toBe('login');
        expect(await (await post(negotiate, '/rel-login?page=1', json)).json()).toEqual({ ok: true, redirect: 'login' });
        expect((await post(negotiate, '/dotty?page=1')).headers.get('location')).toBe('../up');
    });

    it('the refusal re-render that redirects answers in the request\'s url space', async () =>
    {
        resetHead();
        expect((await post(mount(PREFIX), '/fa/refuse-loader')).headers.get('location')).toBe('/fa/login');
        expect((await post(mount(NEGOTIATE), '/refuse-loader')).headers.get('location')).toBe('/login');
    });

    it('a shell that already carries the attribute yields one in prefix mode and none otherwise', async () =>
    {
        resetHead();
        const stale = '<!doctype html><html lang="en" data-azeroth-base="/de"><head><title>Shell</title></head><body><div id="root"></div></body></html>';
        const prefixed = openTag(await (await get(mount(PREFIX, stale), '/fa/about')).text());
        expect(prefixed.match(/data-azeroth-base/g)).toHaveLength(1);
        expect(prefixed).toContain('data-azeroth-base="/fa"');
        expect(openTag(await (await get(mount(NEGOTIATE, stale), '/about')).text())).not.toContain('data-azeroth-base');
    });

    it('refuses a malformed language tag at mount', () =>
    {
        expect(() => mount({ supported: ['en', 'pt_BR'] })).toThrow(/"pt_BR" is not a language tag/);
        expect(() => mount({ supported: ['en'], routing: 'prefix', default: 'sr@latin' })).toThrow(/"sr@latin" is not a language tag/);
    });
});
