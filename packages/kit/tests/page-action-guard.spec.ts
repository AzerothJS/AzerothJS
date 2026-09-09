// @vitest-environment node
// A page action is a write to the page the visitor is looking at, so it is gated by exactly what
// gates that page: the route chain's guards, the redirect-target rule, and the CSRF check. Every
// arm here posts through a REAL createPageRenderer over a real route table, so the walk the POST
// runs is the walk the GET runs, and the arms that pin the two paths together run the same
// verdict through matchAndLoad as well.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { Form, RouterProvider, Routes, createMemoryHistory, createRouter, createSignal, createStore, forbidden, h, matchAndLoad, redirect, unauthorized, unsafeUrl } from 'azerothjs';
import type { GuardVerdict, LoaderHandoff } from 'azerothjs';
import { evaluateGuards } from 'azerothjs/internal';
import { App, csrfToken, parseCookies } from '@azerothjs/http';
import { mountPages, type KitOptions, type PageRoute } from '@azerothjs/kit';
import { prerender } from '@azerothjs/kit/prerender';
import { createPageRenderer, type PageResult } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';
const COOKIE = 'azcsrf';
const CSRF = { cookie: COOKIE };

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

function clientDir(): string
{
    const dir = mkdtempSync(join(tmpdir(), 'az-action-guard-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    return dir;
}

/** Request-scoped identity, filled by middleware from a cookie: the channel a guard reads on the server. */
const useSession = createStore(() =>
{
    const [user, setUser] = createSignal<string | null>(null);
    return { user, setUser };
});

const executed: string[] = [];
const orderGuard = vi.fn((): GuardVerdict => forbidden());
const refuseGuard = vi.fn((): GuardVerdict => true);

const page = (id: string): (() => HTMLElement) => () => h('div', { id }, `PAGE ${ id }`);
const act = (name: string) => async ({ form }: { form: URLSearchParams }): Promise<unknown> =>
{
    executed.push(`${ name }:${ form.get('text') ?? '' }`);
    return undefined;
};

// Thrown verdicts and redirects are documented sentinels, not errors; the lint rule cannot know.
function throwForbidden(): never
{
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- documented sentinel
    throw forbidden();
}
function throwUnauthorized(): never
{
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- documented sentinel
    throw unauthorized();
}
const goTo = (to: string) => async (): Promise<never> =>
{
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- documented sentinel
    throw redirect(to);
};
async function goToSubmitted({ form }: { form: URLSearchParams }): Promise<never>
{
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- documented sentinel
    throw redirect(form.get('next') ?? '/');
}
const routes: PageRoute[] = [
    { path: '/', component: page('home') },
    {
        path: '/docs/admin',
        component: page('admin'),
        guard: () => (useSession().user() === 'admin' ? true : (useSession().user() === null ? unauthorized() : forbidden())),
        action: act('admin')
    },
    {
        path: '/nested',
        component: (): HTMLElement => h('section', { id: 'nested' }, 'layout'),
        guard: () => (useSession().user() === null ? forbidden() : true),
        children: [{ path: 'write', component: page('write'), action: act('nested') }]
    },
    { path: '/false-guard', component: page('fg'), guard: () => false, action: act('false-guard') },
    { path: '/thrown-forbidden', component: page('tf'), guard: throwForbidden, action: act('thrown-forbidden') },
    { path: '/thrown-unauthorized', component: page('tu'), guard: throwUnauthorized, action: act('thrown-unauthorized') },
    { path: '/object-verdict', component: page('ov'), guard: () => ({ pathname: '/login' }), action: act('object-verdict') },
    { path: '/guard-redirect', component: page('gr'), guard: () => redirect('/login'), action: act('guard-redirect') },
    { path: '/guard-evil', component: page('ge'), guard: () => redirect('https://evil.example/'), action: act('guard-evil') },
    { path: '/go', component: page('go'), action: goTo('/signed-in') },
    { path: '/go-next', component: page('gn'), action: goToSubmitted },
    { path: '/go-unsafe', component: page('gu'), action: goTo(unsafeUrl('https://x.example/')) },
    { path: '/refuse', component: page('refuse'), guard: refuseGuard, action: async () => ({ fields: { text: 'Required' } }) },
    { path: '/csrf-order', component: page('order'), guard: orderGuard, action: act('order') },
    { path: '/login', component: page('login') },
    { path: '/signed-in', component: page('signed-in') },
    {
        path: '/contact',
        component: (): HTMLElement => h('div', { id: 'contact' }, Form({ children: h('button', { type: 'submit' }, 'send') })),
        action: act('contact')
    }
];

const view = (props: { url?: string; handoff?: LoaderHandoff }): HTMLElement =>
    RouterProvider({
        router: createRouter({ routes: routes, history: createMemoryHistory(props.url ?? '/'), initialLoaderData: props.handoff }),
        children: () => Routes({
            fallback: () => h('h1', {}, 'not found'),
            blocked: (state) => h('h1', { id: 'blocked' }, `NO ACCESS ${ state.status }`)
        })
    }) as HTMLElement;

function serve(extra: Partial<KitOptions> = {}): App
{
    const app = new App();
    app.use((context) =>
    {
        useSession().setUser(parseCookies(context.request).user ?? null);
    });
    mountPages(app, { routes, clientDir: clientDir(), csrf: CSRF, renderer: createPageRenderer(view, routes), ...extra });
    return app;
}

interface PostOptions { user?: string; json?: boolean; origin?: string; fields?: Record<string, string> }

async function post(app: App, path: string, options: PostOptions = {}): Promise<Response>
{
    const token = csrfToken();
    return app.handle(new Request(`http://local${ path }`, {
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            cookie: `${ COOKIE }=${ token }${ options.user === undefined ? '' : `; user=${ options.user }` }`,
            origin: options.origin ?? 'http://local',
            ...(options.json === true ? { accept: 'application/json' } : {})
        },
        body: new URLSearchParams({ _csrf: token, text: 'hello', ...(options.fields ?? {}) }).toString()
    }));
}

describe('a page action runs the chain\'s guards through the walk the page\'s GET runs', () =>
{
    it('refuses an anonymous submit to a guarded page with the page\'s own blocked UI, and never runs the action', async () =>
    {
        const app = serve();
        executed.length = 0;
        const anon = await post(app, '/docs/admin');
        expect(anon.status).toBe(401);
        expect(anon.headers.get('cache-control')).toBe('private, no-store');
        expect(await anon.text()).toContain('NO ACCESS 401');
        const bob = await post(app, '/docs/admin', { user: 'bob' });
        expect(bob.status).toBe(403);
        expect(await bob.text()).toContain('NO ACCESS 403');
        expect(executed).toEqual([]);

        const admin = await post(app, '/docs/admin', { user: 'admin' });
        expect(admin.status).toBe(303);
        expect(admin.headers.get('location')).toBe('/docs/admin');
        expect(executed).toEqual(['admin:hello']);
    });

    it('answers a JSON client with the kernel envelope at the guard\'s status', async () =>
    {
        const app = serve();
        executed.length = 0;
        const anon = await post(app, '/docs/admin', { json: true });
        expect(anon.status).toBe(401);
        expect((await anon.json() as { error: { code: string } }).error.code).toBe('unauthorized');
        expect(executed).toEqual([]);
    });

    it('a guard inherited from a layout gates the leaf\'s action, query string included', async () =>
    {
        const app = serve();
        executed.length = 0;
        const anon = await post(app, '/nested/write?x=1&y=2');
        expect(anon.status).toBe(403);
        expect(executed).toEqual([]);
        const bob = await post(app, '/nested/write?x=1&y=2', { user: 'bob' });
        expect(bob.status).toBe(303);
        expect(bob.headers.get('location')).toBe('/nested/write?x=1&y=2');
        expect(executed).toEqual(['nested:hello']);
    });

    it('a THROWN denial and a bare-object verdict decide the POST exactly as they decide the GET', async () =>
    {
        const app = serve();
        executed.length = 0;
        expect((await post(app, '/false-guard')).status).toBe(403);
        expect((await post(app, '/thrown-forbidden')).status).toBe(403);
        expect((await post(app, '/thrown-unauthorized')).status).toBe(401);
        const object = await post(app, '/object-verdict');
        expect(object.status).toBe(303);
        expect(object.headers.get('location')).toBe('/login');
        expect(executed).toEqual([]);

        // The same verdicts through matchAndLoad: one walk, two callers.
        expect(await matchAndLoad(routes, '/false-guard')).toEqual({ blocked: true, status: 403 });
        expect(await matchAndLoad(routes, '/thrown-forbidden')).toEqual({ blocked: true, status: 403 });
        expect(await matchAndLoad(routes, '/thrown-unauthorized')).toEqual({ blocked: true, status: 401 });
        expect(await matchAndLoad(routes, '/object-verdict')).toEqual({ redirect: { pathname: '/login' }, replace: true });
    });

    it('a guard redirect is a 303 for a native submit and a JSON redirect for an enhanced one; off-origin is refused', async () =>
    {
        const app = serve();
        executed.length = 0;
        const native = await post(app, '/guard-redirect');
        expect(native.status).toBe(303);
        expect(native.headers.get('location')).toBe('/login');
        const enhanced = await post(app, '/guard-redirect', { json: true });
        expect(enhanced.status).toBe(200);
        expect(await enhanced.json()).toEqual({ ok: true, redirect: '/login' });
        const evil = await post(app, '/guard-evil');
        expect(evil.status).toBe(500);
        expect(evil.headers.get('location')).toBeNull();
        expect(executed).toEqual([]);
    });

    it('CSRF is checked before any guard runs: a cross-site submit never reaches the chain', async () =>
    {
        const app = serve();
        orderGuard.mockClear();
        const crossSite = await post(app, '/csrf-order', { origin: 'http://evil.example' });
        expect(crossSite.status).toBe(403);
        expect((await crossSite.json() as { error: { code: string } }).error.code).toBe('csrf');
        expect(orderGuard).not.toHaveBeenCalled();

        // A JSON client is answered from the walk alone: the guard ran exactly once.
        const enhanced = await post(app, '/csrf-order', { json: true });
        expect(enhanced.status).toBe(403);
        expect(orderGuard).toHaveBeenCalledTimes(1);
        // A native submit gets the page's blocked UI, whose render walks the chain again: twice,
        // the same accepted cost a refused submit's re-render pays.
        const native = await post(app, '/csrf-order');
        expect(native.status).toBe(403);
        expect(await native.text()).toContain('NO ACCESS 403');
        expect(orderGuard).toHaveBeenCalledTimes(3);
        expect(executed).not.toContain('order:hello');
    });

    it('a refused submit re-renders at 422 and the guard runs once for the walk and once for the render', async () =>
    {
        const app = serve();
        refuseGuard.mockClear();
        const refused = await post(app, '/refuse');
        expect(refused.status).toBe(422);
        expect(await refused.text()).toContain('PAGE refuse');
        expect(refuseGuard).toHaveBeenCalledTimes(2);
    });

    it('the walk answers not-found for a table that selects nothing', async () =>
    {
        expect(await evaluateGuards([], '/anything')).toEqual({ kind: 'not-found' });
    });
});

describe('an action\'s own redirect is judged by the same rule as every other boundary', () =>
{
    it('a same-origin target is followed; an enhanced submit receives it as JSON', async () =>
    {
        const app = serve();
        const native = await post(app, '/go');
        expect(native.status).toBe(303);
        expect(native.headers.get('location')).toBe('/signed-in');
        const enhanced = await post(app, '/go', { json: true });
        expect(enhanced.status).toBe(200);
        expect(enhanced.headers.get('cache-control')).toBe('private, no-store');
        expect(await enhanced.json()).toEqual({ ok: true, redirect: '/signed-in' });
    });

    it('an off-origin target from the submitted values never reaches Location', async () =>
    {
        const app = serve();
        for (const next of ['https://evil.example/', '//evil.example/x', '/\\evil.example/x', 'javascript:alert(1)'])
        {
            const response = await post(app, '/go-next', { fields: { next } });
            expect(response.status, next).toBe(500);
            expect(response.headers.get('location'), next).toBeNull();
        }
        const safe = await post(app, '/go-next', { fields: { next: '/safe' } });
        expect(safe.status).toBe(303);
        expect(safe.headers.get('location')).toBe('/safe');
    });

    it('unsafeUrl opts a deliberate off-origin target out', async () =>
    {
        const app = serve();
        const response = await post(app, '/go-unsafe');
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('https://x.example/');
    });
});

describe('under prefix routing the page accepts its form at every url it is mounted at', () =>
{
    const prefixed = (): App => serve({ locales: { supported: ['en', 'fa'], routing: 'prefix' } });

    it('the prefixed url the browser holds and the bare url the rendered form targets both answer', async () =>
    {
        const app = prefixed();
        executed.length = 0;
        const fa = await post(app, '/fa/docs/admin', { user: 'admin' });
        expect(fa.status).toBe(303);
        expect(fa.headers.get('location')).toBe('/fa/docs/admin');
        const bare = await post(app, '/docs/admin', { user: 'admin' });
        expect(bare.status).toBe(303);
        expect(bare.headers.get('location')).toBe('/docs/admin');
        expect(executed).toEqual(['admin:hello', 'admin:hello']);
    });

    it('a rendered <Form> posts to the action attribute it carries', async () =>
    {
        const app = prefixed();
        executed.length = 0;
        const html = await (await app.handle(new Request('http://local/fa/contact'))).text();
        const action = /<form[^>]*\baction="([^"]*)"/.exec(html)?.[1];
        expect(action).toBeDefined();
        const response = await post(app, action as string);
        expect(response.status).toBe(303);
        expect(executed).toEqual(['contact:hello']);
    });
});

describe('a page that cannot mint a token cannot receive a form', () =>
{
    const component = page('static');
    const action = act('static');

    it('mountPages refuses an action on a static page, naming render: server', () =>
    {
        const app = new App();
        expect(() => mountPages(app, { routes: [{ path: '/s', component, render: 'static', action }], clientDir: clientDir(), csrf: CSRF }))
            .toThrow(/render: 'server'/);
    });

    it('a wildcard static page without revalidate keeps its action, since it renders per request', () =>
    {
        const app = new App();
        expect(() => mountPages(app, { routes: [{ path: '/w/*rest', component, render: 'static', action }], clientDir: clientDir(), csrf: CSRF }))
            .not.toThrow();
    });

    it('a layout with an action is refused at mount, since a layout is not a page', () =>
    {
        const app = new App();
        expect(() => mountPages(app, { routes: [{ path: '/l', component, action, children: [{ path: 'leaf', component }] }], clientDir: clientDir(), csrf: CSRF }))
            .toThrow(/leaf route/);
    });

    it('the prerender pass refuses the same page', async () =>
    {
        const renderer = (_url: string, shell: string): Promise<PageResult> => Promise.resolve({ kind: 'html', status: 200, html: shell });
        await expect(prerender({ routes: [{ path: '/s', component, render: 'static', action }], clientDir: clientDir(), renderer }))
            .rejects.toThrow(/render: 'server'/);
    });
});
