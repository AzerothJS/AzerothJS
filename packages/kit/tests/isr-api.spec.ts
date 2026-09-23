// @vitest-environment node
//
// An ISR render reaches the app's own api anonymously, from the App the pages are mounted on and
// in the async context they were mounted in. Node, because happy-dom supplies `location`.
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { RouterProvider, Routes, createMemoryHistory, createRouter, h, useLoader, useRequest } from 'azerothjs';
import type { LoaderHandoff, MountNode, RouteLoaderArgs } from 'azerothjs';
import { object, string } from '@azerothjs/schema';
import { App, UnauthorizedError, csrfCookie, edge, parseCookies, pipeline } from '@azerothjs/http';
import { lendApiRegistration } from '@azerothjs/http/internal';
import { serve } from '@azerothjs/http/node';
import { ApiError, createClient, feature, manifestOf, register, reply } from '@azerothjs/http/api';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import { prerender } from '@azerothjs/kit/prerender';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import type { PageRenderer } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';
/** The clause the client's error adds for an ISR render whose pages App has no api. */
const NAMED = /an ISR render of pages mounted on an App with no api registered on it .*App mountPages is given, never one on an enclosing App; under devPages, the api its routes callback registers\)/;
const ALICE = { cookie: 'who=alice', authorization: 'Bearer alice', 'x-forwarded-host': 'evil.example' };

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
    const dir = mkdtempSync(join(tmpdir(), 'az-israpi-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    dirs.push(dir);
    return dir;
}

const who = (request: Request): string => parseCookies(request)['who'] ?? 'anon';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

let reads = 0;
const served: string[] = [];
const stats = feature('/stats', (routes) => ({
    read: routes.get('/', { output: object({ n: string() }) }, () => ({ n: `k${ ++reads }` })),
    echo: routes.get('/echo', { output: object({ n: string() }) }, ({ request, url }) =>
    {
        const seen = `${ who(request) }.${ request.headers.get('authorization') === null ? 'noauth' : 'AUTH' }.${ url.hostname }`;
        served.push(seen);
        return { n: seen };
    }),
    lang: routes.get('/lang', { output: object({ n: string() }) }, ({ request }) => ({ n: `lang-${ request.headers.get('accept-language') ?? 'none' }` })),
    guest: routes.get('/guest', { output: object({ n: string() }) }, () =>
    {
        const id = `g${ Math.random().toString(36).slice(2, 8) }`;
        served.push(id);
        return reply(200, { n: id }, { 'set-cookie': `guest=${ id }; HttpOnly`, 'cache-control': 'private, no-store', vary: 'cookie' });
    }),
    priv: routes.get('/priv', { output: object({ n: string() }) }, () => reply(200, { n: 'pub-data' }, { 'cache-control': 'private, no-store' })),
    secret: routes.get('/secret', { output: object({ n: string() }) }, ({ request }) =>
    {
        if (who(request) === 'anon')
        {
            throw new UnauthorizedError('sign in');
        }
        return { n: `secret-${ who(request) }` };
    }),
    bump: routes.post('/bump', { output: object({ n: string() }) }, () => ({ n: 'bumped' }))
}));
const api = { stats };
const client = createClient<typeof api>(manifestOf(api), { baseUrl: '/api' });
/** The scaffold's server-side shape: no manifest, so each call finds its entry on the bridge. */
const hole = createClient<typeof api>({}, { baseUrl: '/api' });

/** A one-route api whose answer the arm decides; every copy serves the same path. */
const answering = (answer: () => string) => ({
    one: feature('/one', (routes) => ({ read: routes.get('/', { output: object({ n: string() }) }, () => ({ n: answer() })) }))
});
const reader = createClient<ReturnType<typeof answering>>(manifestOf(answering(() => '')), { baseUrl: '/api' });

/** The loader's data or ERRUI, and whether the render saw a request (R1) or not (R0). */
const Page = (): MountNode =>
{
    const data = useLoader<string>();
    const seen = useRequest() === null ? 'R0' : 'R1';
    return h('main', {}, () => (data.error() !== null ? 'ERRUI' : `N=${ data.data() ?? '' }|${ seen }`));
};

const viewOf = (table: PageRoute[]) => (props: { url?: string; handoff?: LoaderHandoff }): HTMLElement =>
    RouterProvider({
        router: createRouter({ routes: table, history: createMemoryHistory(props.url ?? '/'), initialLoaderData: props.handoff }),
        children: () => Routes({ fallback: () => h('h1', {}, 'nf') })
    }) as HTMLElement;

type Loader = (args: RouteLoaderArgs) => Promise<string>;

interface PageOptions
{
    revalidate?: number;
    extra?: Partial<PageRoute>;
    server?: string;
    dev?: boolean;
    locales?: boolean;
    dir?: string;
}

interface Mounted
{
    errors: unknown[];
    table: PageRoute[];
    dir: string;
    renderer: PageRenderer;
}

/** '/s' (or `server`) renders per request and '/b/:id' is an ISR page, both over the same loader. */
function pages(app: App, loader: Loader, options: PageOptions = {}): Mounted
{
    const table: PageRoute[] = [
        { path: options.server ?? '/s', component: Page, render: 'server', loader },
        { path: '/b/:id', component: Page, render: 'static', revalidate: options.revalidate ?? 30, loader, ...options.extra }
    ];
    const renderer = createPageRenderer(viewOf(table), table);
    const errors: unknown[] = [];
    const dir = options.dir ?? clientDir();
    const base = {
        routes: table,
        renderer,
        onError: (error: unknown): void => void errors.push(error),
        ...(options.locales === true ? { locales: { supported: ['en', 'fa'], routing: 'prefix' as const } } : {})
    };
    mountPages(app, options.dev === true ? { ...base, shell: SHELL } : { ...base, clientDir: dir });
    return { errors, table, dir, renderer };
}

/** An App with the stats api registered on it and the pages mounted on it. */
function site(loader: Loader, options: PageOptions & { noApi?: boolean } = {}): Mounted & { app: App }
{
    const app = new App();
    if (options.noApi !== true)
    {
        register(app, api);
    }
    return { app, ...pages(app, loader, options) };
}

/** "status cache-control x-azeroth-cache body" of one html GET. */
async function read(handler: { handle(request: Request): Promise<Response> }, path: string, headers: Record<string, string> = {}, host = 'site.test'): Promise<string>
{
    const response = await handler.handle(new Request(`http://${ host }${ path }`, { headers: { accept: 'text/html', ...headers } }));
    const main = /(N=[^<]*|ERRUI)/.exec(await response.text())?.[1];
    return `${ response.status } ${ response.headers.get('cache-control') } ${ response.headers.get('x-azeroth-cache') } ${ main }`;
}

describe('an ISR render reaches the app\'s own api anonymously', () =>
{
    it('misses then hits, with the full client and with the manifest-hole client', async () =>
    {
        for (const through of [client, hole])
        {
            const { app, errors } = site(async () => (await through.stats.read()).n);

            expect(await read(app, '/b/7')).toMatch(/^200 public.* miss N=k\d+\|R0$/);
            expect(await read(app, '/b/7')).toMatch(/^200 public.* hit N=k\d+\|R0$/);
            expect(errors).toEqual([]);
        }
    });

    it('serves bob the copy alice triggered, and her cookie, bearer and forged Host never reach the api', async () =>
    {
        const { app } = site(async () => (await client.stats.echo()).n);
        served.length = 0;

        expect(await read(app, '/b/2', ALICE, 'evil.example')).toMatch(/^200 public.* miss N=anon\.noauth\.localhost\|R0$/);
        expect(await read(app, '/b/2', { cookie: 'who=bob' })).toMatch(/^200 public.* hit N=anon\.noauth\.localhost\|R0$/);
        expect(served).toEqual(['anon.noauth.localhost']);
        // The per-request render beside it still forwards her identity, privately.
        expect(await read(app, '/s', ALICE)).toMatch(/^200 private, no-store .*N=alice\.AUTH\.site\.test\|R1$/);
    });

    it('coalesces two concurrent triggers on one anonymous render', async () =>
    {
        const { app } = site(async () => (await client.stats.echo()).n);
        const [first, second] = await Promise.all([read(app, '/b/3', ALICE, 'evil.example'), read(app, '/b/3', { cookie: 'who=bob' })]);

        expect(first).toMatch(/^200 public.* N=anon\.noauth\.localhost\|R0$/);
        expect(second).toMatch(/^200 public.* N=anon\.noauth\.localhost\|R0$/);
    });

    it('a guarded endpoint answers its own 401, so the page is 500 and never cached', async () =>
    {
        const { app, errors } = site(async () => (await client.stats.secret()).n);

        expect(await read(app, '/b/4', ALICE)).toBe('500 private, no-store null ERRUI');
        expect(await read(app, '/b/4', ALICE)).toBe('500 private, no-store null ERRUI');
        expect((errors[0] as { status?: number }).status).toBe(401);
        expect(await read(app, '/s', ALICE)).toMatch(/^200 private, no-store .*N=secret-alice\|R1$/);
    });

    it('args.request and useRequest() stay null, and the page caches', async () =>
    {
        const { app } = site(async ({ request }) => `${ request === null ? 'nullarg' : 'ARG' }-${ (await client.stats.read()).n }`);

        expect(await read(app, '/b/5', ALICE)).toMatch(/ miss N=nullarg-k\d+\|R0$/);
        expect(await read(app, '/b/5')).toMatch(/ hit N=nullarg-k\d+\|R0$/);
    });

    it('a regeneration alice trips reaches the api anonymously', async () =>
    {
        const { app, errors } = site(async () => `${ (await client.stats.read()).n }-${ (await client.stats.echo()).n }`, { revalidate: 1 });
        const first = await read(app, '/b/6');
        await sleep(1150);

        expect(await read(app, '/b/6', ALICE, 'evil.example')).toMatch(/ stale /);
        const fresh = await vi.waitFor(async () =>
        {
            const line = await read(app, '/b/6');
            expect(line).toMatch(/ hit N=k\d+-anon\.noauth\.localhost\|R0$/);
            return line;
        }, { timeout: 5000 });
        expect(fresh.split(' ').at(-1)).not.toBe(first.split(' ').at(-1));
        expect(errors).toEqual([]);
    });

    it('under prefix routing the api hears the page\'s language, never the visitor\'s', async () =>
    {
        const { app } = site(async () => (await client.stats.lang()).n, { locales: true });

        expect(await read(app, '/fa/b/1', { 'accept-language': 'en', cookie: 'who=alice' })).toMatch(/^200 public.* miss N=lang-fa\|R0$/);
        expect(await read(app, '/en/b/1', { 'accept-language': 'fa' })).toMatch(/^200 public.* miss N=lang-en\|R0$/);
    });

    it('refuses by name an answer that sets a cookie, and caches nothing', async () =>
    {
        const { app, errors } = site(async () => (await client.stats.guest()).n);

        expect(await read(app, '/b/12', ALICE)).toBe('500 private, no-store null ERRUI');
        expect(await read(app, '/b/12', { cookie: 'who=bob' })).toBe('500 private, no-store null ERRUI');
        expect(message(errors[0])).toMatch(/^GET \/api\/stats\/guest answered a shared render with a Set-Cookie \(guest\), /);
    });

    it('caches an answer marked private, no-store that sets no cookie', async () =>
    {
        const { app } = site(async () => (await client.stats.priv()).n);

        expect(await read(app, '/b/13')).toMatch(/^200 public.* miss N=pub-data\|R0$/);
        expect(await read(app, '/b/13')).toMatch(/^200 public.* hit N=pub-data\|R0$/);
    });

    it('refuses a write before it is dispatched', async () =>
    {
        const { app, errors } = site(async () => (await client.stats.bump()).n);

        expect(await read(app, '/b/14')).toBe('500 private, no-store null ERRUI');
        expect(message(errors[0])).toMatch(/^POST \/api\/stats\/bump cannot be served in process: the api bridge serves GET and HEAD only/);
    });

    it('with no api on the pages App the render fails closed and the error says where to register it', async () =>
    {
        const { app, errors } = site(async () => (await client.stats.read()).n, { noApi: true });

        expect(await read(app, '/b/15')).toBe('500 private, no-store null ERRUI');
        expect(message(errors[0])).toMatch(/no api is registered/);
        expect(message(errors[0])).toMatch(NAMED);
    });

    it('forwards no cookie, authorization, Host, Forwarded or x-forwarded-* header of the trigger', async () =>
    {
        const echo = {
            echo: feature('/echo', (routes) => ({
                read: routes.get('/', { output: object({ n: string() }) }, ({ request, url }) =>
                {
                    const names = [...request.headers.keys()].filter((name) => /forward|real-ip|connecting|cookie|authorization|x-evil/.test(name));
                    return { n: `${ who(request) }|${ request.headers.get('authorization') ?? 'noauth' }|${ url.host }|${ names.join('+') || 'none' }|${ request.headers.get('accept-language') ?? 'nolang' }` };
                })
            }))
        };
        const echoClient = createClient<typeof echo>(manifestOf(echo), { baseUrl: '/api' });
        const app = new App();
        register(app, echo);
        pages(app, async () => (await echoClient.echo.read()).n);
        const hostile = {
            cookie: 'who=alice; session=s3cr3t',
            authorization: 'Bearer alice',
            forwarded: 'for=1.2.3.4;host=evil.example;proto=https',
            'x-forwarded-host': 'evil.example',
            'x-forwarded-for': '1.2.3.4',
            'x-forwarded-proto': 'https',
            'x-real-ip': '1.2.3.4',
            'cf-connecting-ip': '1.2.3.4',
            'x-evil': '1',
            'accept-language': 'de'
        };

        expect(await read(app, '/b/1', hostile, 'evil.example:8443')).toMatch(/^200 public.* miss N=anon\|noauth\|localhost\|none\|nolang\|R0$/);
        expect(await read(app, '/b/1', { cookie: 'who=bob' })).toMatch(/^200 public.* hit N=anon\|noauth\|localhost\|none\|nolang\|R0$/);
        // The per-request bridge forwards cookie, authorization and accept-language.
        expect(await read(app, '/s', hostile, 'evil.example:8443'))
            .toMatch(/^200 private, no-store .*N=alice\|Bearer alice\|evil\.example:8443\|authorization\+cookie\|de\|R1$/);
    });

    it('a guarded chain on an ISR path reaches the api as its visitor, privately', async () =>
    {
        const loader = async (): Promise<string> => (await client.stats.echo()).n;
        const table: PageRoute[] = [
            { path: '/g/:slug', component: Page, render: 'client', guard: () => true, loader },
            { path: '/g/current', component: Page, render: 'static', revalidate: 30 }
        ];
        const app = new App();
        register(app, api);
        mountPages(app, { routes: table, renderer: createPageRenderer(viewOf(table), table), clientDir: clientDir() });

        expect(await read(app, '/g/current', ALICE)).toMatch(/^200 private, no-store live N=alice\.AUTH\.site\.test\|R1$/);
    });

    it('under shell a page renders as a production miss does, on every request', async () =>
    {
        const devSecret = site(async () => (await client.stats.secret()).n, { dev: true });
        const production = site(async () => (await client.stats.secret()).n);
        const devEcho = site(async () => (await client.stats.echo()).n, { dev: true });

        const refused = await read(devSecret.app, '/b/8', ALICE);
        expect(refused).toBe('500 private, no-store null ERRUI');
        expect(refused).toBe(await read(production.app, '/b/8', ALICE));
        expect(await read(devEcho.app, '/b/9', ALICE)).toMatch(/^200 public, max-age=0, must-revalidate miss N=anon\.noauth\.localhost\|R0$/);
        expect(await read(devEcho.app, '/b/9', ALICE)).toMatch(/^200 public, max-age=0, must-revalidate miss N=anon\.noauth\.localhost\|R0$/);
    });
});

describe('which App\'s api an ISR render reaches', () =>
{
    const tenantApi = (tenant: string): ReturnType<typeof answering> => answering(() => `data-of-${ tenant }`);

    /** Two tenant Apps, each with its own api, forward to one pages App; a front App routes on Host. */
    function tenants(revalidate: number, siteApi?: ReturnType<typeof answering>): { front: App; errors: unknown[] }
    {
        const pagesApp = new App();
        if (siteApi !== undefined)
        {
            register(pagesApp, siteApi);
        }
        const { errors } = pages(pagesApp, async () => (await reader.one.read()).n, { revalidate });
        const tenantA = new App();
        register(tenantA, tenantApi('A'));
        tenantA.get('/*path', (context) => pagesApp.handle(context.request));
        const tenantB = new App();
        register(tenantB, tenantApi('B'));
        tenantB.get('/*path', (context) => pagesApp.handle(context.request));
        const front = new App();
        front.get('/*path', (context) => (context.url.hostname === 'a.example' ? tenantA : tenantB).handle(context.request));
        return { front, errors };
    }

    it('never an enclosing App\'s: two tenants forwarding to one pages App are refused by name, both ways', async () =>
    {
        const { front, errors } = tenants(30);

        // Per request, each tenant's own api answers its own visitor.
        expect(await read(front, '/s', {}, 'a.example')).toMatch(/^200 private.*N=data-of-A\|R1$/);
        expect(await read(front, '/s', {}, 'b.example')).toMatch(/^200 private.*N=data-of-B\|R1$/);
        expect(await read(front, '/b/1', {}, 'a.example')).toBe('500 private, no-store null ERRUI');
        expect(await read(front, '/b/1', {}, 'b.example')).toBe('500 private, no-store null ERRUI');
        expect(await read(front, '/b/2', {}, 'b.example')).toBe('500 private, no-store null ERRUI');
        expect(await read(front, '/b/2', {}, 'a.example')).toBe('500 private, no-store null ERRUI');
        expect(errors).toHaveLength(4);
        for (const error of errors)
        {
            expect(message(error)).toMatch(NAMED);
        }
    });

    it('a regeneration one tenant trips fills nothing from its api', async () =>
    {
        const { front, errors } = tenants(1);

        expect(await read(front, '/b/3', {}, 'a.example')).toBe('500 private, no-store null ERRUI');
        await sleep(1150);
        expect(await read(front, '/b/3', {}, 'b.example')).toBe('500 private, no-store null ERRUI');
        expect(await read(front, '/b/3', {}, 'a.example')).toBe('500 private, no-store null ERRUI');
        expect(errors.map(message).every((text) => NAMED.test(text))).toBe(true);
    });

    it('the pages App\'s own api answers every tenant alike', async () =>
    {
        const { front } = tenants(30, tenantApi('S'));

        expect(await read(front, '/b/5', {}, 'a.example')).toMatch(/^200 public.* miss N=data-of-S\|R0$/);
        expect(await read(front, '/b/5', {}, 'b.example')).toMatch(/^200 public.* hit N=data-of-S\|R0$/);
    });

    it('an api only on the enclosing App is refused by name, while the per-request render reaches it', async () =>
    {
        const inner = new App();
        const { errors } = pages(inner, async () => (await client.stats.echo()).n);
        const outer = new App();
        register(outer, api);
        outer.get('/*path', (context) => inner.handle(context.request));

        expect(await read(outer, '/s')).toMatch(/^200 private.*N=anon\.noauth\.site\.test\|R1$/);
        expect(await read(outer, '/b/1')).toBe('500 private, no-store null ERRUI');
        expect(message(errors[0])).toMatch(NAMED);
    });

    it('a pages App lent the enclosing App\'s api reaches it, anonymously', async () =>
    {
        const inner = new App();
        const outer = new App();
        lendApiRegistration(inner, outer);
        pages(inner, async () => (await client.stats.echo()).n);
        register(outer, api);
        outer.get('/*path', (context) => inner.handle(context.request));

        expect(await read(outer, '/b/1', { cookie: 'who=alice' })).toMatch(/^200 public.* miss N=anon\.noauth\.localhost\|R0$/);
        expect(await read(outer, '/b/1', { cookie: 'who=bob' })).toMatch(/^200 public.* hit N=anon\.noauth\.localhost\|R0$/);
        expect(await read(outer, '/s', { cookie: 'who=alice' })).toMatch(/^200 private.*N=alice\.noauth\.site\.test\|R1$/);
    });
});

describe('a shared call that reaches a page instead of an api route', () =>
{
    const docs = feature('/docs', (routes) => ({ real: routes.get('/real', { output: object({ n: string() }) }, () => ({ n: 'real' })) }));
    const wider = feature('/docs', (routes) => ({
        real: routes.get('/real', { output: object({ n: string() }) }, () => ({ n: 'real' })),
        gone: routes.get('/gone', { output: object({ n: string() }) }, () => ({ n: 'gone' }))
    }));
    /** A stale manifest: it names a route register() never installed. */
    const stale = createClient<{ docs: typeof wider }>(manifestOf({ docs: wider }), { baseUrl: '/api' });
    const refusal = (path: string): RegExp => new RegExp(`^GET ${ path } reached a page instead of an api route, from a shared render\\.`);
    const REFUSED = refusal('/api/docs/gone');
    const FAILED = '500 private, no-store null ERRUI';

    /** A page that never answers reads HANG, so a wedge fails the arm rather than the run. */
    const answered = (app: App, path: string): Promise<string> =>
        Promise.race([read(app, path), new Promise<string>((resolve) => setTimeout(() => resolve('HANG'), 3000).unref())]);

    /** The loader of both page kinds; the cap stops a render that calls itself. */
    function stuck(): { loads: () => number; loader: Loader }
    {
        let loads = 0;
        return {
            loads: () => loads,
            loader: async () =>
            {
                if (++loads > 30)
                {
                    throw new Error('runaway');
                }
                return (await stale.docs.gone()).n;
            }
        };
    }

    it('is refused by name instead of landing on an ISR page that waits on its own render', async () =>
    {
        const app = new App();
        register(app, { docs });
        const { loads, loader } = stuck();
        const { errors } = pages(app, loader, { extra: { path: '/:a/:b/:c' } });

        expect(await answered(app, '/x/y/z')).toBe(FAILED);
        expect(await answered(app, '/x/y/z')).toBe(FAILED);
        expect(await answered(app, '/api/docs/gone')).toBe(FAILED);
        expect(loads()).toBe(3);
        expect(errors).toHaveLength(3);
        expect(errors.map(message).every((text) => REFUSED.test(text))).toBe(true);
    });

    it('is refused by name instead of landing on a per-request page that calls it again', async () =>
    {
        const app = new App();
        register(app, { docs });
        const { loads, loader } = stuck();
        const { errors } = pages(app, loader, { server: '/:a/:b/:c' });

        expect(await answered(app, '/b/1')).toBe(FAILED);
        expect(await answered(app, '/b/1')).toBe(FAILED);
        expect(loads()).toBe(2);
        expect(errors).toHaveLength(2);
        expect(errors.map(message).every((text) => REFUSED.test(text))).toBe(true);
    });

    it('still reaches a route the first of two register() calls installed', async () =>
    {
        const exact = createClient<{ docs: typeof docs }>(manifestOf({ docs }), { baseUrl: '/api' });
        const app = new App();
        register(app, { docs });
        register(app, api, { prefix: '/v2' });
        pages(app, async () => (await exact.docs.real()).n);

        expect(await read(app, '/b/1')).toMatch(/^200 public.* miss N=real\|R0$/);
    });

    it('reaches a route registered through an app.with() view', async () =>
    {
        const extra = { extra: feature('/extra', (routes) => ({ more: routes.get('/more', { output: object({ n: string() }) }, () => ({ n: 'more' })) })) };
        const app = new App();
        register(app, { docs });
        register(app.with(() => ({ db: 'pool' })), extra);
        const viewed = createClient<typeof extra>(manifestOf(extra), { baseUrl: '/api' });
        const { errors } = pages(app, async () => (await viewed.extra.more()).n);

        expect(await read(app, '/b/1')).toMatch(/^200 public.* miss N=more\|R0$/);
        expect(errors).toEqual([]);
    });

    /** An api answering GET <prefix>/docs/:id, and ISR pages at `paths` whose loader calls it. */
    function shadowed(prefix: string, paths: string[]): { app: App; loads: () => number; errors: unknown[] }
    {
        const byId = { docs: feature('/docs', (routes) => ({ one: routes.get('/:id', { output: object({ n: string() }) }, ({ params }) => ({ n: `api-${ params.id }` })) })) };
        const calls = createClient<typeof byId>(manifestOf(byId), { baseUrl: prefix });
        const app = new App();
        register(app, byId, { prefix });
        let loads = 0;
        const loader: Loader = async ({ params }) =>
        {
            loads++;
            return (await calls.docs.one({ params: { id: params.id ?? 'featured' } })).n;
        };
        const table = paths.map((path): PageRoute => ({ path, component: Page, render: 'static', revalidate: 30, loader }));
        const errors: unknown[] = [];
        mountPages(app, { routes: table, renderer: createPageRenderer(viewOf(table), table), clientDir: clientDir(), onError: (error: unknown): void => void errors.push(error) });
        return { app, loads: () => loads, errors };
    }

    it('is refused by name when a page\'s path shadows the api route it calls, and nothing is cached', async () =>
    {
        const { app, loads, errors } = shadowed('', ['/docs/featured', '/p/:id']);

        expect(await answered(app, '/p/1')).toMatch(/^200 public.* miss N=api-1\|R0$/);
        expect(await answered(app, '/p/featured')).toBe(FAILED);
        expect(await answered(app, '/p/featured')).toBe(FAILED);
        expect(await answered(app, '/docs/featured')).toBe(FAILED);
        expect(loads()).toBe(4);
        expect(errors).toHaveLength(3);
        expect(errors.map(message).every((text) => refusal('/docs/featured').test(text))).toBe(true);
        expect(await answered(app, '/p/2')).toMatch(/^200 public.* miss N=api-2\|R0$/);
    });

    it('is refused by name when an ISR page under the api prefix shadows the route it calls', async () =>
    {
        const { app, loads, errors } = shadowed('/api', ['/api/docs/featured']);

        expect(await answered(app, '/api/docs/featured')).toBe(FAILED);
        expect(await answered(app, '/api/docs/featured')).toBe(FAILED);
        expect(loads()).toBe(2);
        expect(errors).toHaveLength(2);
        expect(errors.map(message).every((text) => refusal('/api/docs/featured').test(text))).toBe(true);
    });
});

describe('the async context an ISR render runs in', () =>
{
    const meApi = (user: AsyncLocalStorage<string>): ReturnType<typeof answering> => answering(() => `me=${ user.getStore() ?? 'none' }`);

    /** "status cache-control x-azeroth-cache body" of one html GET over a real socket. */
    async function fetched(port: number, path: string): Promise<string>
    {
        const response = await fetch(`http://127.0.0.1:${ port }${ path }`, { headers: { accept: 'text/html' } });
        const main = /(N=[^<]*|ERRUI)/.exec(await response.text())?.[1];
        return `${ response.status } ${ response.headers.get('cache-control') } ${ response.headers.get('x-azeroth-cache') } ${ main }`;
    }

    it('a store a wrapper entered around the visitor\'s request reaches neither the loader\'s api call nor the entry', async () =>
    {
        const user = new AsyncLocalStorage<string>();
        const inner = new App();
        register(inner, meApi(user));
        pages(inner, async () => (await reader.one.read()).n);
        const outer = new App();
        outer.get('/*path', (context) => user.run(who(context.request), () => inner.handle(context.request)));

        expect(await read(outer, '/s', { cookie: 'who=alice' })).toMatch(/^200 private.*N=me=alice\|R1$/);
        expect(await read(outer, '/b/1', { cookie: 'who=alice' })).toMatch(/^200 public.* miss N=me=none\|R0$/);
        expect(await read(outer, '/b/1', { cookie: 'who=bob' })).toMatch(/^200 public.* hit N=me=none\|R0$/);
        expect(await read(outer, '/b/1')).toMatch(/ hit N=me=none\|R0$/);
    });

    it('a store the api App\'s own edge enters for a session cookie does not reach the shared call', async () =>
    {
        const user = new AsyncLocalStorage<string>();
        const app = new App();
        app.use(edge((next) => ({ handle: (request: Request) => (who(request) === 'anon' ? next.handle(request) : user.run(who(request), () => next.handle(request))) })));
        register(app, meApi(user));
        pages(app, async () => (await reader.one.read()).n);

        expect(await read(app, '/b/1', { cookie: 'who=alice' })).toMatch(/^200 public.* miss N=me=none\|R0$/);
        expect(await read(app, '/b/1', { cookie: 'who=bob' })).toMatch(/^200 public.* hit N=me=none\|R0$/);
    });

    it('a loader reading that store directly sees none of it', async () =>
    {
        const user = new AsyncLocalStorage<string>();
        const inner = new App();
        pages(inner, async () => `me=${ user.getStore() ?? 'none' }`);
        const outer = new App();
        outer.get('/*path', (context) => user.run(who(context.request), () => inner.handle(context.request)));

        expect(await read(outer, '/s', { cookie: 'who=alice' })).toMatch(/N=me=alice\|R1$/);
        expect(await read(outer, '/b/1', { cookie: 'who=alice' })).toMatch(/^200 public.* miss N=me=none\|R0$/);
        expect(await read(outer, '/b/1', { cookie: 'who=bob' })).toMatch(/^200 public.* hit N=me=none\|R0$/);
    });

    it('a regeneration alice trips runs outside her store too', async () =>
    {
        const user = new AsyncLocalStorage<string>();
        const inner = new App();
        register(inner, meApi(user));
        let renders = 0;
        pages(inner, async () => `${ ++renders }:${ (await reader.one.read()).n }:${ user.getStore() ?? 'none' }`, { revalidate: 1 });
        const outer = new App();
        outer.get('/*path', (context) => user.run(who(context.request), () => inner.handle(context.request)));

        expect(await read(outer, '/b/1')).toMatch(/^200 public.* miss N=1:me=none:none\|R0$/);
        await sleep(1150);
        expect(await read(outer, '/b/1', { cookie: 'who=alice' })).toMatch(/ stale /);
        await vi.waitFor(async () => expect(await read(outer, '/b/1', { cookie: 'who=bob' })).toMatch(/ hit N=2:me=none:none\|R0$/), { timeout: 5000 });
    });

    it('pages mounted inside the first request, under that visitor\'s store, render in no visitor\'s context', async () =>
    {
        const user = new AsyncLocalStorage<string>();
        let inner: App | undefined;
        const outer = new App();
        outer.get('/*path', (context) => user.run(who(context.request), () =>
        {
            if (inner === undefined)
            {
                inner = new App();
                register(inner, meApi(user));
                pages(inner, async () => `${ (await reader.one.read()).n }:${ user.getStore() ?? 'none' }`);
            }
            return inner.handle(context.request);
        }));

        expect(await read(outer, '/b/1', { cookie: 'who=alice' })).toMatch(/^200 public.* miss N=me=none:none\|R0$/);
        expect(await read(outer, '/b/2', { cookie: 'who=bob' })).toMatch(/^200 public.* miss N=me=none:none\|R0$/);
    });

    it('a store entered around the whole server, mount included, reaches the loader and the api', async () =>
    {
        const boot = new AsyncLocalStorage<string>();
        const lines = await boot.run('pool-1', async () =>
        {
            const app = new App();
            register(app, meApi(boot));
            pages(app, async () =>
            {
                const db = boot.getStore();
                if (db === undefined)
                {
                    throw new Error('no db handle in this context');
                }
                return `db=${ db }|${ (await reader.one.read()).n }`;
            });
            return [await read(app, '/s'), await read(app, '/b/1'), await read(app, '/b/1')];
        });

        expect(lines[0]).toMatch(/^200 private.*N=db=pool-1\|me=pool-1\|R1$/);
        expect(lines[1]).toMatch(/^200 public.* miss N=db=pool-1\|me=pool-1\|R0$/);
        expect(lines[2]).toMatch(/^200 public.* hit N=db=pool-1\|me=pool-1\|R0$/);
    });

    it('the same over a real socket, fetched from outside that store', async () =>
    {
        const boot = new AsyncLocalStorage<string>();
        const server = await boot.run('pool-2', () =>
        {
            const app = new App();
            register(app, meApi(boot));
            pages(app, async () => `db=${ boot.getStore() ?? 'none' }|${ (await reader.one.read()).n }`);
            return serve(app, { port: 0, hostname: '127.0.0.1', banner: false });
        });
        try
        {
            expect(await fetched(server.port, '/s')).toMatch(/N=db=pool-2\|me=pool-2\|R1$/);
            expect(await fetched(server.port, '/b/2')).toMatch(/^200 public.* miss N=db=pool-2\|me=pool-2\|R0$/);
        }
        finally
        {
            await server.shutdown({ gracePeriodMs: 100 });
        }
    });

    it('a store entered only around serve() does not reach it: the loader\'s own error, and nothing cached', async () =>
    {
        const boot = new AsyncLocalStorage<string>();
        const app = new App();
        const { errors } = pages(app, () =>
        {
            const db = boot.getStore();
            return db === undefined ? Promise.reject(new Error('no db handle in this context')) : Promise.resolve(`db=${ db }`);
        });
        const server = await boot.run('pool-S', () => serve(app, { port: 0, hostname: '127.0.0.1', banner: false }));
        try
        {
            expect(await fetched(server.port, '/s')).toMatch(/^200 private.*N=db=pool-S\|R1$/);
            expect(await fetched(server.port, '/b/1')).toBe('500 private, no-store null ERRUI');
            expect(await fetched(server.port, '/b/1')).toBe('500 private, no-store null ERRUI');
            expect(errors.map(message)).toEqual(['no db handle in this context', 'no db handle in this context']);
        }
        finally
        {
            await server.shutdown({ gracePeriodMs: 100 });
        }
    });

    it('a store entered before the pages are mounted reaches it though no request carries the store', async () =>
    {
        const boot = new AsyncLocalStorage<string>();
        const mounted = (): App =>
        {
            const app = new App();
            register(app, meApi(boot));
            pages(app, async () => `db=${ boot.getStore() ?? 'none' }|${ (await reader.one.read()).n }`);
            return app;
        };
        const aroundMount = boot.run('pool-M', mounted);
        // In a resource of its own, so the store stays out of the rest of this file.
        const enteredBefore = new AsyncResource('mount').runInAsyncScope(() =>
        {
            boot.enterWith('pool-E');
            return mounted();
        });

        expect(await read(aroundMount, '/s')).toMatch(/^200 private.*N=db=none\|me=none\|R1$/);
        expect(await read(aroundMount, '/b/1')).toMatch(/^200 public.* miss N=db=pool-M\|me=pool-M\|R0$/);
        expect(await read(enteredBefore, '/b/1')).toMatch(/^200 public.* miss N=db=pool-E\|me=pool-E\|R0$/);
    });
});

describe('csrfCookie and an ISR page\'s api call', () =>
{
    it('under app.use it mints nothing for the shared call, so the page caches, and a browser GET still gets its cookie', async () =>
    {
        const app = new App();
        app.use(csrfCookie({ secure: false }));
        register(app, api);
        const { errors } = pages(app, async () => (await client.stats.priv()).n);

        expect(await read(app, '/s')).toMatch(/^200 private.*N=pub-data\|R1$/);
        expect(await read(app, '/b/1')).toMatch(/^200 public.* miss N=pub-data\|R0$/);
        expect(await read(app, '/b/1', { cookie: 'azcsrf=abcdefghijklmnopqrstuvwxyz0123456789' })).toMatch(/^200 public.* hit N=pub-data\|R0$/);
        expect(errors).toEqual([]);
        const wire = await app.handle(new Request('http://site.test/api/stats/priv'));
        expect(wire.headers.getSetCookie().join(',')).toMatch(/^azcsrf=/);
    });

    it('composed with pipeline() around the App it never sees the shared call', async () =>
    {
        const app = new App();
        register(app, api);
        pages(app, async () => (await client.stats.priv()).n);
        const front = pipeline(app, csrfCookie({ secure: false }));

        expect(await read(front, '/b/1')).toMatch(/^200 public.* miss N=pub-data\|R0$/);
        expect(await read(front, '/b/1')).toMatch(/^200 public.* hit N=pub-data\|R0$/);
    });

    it('under app.use an endpoint that sets its own cookie is still refused by name', async () =>
    {
        const app = new App();
        app.use(csrfCookie({ secure: false }));
        register(app, api);
        const { errors } = pages(app, async () => (await client.stats.guest()).n);

        expect(await read(app, '/b/1')).toBe('500 private, no-store null ERRUI');
        expect(message(errors[0])).toMatch(/answered a shared render with a Set-Cookie \(guest\), /);
    });

    it('behind an edge that rebuilds the Request it mints for the shared call, and the refusal names the cookie and the edge layer', async () =>
    {
        const app = new App();
        app.use(edge((next) => ({ handle: (request: Request) => next.handle(new Request(request)) })));
        app.use(csrfCookie({ secure: false }));
        register(app, api);
        const { errors } = pages(app, async () => (await client.stats.priv()).n);

        expect(await read(app, '/b/1')).toBe('500 private, no-store null ERRUI');
        expect(message(errors[0])).toMatch(/^GET \/api\/stats\/priv answered a shared render with a Set-Cookie \(azcsrf\), .*middleware or edge layer under app\.use/);
    });
});

describe('the build says what the loader rejected with', () =>
{
    it('a prerendered ISR page that calls the api names the loader\'s error, the fixes and the cause', async () =>
    {
        for (const through of [client, hole])
        {
            for (const extra of [{ staticParams: (): Promise<Array<Record<string, string>>> => Promise.resolve([{ id: '7' }]) }, { path: '/p' }])
            {
                const { dir, table, renderer } = pages(new App(), async () => (await through.stats.read()).n, { revalidate: 1, extra });
                const error = await prerender({ routes: table, clientDir: dir, renderer }).then(() => null, (reason: unknown) => reason as Error);

                expect(error?.message).toMatch(/could not load its data .*The loader said: (The relative baseUrl "\/api" means "this origin"|The api group "stats" is not in the manifest)/s);
                expect(error?.message).toMatch(/leave the page's params out of staticParams so a request renders it, read its data without the client, or render it with render: 'server'/);
                expect(error?.cause).toBeInstanceOf(Error);
            }
        }
        // A loader that stays local still builds.
        const local = pages(new App(), () => Promise.resolve('local'), { revalidate: 1, extra: { path: '/p' } });
        expect(await prerender({ routes: local.table, clientDir: local.dir, renderer: local.renderer })).toContain('/p');
    });

    it('every rejected value reads as text, never empty, "undefined" or [object Object]', async () =>
    {
        const cycle: { self?: unknown } = {};
        cycle.self = cycle;
        /** A message class field left undefined. */
        class Bare extends Error
        {
            public override message = undefined as unknown as string;
        }
        const reasons: unknown[] = [undefined, null, { code: 42 }, 'plain words', new Error(), new TypeError('  '), '', ' ',
            { toJSON: (): undefined => undefined }, 10n, cycle, (): undefined => undefined, Symbol('s'),
            Object.assign(new Error('x'), { message: undefined }), new Bare('x'), Object.assign(new Error('x'), { message: 42 }),
            Object.assign(new Error(), { name: undefined })];
        const said: string[] = [];
        for (const reason of reasons)
        {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a rejection that is not an Error IS the case under test
            const { dir, table, renderer } = pages(new App(), () => Promise.reject(reason), { revalidate: 1, extra: { path: '/p' } });
            const error = await prerender({ routes: table, clientDir: dir, renderer }).then(() => null, (thrown: unknown) => thrown as Error);

            expect(error?.message).toMatch(/could not load its data/);
            expect(error?.message).not.toMatch(/undefined|\[object Object\]/);
            said.push(error?.message.split('The loader said: ')[1] ?? '');
        }
        expect(said).toEqual(['it rejected without a reason', 'it rejected without a reason', '{"code":42}', 'plain words',
            'Error with no message', 'TypeError with no message', 'it rejected with an empty string', 'it rejected with an empty string',
            '{ toJSON: [Function: toJSON] }', '10n', '<ref *1> { self: [Circular *1] }', '[Function (anonymous)]', 'Symbol(s)',
            'Error with no message', 'Error with no message', 'Error with no message', 'Error with no message']);
    });

    it('a failure the loader swallowed at build seeds its fallback, and the first regeneration replaces it', async () =>
    {
        const loader: Loader = async () =>
        {
            try
            {
                return (await client.stats.read()).n;
            }
            catch (error)
            {
                // Only the build's failure: an api answer at runtime must not cache the placeholder.
                if (error instanceof ApiError)
                {
                    throw error;
                }
                return 'FALLBACK';
            }
        };
        const built = pages(new App(), loader, { revalidate: 1, extra: { path: '/p' } });
        await prerender({ routes: built.table, clientDir: built.dir, renderer: built.renderer });
        expect(readFileSync(join(built.dir, 'p', 'index.html'), 'utf8')).toContain('FALLBACK');

        const { app } = site(loader, { revalidate: 1, extra: { path: '/p' }, dir: built.dir });
        expect(await read(app, '/p')).toMatch(/N=FALLBACK\|/);
        await sleep(1150);
        expect(await read(app, '/p')).toMatch(/ stale N=FALLBACK\|/);
        await vi.waitFor(async () => expect(await read(app, '/p')).toMatch(/ hit N=k\d+\|R0$/), { timeout: 5000 });
    });
});
