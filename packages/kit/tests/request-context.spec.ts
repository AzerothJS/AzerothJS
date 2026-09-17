// @vitest-environment node
//
// Which renders the live request reaches, and what a render that used it is allowed to be.
// A per-request render gets the visitor's own Request - the guards and loaders read it, the
// component reads it back through useRequest(), and the app's own api answers it in process
// with no socket. A SHARED render (ISR production and regeneration, the build-time prerender)
// gets none of that, because its output is handed to everybody.
//
// Every arm drives the real mountPages over a handle captured before the fetch spy is
// installed, so a counting spy on `globalThis.fetch` records only what the SERVER dials.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { RouterProvider, Routes, createMemoryHistory, createRouter, forbidden, h, unauthorized, useLoader, useRequest } from 'azerothjs';
import type { GuardVerdict, LoaderHandoff, MountNode, RouteLoaderArgs } from 'azerothjs';
import { object, string } from '@azerothjs/schema';
import { App, csrfToken, parseCookies } from '@azerothjs/http';
import type { RequestContext } from '@azerothjs/http';
import { createClient, feature, manifestOf, register } from '@azerothjs/http/api';
import type { ClientOf } from '@azerothjs/http/api';
import { mountPages, type KitOptions, type PageRoute } from '@azerothjs/kit';
import { prerender } from '@azerothjs/kit/prerender';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import type { PageRenderer, PageResult } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';
const COOKIE = 'azcsrf';

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

function clientDir(label: string): string
{
    const dir = mkdtempSync(join(tmpdir(), `az-reqctx-${ label }-`));
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    dirs.push(dir);
    return dir;
}

/** The app's OWN api: one route that answers with whoever the forwarded cookie says. */
const served: string[] = [];
const directory = feature('/directory', (routes) => ({
    who: routes.get('/who', { output: object({ visitor: string() }) }, (context) =>
    {
        const visitor = parseCookies(context.request)['visitor'] ?? 'anonymous';
        served.push(visitor);
        return { visitor };
    })
}));
const api = { directory };
/** Built at module scope with a relative baseUrl, exactly as a generated app builds it. */
const client: ClientOf<typeof api> = createClient<typeof api>(manifestOf(api), { baseUrl: '/api' });

const dial = (): MockInstance<typeof fetch> => vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
{
    throw new Error('the server opened a socket');
});

/** Renders whatever the loader settled with, which is how an arm sees the api's answer in the bytes. */
const Echo = (): MountNode =>
{
    const data = useLoader<{ visitor: string }>();
    return h('main', { id: 'echo' }, () => (data.error() !== null ? 'FAILED' : `VISITOR ${ data.data()?.visitor ?? '-' }`));
};

const viewOver = (table: PageRoute[]) => (props: { url?: string; handoff?: LoaderHandoff }): HTMLElement =>
    RouterProvider({
        router: createRouter({ routes: table, history: createMemoryHistory(props.url ?? '/'), initialLoaderData: props.handoff }),
        children: () => Routes({
            fallback: () => h('h1', {}, 'not found'),
            blocked: (state) => h('h1', { id: 'blocked' }, `NO ACCESS ${ state.status }`)
        })
    }) as HTMLElement;

const get = (app: App, path: string, headers: Record<string, string> = {}): Promise<Response> =>
    app.handle(new Request(`http://local${ path }`, { headers: { accept: 'text/html', ...headers } }));

async function post(app: App, path: string, visitor?: string): Promise<Response>
{
    const token = csrfToken();
    return app.handle(new Request(`http://local${ path }`, {
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            cookie: `${ COOKIE }=${ token }${ visitor === undefined ? '' : `; visitor=${ visitor }` }`,
            origin: 'http://local'
        },
        body: new URLSearchParams({ _csrf: token, text: 'hello' }).toString()
    }));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Every render site, named by the url it renders, with whether it was handed a request. */
describe('which renders receive the live request', () =>
{
    const component = (): HTMLElement => h('p', {}, 'page');
    const seen: Array<{ url: string; request: boolean }> = [];

    const recorder: PageRenderer = (url, shell, options) =>
    {
        seen.push({ url, request: options?.request !== undefined });
        if (url.startsWith('/refused'))
        {
            return Promise.resolve<PageResult>({ kind: 'blocked', status: 403, html: shell });
        }
        if (options?.stream === true)
        {
            const stream = new ReadableStream<Uint8Array>({
                start(controller): void
                {
                    controller.enqueue(new TextEncoder().encode(shell));
                    controller.close();
                }
            });
            return Promise.resolve<PageResult>({ kind: 'stream', status: 200, stream });
        }
        return Promise.resolve<PageResult>({ kind: 'html', status: 200, html: shell });
    };

    const table: PageRoute[] = [
        // Declared first, so it wins every url under /gate and sends the ISR page down guardedLive.
        { path: '/gate/*rest', component, guard: (): GuardVerdict => true },
        { path: '/gate/:slug', component, render: 'static', revalidate: 300 },
        { path: '/live', component, render: 'server' },
        { path: '/flow', component, render: 'stream' },
        { path: '/refused', component, guard: (): GuardVerdict => forbidden(), action: (): Promise<unknown> => Promise.resolve(undefined) },
        { path: '/cached', component, render: 'static', revalidate: 0.02 }
    ];

    function mount(): App
    {
        const app = new App();
        mountPages(app, { routes: table, clientDir: clientDir('sites'), renderer: recorder, csrf: { cookie: COOKIE } });
        return app;
    }

    it('hands it to the four per-request renders and to none of the shared ones', async () =>
    {
        const app = mount();
        seen.length = 0;

        expect((await get(app, '/live')).status).toBe(200);
        expect((await get(app, '/flow')).status).toBe(200);
        expect((await post(app, '/refused')).status).toBe(403);
        expect((await get(app, '/gate/secret')).status).toBe(200);

        expect(seen).toEqual([
            { url: '/live', request: true },
            { url: '/flow', request: true },
            { url: '/refused', request: true },
            { url: '/gate/secret', request: true }
        ]);

        // The shared ones: a production, then the regeneration its expiry triggers.
        seen.length = 0;
        expect((await get(app, '/cached')).headers.get('x-azeroth-cache')).toBe('miss');
        await sleep(40);
        expect((await get(app, '/cached')).headers.get('x-azeroth-cache')).toBe('stale');
        await vi.waitFor(() => expect(seen.length).toBe(2));
        expect(seen).toEqual([
            { url: '/cached', request: false },
            { url: '/cached', request: false }
        ]);

        // And the build-time pass, which answers no request at all.
        seen.length = 0;
        const dir = clientDir('prerender');
        await prerender({ routes: [{ path: '/doc', component, render: 'static' }], clientDir: dir, renderer: recorder });
        expect(seen).toEqual([{ url: '/doc', request: false }]);
    });
});

/** A server-rendered page calling its own api, in process. */
describe('a render: \'server\' page reaches the app\'s own api in process', () =>
{
    /** What the action body below read, so an arm can see the POST from inside it. */
    let inBody: { ambient: Request | null; answer: { visitor: string } | null } = { ambient: null, answer: null };

    const table: PageRoute[] = [
        { path: '/typed-list', component: Echo, render: 'server', loader: (): Promise<{ visitor: string }> => client.directory.who() },
        {
            path: '/guarded-list',
            component: Echo,
            render: 'server',
            guard: async (): Promise<GuardVerdict> => ((await client.directory.who()).visitor === 'anonymous' ? forbidden() : true),
            loader: (): Promise<{ visitor: string }> => client.directory.who(),
            action: (): Promise<unknown> => Promise.resolve(undefined)
        },
        {
            path: '/sign',
            component: Echo,
            render: 'server',
            loader: (): Promise<{ visitor: string }> => client.directory.who(),
            action: async (): Promise<unknown> =>
            {
                inBody = { ambient: useRequest(), answer: await client.directory.who() };
                return undefined;
            }
        }
    ];

    function serve(options: { register?: boolean } = {}): { app: App; failures: unknown[] }
    {
        const app = new App();
        if (options.register !== false)
        {
            register(app, api);
        }
        const failures: unknown[] = [];
        mountPages(app, {
            routes: table,
            clientDir: clientDir('typed'),
            csrf: { cookie: COOKIE },
            renderer: createPageRenderer(viewOver(table), table),
            onError: (error) => failures.push(error)
        });
        return { app, failures };
    }

    it('renders the api\'s answer with the visitor\'s own cookie, private, and dials nothing', async () =>
    {
        const { app } = serve();
        served.length = 0;
        const dialled = dial();

        const response = await get(app, '/typed-list', { cookie: 'visitor=alice' });

        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(await response.text()).toContain('VISITOR alice');
        expect(served).toEqual(['alice']);
        expect(dialled).not.toHaveBeenCalled();
    });

    it('answers a second visitor as herself, never with the first one\'s copy', async () =>
    {
        const { app } = serve();
        served.length = 0;
        dial();

        expect(await (await get(app, '/typed-list', { cookie: 'visitor=alice' })).text()).toContain('VISITOR alice');
        expect(await (await get(app, '/typed-list', { cookie: 'visitor=bob' })).text()).toContain('VISITOR bob');
        expect(served).toEqual(['alice', 'bob']);
    });

    it('lets a GUARD call the api, and answers the POST\'s walk exactly as the GET\'s', async () =>
    {
        const { app } = serve();
        served.length = 0;
        dial();

        const page = await get(app, '/guarded-list', { cookie: 'visitor=alice' });
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('VISITOR alice');

        const write = await post(app, '/guarded-list', 'alice');
        expect(write.status).toBe(303);
        expect(write.headers.get('location')).toBe('/guarded-list');

        const anonymous = await post(app, '/guarded-list');
        expect(anonymous.status).toBe(403);
    });

    it('lets an ACTION BODY read the live request and reach the api in process, as its own walk left it', async () =>
    {
        const { app } = serve();
        served.length = 0;
        inBody = { ambient: null, answer: null };
        const dialled = dial();

        const write = await post(app, '/sign', 'alice');

        expect(write.status).toBe(303);
        // The POST's authorizing walk installed the request and attached the bridge before the
        // body ran, so the body is inside the same request the guards were.
        expect(inBody.ambient).toBeInstanceOf(Request);
        expect(parseCookies(inBody.ambient as Request)['visitor']).toBe('alice');
        expect(inBody.answer).toEqual({ visitor: 'alice' });
        expect(served).toEqual(['alice']);
        expect(dialled).not.toHaveBeenCalled();
    });

    /** The same pages with no api registered anywhere: the named error, and no socket. */
    it('CONTROL: with the api registered on no App the loader takes the NAMED error, dialling nothing', async () =>
    {
        const { app, failures } = serve({ register: false });
        const dialled = dial();

        // A forged Host is the visitor's to set, so the page request carries an internal one:
        // a relative baseUrl must still resolve to nothing rather than to a socket.
        const response = await app.handle(new Request('http://127.0.0.1:9/typed-list', {
            headers: { accept: 'text/html', cookie: 'visitor=alice' }
        }));

        expect(response.status).toBe(500);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(failures).toHaveLength(1);
        expect((failures[0] as Error).message).toContain('no api is registered on this App or any enclosing request root');
        expect(dialled).not.toHaveBeenCalled();
    });
});

/** Identity consulted is identity stamped, and a shared render consults none. */
describe('the private stamp', () =>
{
    const readers: Array<Request | null> = [];
    const identityLoader = (args: RouteLoaderArgs): Promise<string> =>
    {
        readers.push(args.request);
        return Promise.resolve(args.request === null ? 'shared' : (parseCookies(args.request)['visitor'] ?? 'anonymous'));
    };
    const Name = (): MountNode =>
    {
        const data = useLoader<string>();
        return h('main', { id: 'name' }, () => `WHO ${ data.data() ?? '-' }`);
    };
    const component = (): HTMLElement => h('p', {}, 'plain');

    const table: PageRoute[] = [
        { path: '/reads', component: Name, render: 'server', loader: identityLoader },
        { path: '/quiet', component, render: 'server' },
        { path: '/shared', component: Name, render: 'static', revalidate: 300, loader: identityLoader }
    ];

    function serve(): App
    {
        const app = new App();
        mountPages(app, { routes: table, clientDir: clientDir('stamp'), renderer: createPageRenderer(viewOver(table), table) });
        return app;
    }

    it('marks an UNGUARDED page whose loader read the request', async () =>
    {
        const app = serve();
        readers.length = 0;

        const identity = await get(app, '/reads', { cookie: 'visitor=alice' });
        expect(identity.status).toBe(200);
        expect(await identity.text()).toContain('WHO alice');
        expect(identity.headers.get('cache-control')).toBe('private, no-store');
    });

    it('CONTROL: a page that never reads identity answers with the headers it answered with before', async () =>
    {
        const quiet = await get(serve(), '/quiet');
        expect(quiet.status).toBe(200);
        expect(quiet.headers.get('cache-control')).toBeNull();
        // By EQUALITY, so an over-eager stamp adds a name here and is caught rather than missed.
        expect([...quiet.headers.keys()].sort()).toEqual(['content-length', 'content-type', 'set-cookie']);
    });

    it('PAIR: an ISR page\'s loader sees null, and two visitors are served one anonymous copy', async () =>
    {
        const app = serve();
        readers.length = 0;

        const alice = await get(app, '/shared', { cookie: 'visitor=alice' });
        const bob = await get(app, '/shared', { cookie: 'visitor=bob' });

        expect(readers).toEqual([null]);
        expect(await alice.text()).toContain('WHO shared');
        expect(await bob.text()).toContain('WHO shared');
        expect(bob.headers.get('x-azeroth-cache')).toBe('hit');
    });
});

/** The dev topology: the api on the OUTER App, mountPages on an inner one. */
describe('dev parity: the api registered on an enclosing App', () =>
{
    const table: PageRoute[] = [
        { path: '/typed-list', component: Echo, render: 'server', loader: (): Promise<{ visitor: string }> => client.directory.who() }
    ];

    it('serves the page from the enclosing App\'s api, in process, exactly as production does', async () =>
    {
        // The nesting `devPages` builds: the session's own App carries the application's routes
        // (the api among them) and delegates every page url to the App that carries mountPages.
        const inner = new App();
        mountPages(inner, {
            routes: table,
            clientDir: clientDir('dev'),
            renderer: createPageRenderer(viewOver(table), table)
        });
        const outer = new App();
        register(outer, api);
        const delegate = (context: RequestContext): Promise<Response> => inner.handle(context.request);
        outer.get('/', delegate);
        outer.get('/*path', delegate);

        served.length = 0;
        const dialled = dial();
        const response = await get(outer, '/typed-list', { cookie: 'visitor=alice' });

        expect(response.status).toBe(200);
        expect(await response.text()).toContain('VISITOR alice');
        expect(served).toEqual(['alice']);
        expect(dialled).not.toHaveBeenCalled();
    });
});

/** Every SERVER guard walk holds the live request, so a fail-closed guard is not lied to. */
describe('every server guard walk carries the request', () =>
{
    const walks: Array<boolean> = [];
    const identityGuard = (context: { request: Request | null }): GuardVerdict =>
    {
        walks.push(context.request !== null);
        // FAIL CLOSED: null means the browser, which authorizes nothing.
        if (context.request === null)
        {
            return forbidden();
        }
        return parseCookies(context.request)['visitor'] === 'alice' ? true : unauthorized();
    };
    const component = (): HTMLElement => h('p', {}, 'page');
    const ran: string[] = [];

    const rendered: PageRoute[] = [
        {
            path: '/desk',
            component,
            render: 'server',
            guard: identityGuard,
            action: (): Promise<unknown> =>
            {
                ran.push('desk');
                return Promise.resolve(undefined);
            }
        }
    ];

    it('the POST\'s authorizing walk sees what the GET\'s walk saw, so the submitter is not refused', async () =>
    {
        const app = new App();
        mountPages(app, {
            routes: rendered,
            clientDir: clientDir('walk'),
            csrf: { cookie: COOKIE },
            renderer: createPageRenderer(viewOver(rendered), rendered)
        });
        walks.length = 0;
        ran.length = 0;

        const page = await get(app, '/desk');
        expect(page.status).toBe(401);

        const anonymous = await post(app, '/desk');
        expect(anonymous.status).toBe(401);
        expect(ran).toEqual([]);

        const submitter = await post(app, '/desk', 'alice');
        expect(submitter.status).toBe(303);
        expect(ran).toEqual(['desk']);
        // Not one walk of the three saw null, which is what "fail closed on null" relies on.
        expect(walks.every((live) => live)).toBe(true);
    });

    it('the renderer-less gate\'s own walk carries it too', async () =>
    {
        const table: PageRoute[] = [
            { path: '/files/*rest', component, guard: identityGuard },
            { path: '/files/:slug', component, render: 'static', staticParams: (): Promise<Array<{ slug: string }>> => Promise.resolve([{ slug: 'intro' }]) }
        ];
        const dir = clientDir('gate');
        mkdirSync(join(dir, 'files', 'intro'), { recursive: true });
        writeFileSync(join(dir, 'files', 'intro', 'index.html'), '<html><body>THE FILE</body></html>');
        const app = new App();
        const mounted: KitOptions = { routes: table, clientDir: dir };
        mountPages(app, mounted);
        walks.length = 0;

        const admitted = await get(app, '/files/intro', { cookie: 'visitor=alice' });
        expect(admitted.status).toBe(200);
        expect(await admitted.text()).toContain('THE FILE');
        expect(admitted.headers.get('cache-control')).toBe('private, no-store');

        const refused = await get(app, '/files/intro');
        expect(refused.status).toBe(401);
        expect(walks).toEqual([true, true]);
    });
});
