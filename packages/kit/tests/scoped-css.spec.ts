// @vitest-environment node
//
// Scoped CSS must reach the SSR'd document.
//
// `css()` has no <head> to inject into on the server, so it records its scopes against the
// render and expects the host to drain them with collectStyleSheet(). The kit never did, so a
// server-rendered page arrived with the scoped CLASS on the element and none of the rules -
// correct-looking markup that paints unstyled until hydration injects the sheet. Nothing about
// the HTML reveals it; only comparing the class against the delivered CSS does.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { RouterProvider, Routes, createMemoryHistory, createRouter, css, h, resetStyleSheet } from 'azerothjs';
import type { LoaderHandoff, Route } from 'azerothjs';
import { App } from '@azerothjs/http';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import { createPageRenderer } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

function makeClientDir(): string
{
    const dir = mkdtempSync(join(tmpdir(), 'az-css-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    dirs.push(dir);
    return dir;
}

const styles = css('.card { color: rgb(1, 2, 3); }');

const styledRoutes: Route[] = [
    { path: '/', component: () => h('p', { class: styles.card }, 'hello') },
    { path: '/plain', component: () => h('p', {}, 'plain') }
];

const StyledApp = (props: { url?: string; handoff?: LoaderHandoff }): HTMLElement =>
    RouterProvider({
        router: createRouter({
            routes: styledRoutes,
            history: createMemoryHistory(props.url ?? '/'),
            initialLoaderData: props.handoff
        }),
        children: () => Routes({ fallback: () => h('h1', {}, 'not found') })
    }) as HTMLElement;

describe('scoped CSS in a server-rendered document', () =>
{
    const render = createPageRenderer(StyledApp, styledRoutes);

    it('delivers the rules for every scoped class it puts in the markup', async () =>
    {
        const result = await render('/', SHELL);
        expect(result.kind).toBe('html');
        const html = (result as { html: string }).html;

        // The class the element actually carries...
        const scoped = /class="(card_[\da-z]+)"/.exec(html)?.[1];
        expect(scoped).toBeDefined();
        // ...must have a matching rule in the document, or the page paints unstyled.
        expect(html).toContain('<style data-azeroth-css>');
        expect(html).toContain(`.${ scoped ?? '' }`);
        expect(html).toContain('color: rgb(1, 2, 3)');
    });

    it('puts the stylesheet in <head>, ahead of the body it styles', async () =>
    {
        const html = ((await render('/', SHELL)) as { html: string }).html;

        const styleAt = html.indexOf('<style data-azeroth-css');
        expect(styleAt).toBeGreaterThan(-1);
        expect(styleAt).toBeLessThan(html.indexOf('</head>'));
        expect(styleAt).toBeLessThan(html.indexOf('<div id="root">'));
    });

    it('stamps the CSP nonce on the stylesheet when one is supplied', async () =>
    {
        const html = ((await render('/', SHELL, { scriptNonce: 'abc123' })) as { html: string }).html;

        // Without the nonce a strict policy refuses the element and the page paints unstyled.
        expect(html).toContain('<style data-azeroth-css nonce="abc123">');
    });

    it('emits no stylesheet for a render that registered no scoped CSS', async () =>
    {
        // resetStyleSheet clears the app-global registry, so this render contributes nothing.
        resetStyleSheet();
        const html = ((await render('/plain', SHELL)) as { html: string }).html;

        expect(html).not.toContain('data-azeroth-css');
    });
});

describe('the nonce reaches the BUFFERED page, not only the streamed one', () =>
{
    it('mountPages passes scriptNonce down a render: server route', async () =>
    {
        const styled = css('.badge { color: rgb(9, 9, 9); }');
        const routes: PageRoute[] = [{
            path: '/',
            component: () => h('span', { class: styled.badge }, 'hi'),
            render: 'server'
        }];
        const PageApp = (props: { url?: string; handoff?: LoaderHandoff }): HTMLElement =>
            RouterProvider({
                router: createRouter({
                    routes,
                    history: createMemoryHistory(props.url ?? '/'),
                    initialLoaderData: props.handoff
                }),
                children: () => Routes({ fallback: () => h('h1', {}, 'nf') })
            }) as HTMLElement;

        const app = new App();
        mountPages(app, {
            routes,
            clientDir: makeClientDir(),
            renderer: createPageRenderer(PageApp, routes),
            scriptNonce: () => 'buffered-nonce'
        });

        const response = await app.handle(new Request('http://local/'));
        const html = await response.text();

        // Before this, only `render: 'stream'` received the nonce, so a server-rendered page's
        // stylesheet was refused by a strict `style-src` and the page painted unstyled.
        expect(html).toContain('<style data-azeroth-css nonce="buffered-nonce">');
    });
});

describe('a STREAMED page also carries its scoped CSS', () =>
{
    // The sibling gap: the buffered path was fixed first and the streaming path was not, so a
    // `render: 'stream'` route flushed its shell with scoped class names and no rules - an
    // unstyled first paint, which is exactly what streaming exists to avoid. Measured on a real
    // app before the fix: server 1 stylesheet, static 1, stream 0.
    it('emits the stylesheet in the streamed head, before any body chunk', async () =>
    {
        const styled = css('.hero { color: rgb(7, 7, 7); }');
        const routes: Route[] = [{ path: '/', component: () => h('div', { class: styled.hero }, 'hi') }];
        const StreamApp = (props: { url?: string; handoff?: LoaderHandoff }): HTMLElement =>
            RouterProvider({
                router: createRouter({
                    routes,
                    history: createMemoryHistory(props.url ?? '/'),
                    initialLoaderData: props.handoff
                }),
                children: () => Routes({ fallback: () => h('h1', {}, 'nf') })
            }) as HTMLElement;

        const render = createPageRenderer(StreamApp, routes);
        const result = await render('/', SHELL, { stream: true });
        expect(result.kind).toBe('stream');

        // Read the FIRST chunk only: the stylesheet has to be in the head that flushes
        // immediately, not somewhere in the tail after the body.
        const reader = (result as { stream: ReadableStream<Uint8Array> }).stream.getReader();
        const first = await reader.read();
        const head = new TextDecoder().decode(first.value ?? new Uint8Array());
        await reader.cancel();

        expect(head).toContain('<style data-azeroth-css>');
        expect(head).toContain('color: rgb(7, 7, 7)');
        expect(head.indexOf('<style data-azeroth-css>')).toBeLessThan(head.indexOf('<div id="root">'));
    });

    it('stamps the nonce on a streamed page stylesheet too', async () =>
    {
        const styled = css('.badge { color: rgb(8, 8, 8); }');
        const routes: Route[] = [{ path: '/', component: () => h('div', { class: styled.badge }, 'hi') }];
        const StreamApp = (props: { url?: string; handoff?: LoaderHandoff }): HTMLElement =>
            RouterProvider({
                router: createRouter({
                    routes,
                    history: createMemoryHistory(props.url ?? '/'),
                    initialLoaderData: props.handoff
                }),
                children: () => Routes({ fallback: () => h('h1', {}, 'nf') })
            }) as HTMLElement;

        const render = createPageRenderer(StreamApp, routes);
        const result = await render('/', SHELL, { stream: true, scriptNonce: 'streamnonce' });
        const reader = (result as { stream: ReadableStream<Uint8Array> }).stream.getReader();
        const head = new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
        await reader.cancel();

        expect(head).toContain('<style data-azeroth-css nonce="streamnonce">');
    });
});

describe('one request\'s scoped CSS never reaches another request\'s document', () =>
{
    // A CROSS-REQUEST CONTENT LEAK, found by an adversarial audit of this pass and reproduced
    // here. `css()` inside a component body registers into a per-render frame keyed by the
    // render's store scope. `collectStyleSheet()` drained that frame WITHOUT checking who owned
    // it, so once the streamed path started collecting before its render, the frame each render
    // left behind was published into the NEXT request's <head>. Measured before the fix: tenant
    // A's interpolated colour appeared in tenant B's page, and a route with no scoped CSS at all
    // shipped a previous request's rules.
    //
    // `css` is a tagged template and its own documentation invites a per-tenant interpolation, so
    // the leaked value is exactly the kind that must not cross a request boundary.
    function tenantApp(): (props: { url?: string; handoff?: LoaderHandoff }) => HTMLElement
    {
        const routes: Route[] = [
            {
                path: '/brand/:tenant',
                component: () =>
                {
                    // Per-request interpolation: the documented, supported shape.
                    const tenant = currentTenant;
                    const styles = css(`.brand { color: ${ tenant }; }`);
                    return h('div', { class: styles.brand }, tenant);
                }
            },
            { path: '/plain', component: () => h('p', {}, 'no scoped css here') }
        ];
        return (props) => RouterProvider({
            router: createRouter({
                routes,
                history: createMemoryHistory(props.url ?? '/'),
                initialLoaderData: props.handoff
            }),
            children: () => Routes({ fallback: () => h('h1', {}, 'nf') })
        }) as HTMLElement;
    }

    let currentTenant = 'rgb(1, 1, 1)';

    async function headOf(result: unknown): Promise<string>
    {
        const typed = result as { kind: string; html?: string; stream?: ReadableStream<Uint8Array> };
        if (typed.kind === 'html')
        {
            return typed.html ?? '';
        }
        const reader = (typed.stream as ReadableStream<Uint8Array>).getReader();
        const head = new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
        await reader.cancel();
        return head;
    }

    it('a streamed render does not publish its CSS into the NEXT streamed page', async () =>
    {
        resetStyleSheet();
        const app = tenantApp();
        const routes: Route[] = [];
        const render = createPageRenderer(app, routes);

        currentTenant = 'TENANT-A-SECRET';
        await headOf(await render('/brand/a', SHELL, { stream: true }));

        currentTenant = 'TENANT-B';
        const second = await headOf(await render('/brand/b', SHELL, { stream: true }));

        expect(second).not.toContain('TENANT-A-SECRET');
    });

    it('a route with NO scoped CSS ships none of a previous request\'s rules', async () =>
    {
        resetStyleSheet();
        const app = tenantApp();
        const render = createPageRenderer(app, []);

        currentTenant = 'TENANT-A-SECRET';
        await headOf(await render('/brand/a', SHELL, { stream: true }));

        const plain = await headOf(await render('/plain', SHELL));
        expect(plain).not.toContain('TENANT-A-SECRET');
        expect(plain).not.toContain('data-azeroth-css');
    });
});
