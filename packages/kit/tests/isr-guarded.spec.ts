// @vitest-environment node
//
// A guard-carrying page must never be served from a shared cache. Guards run inside the
// renderer, so a cached copy answers without consulting them and carries the first
// visitor's loader data verbatim; these arms pin the four refusals that close that hole:
// the mount-time throw for a guarded static chain, the per-URL guarded gate ahead of the
// cache/seed/inflight, the result stamp the cache layers refuse, and the
// `private, no-store` headers on every guarded answer. Request identity rides an app
// AsyncLocalStorage, which a per-request render sees and a shared ISR render does not.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { RouterProvider, Routes, createMemoryHistory, createRouter, h, redirect } from 'azerothjs';
import type { LoaderHandoff, Route } from 'azerothjs';
import { guardedMatch } from 'azerothjs/internal';
import { App } from '@azerothjs/http';
import { mountPages, type PageCache, type PageEntry, type PageRoute } from '@azerothjs/kit';
import { prerender } from '@azerothjs/kit/prerender';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import type { PageRenderOptions, PageRenderer, PageResult } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';
const BUILD_ID = createHash('sha256').update(SHELL).digest('hex').slice(0, 16);

const identity = new AsyncLocalStorage<string>();
const who = (): string => identity.getStore() ?? 'anon';

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});
afterEach(() =>
{
    vi.restoreAllMocks();
});

function makeClientDir(): string
{
    const dir = mkdtempSync(join(tmpdir(), 'az-isrg-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    // The shell the mount reads, so an arm may write a prerendered home over index.html.
    writeFileSync(join(dir, 'shell.html'), SHELL);
    dirs.push(dir);
    return dir;
}

/** A PageCache that records every write, so "never cached" is an assertion, not a hope. */
function recordingCache(): PageCache & { sets: string[]; entries: Map<string, PageEntry> }
{
    const entries = new Map<string, PageEntry>();
    const sets: string[] = [];
    return {
        entries,
        sets,
        get: (key) => Promise.resolve(entries.get(key)),
        set: (key, entry) =>
        {
            sets.push(key);
            entries.set(key, entry);
            return Promise.resolve();
        },
        delete: (key) =>
        {
            entries.delete(key);
            return Promise.resolve();
        }
    };
}

function appFor(routes: Route[]): (props: { url?: string; handoff?: LoaderHandoff }) => HTMLElement
{
    return (props) => RouterProvider({
        router: createRouter({ routes, history: createMemoryHistory(props.url ?? '/'), initialLoaderData: props.handoff }),
        children: () => Routes({ fallback: () => h('h1', {}, 'not found') })
    }) as HTMLElement;
}

interface Rig
{
    app: App;
    cache: ReturnType<typeof recordingCache>;
    dir: string;
    renders: () => number;
    release: () => void;
    errors: Array<{ error: unknown; path: string; phase: string }>;
}

/**
 * mountPages over ONE table (`pages`), rendered by the REAL createPageRenderer - by
 * default over the same table, or over `rendererRoutes` for the mismatch arms. The counting
 * wrapper drops the renderer's own predicate; `direct` mounts the renderer as production does,
 * `renderer` mounts one written by hand, and `from` is a restart over an earlier rig's dir and
 * cache.
 */
function build(pages: PageRoute[], options: { rendererRoutes?: Route[]; onError?: false; holdFirstRender?: boolean; locales?: { supported: string[]; routing?: 'prefix' }; direct?: boolean; renderer?: PageRenderer; from?: Rig } = {}): Rig
{
    const dir = options.from?.dir ?? makeClientDir();
    const cache = options.from?.cache ?? recordingCache();
    const routes = options.rendererRoutes ?? pages;
    let count = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) =>
    {
        release = resolve;
    });
    const real = createPageRenderer(appFor(routes), routes);
    const renderer: PageRenderer = async (url, shell, renderOptions) =>
    {
        count++;
        if (options.holdFirstRender === true && count === 1)
        {
            await held;
        }
        return real(url, shell, renderOptions);
    };
    const errors: Rig['errors'] = [];
    const app = new App();
    mountPages(app, {
        routes: pages,
        clientDir: dir,
        renderer: options.renderer ?? (options.direct === true ? real : renderer),
        cache,
        ...(options.locales !== undefined ? { locales: options.locales } : {}),
        ...(options.onError === false
            ? {}
            : { onError: (error, context): void => void errors.push({ error, path: context.path, phase: context.phase }) })
    });
    return { app, cache, dir, renders: () => count, release, errors };
}

const as = (user: string, app: App, path: string, init?: RequestInit): Promise<Response> =>
    identity.run(user, () => app.handle(new Request(`http://local${ path }`, init)));

async function settle(ms = 25): Promise<void>
{
    await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Status, cache verdict, cache-control and the markers the body carries, as one line. */
async function lineOf(response: Response): Promise<string>
{
    const markers = new Set((await response.text()).match(/(?:SEEDED|OLD|PRIVATE-BALANCE|OPEN|NEWS)-\w+/g) ?? []);
    return `${ response.status } ${ response.headers.get('x-azeroth-cache') ?? '-' } ${ response.headers.get('cache-control') ?? '-' } ${ [...markers].join('+') || '-' }`;
}

const component = (): HTMLElement => h('div', {}, 'page');

/** What a guard that reads the session throws in a shared render, which has none. */
const nullRequest = (): never =>
{
    throw new TypeError('no session to read');
};

/**
 * The foreign-chain shape: `/docs/:slug` is declared FIRST (selection is order-first), is
 * guarded on the ambient identity, and loads that identity's private balance; the ISR page
 * `/docs/current` is unguarded on its OWN chain, so it mounts - but the router selects the
 * guarded `:slug` chain for its URL, while the http kernel's specificity dispatch still
 * hands the request to the ISR handler. Exactly the divergence the per-URL gate exists for.
 */
function foreignChain(): PageRoute[]
{
    return [
        {
            path: '/docs/:slug',
            render: 'client',
            component,
            guard: () => who() === 'alice',
            loader: () => Promise.resolve(`PRIVATE-BALANCE-${ who() }`)
        },
        { path: '/docs/current', render: 'static', revalidate: 60, component },
        { path: '/about', render: 'static', revalidate: 60, component }
    ];
}

describe('guarded gate: the repro pin', () =>
{
    it('a vetoed visitor gets her OWN outcome, the guard runs per request, and the first visitor\'s data never reaches her', async () =>
    {
        const rig = build(foreignChain());

        const alice = await as('alice', rig.app, '/docs/current');
        expect(alice.status).toBe(200);
        expect(alice.headers.get('x-azeroth-cache')).toBe('live');
        expect(await alice.text()).toContain('PRIVATE-BALANCE-alice');

        // Pre-fix: 200 `hit` carrying alice's balance, guard never run - the cache bypass.
        const mallory = await as('mallory', rig.app, '/docs/current');
        expect(mallory.status).toBe(403);
        expect(await mallory.text()).not.toContain('PRIVATE-BALANCE-alice');

        const again = await as('alice', rig.app, '/docs/current');
        expect(again.headers.get('x-azeroth-cache')).toBe('live');
        expect(await again.text()).toContain('PRIVATE-BALANCE-alice');
        expect(rig.cache.sets).toEqual([]);
    });

    it('two concurrent cold requests each get their own render - no shared flight', async () =>
    {
        const rig = build(foreignChain());
        const [alice, mallory] = await Promise.all([
            as('alice', rig.app, '/docs/current'),
            as('mallory', rig.app, '/docs/current')
        ]);
        expect(alice.status).toBe(200);
        expect(await alice.text()).toContain('PRIVATE-BALANCE-alice');
        expect(mallory.status).toBe(403);
        expect(await mallory.text()).not.toContain('alice');
        expect(rig.renders()).toBe(2);
        expect(rig.cache.sets).toEqual([]);
    });

    it('never cached: N requests render N times with live/no-store headers, and the policy is reported once', async () =>
    {
        const rig = build(foreignChain());
        for (let i = 0; i < 3; i++)
        {
            const response = await as('alice', rig.app, '/docs/current');
            expect(response.headers.get('x-azeroth-cache')).toBe('live');
            expect(response.headers.get('cache-control')).toBe('private, no-store');
        }
        expect(rig.renders()).toBe(3);
        expect(rig.cache.sets).toEqual([]);
        const policy = rig.errors.filter((entry) => (entry.error as Error).message.includes('guarded route chain'));
        expect(policy).toHaveLength(1);
        expect((policy[0]?.error as Error).message).toContain('not a failure');
    });

    it('an unguarded sibling on the same mount still caches', async () =>
    {
        const rig = build(foreignChain());
        const first = await as('anon', rig.app, '/about');
        expect(first.headers.get('x-azeroth-cache')).toBe('miss');
        const second = await as('anon', rig.app, '/about');
        expect(second.headers.get('x-azeroth-cache')).toBe('hit');
        expect(rig.cache.sets).toEqual(['/about']);
    });

    it('a seed file for a guarded URL is never read into the cache', async () =>
    {
        const pages = foreignChain();
        const rig = build(pages);
        mkdirSync(join(rig.dir, 'docs', 'current'), { recursive: true });
        writeFileSync(join(rig.dir, 'docs', 'current', 'index.html'), '<html><body>SEEDED-GUARDLESS</body></html>');

        const response = await as('alice', rig.app, '/docs/current');
        expect(response.headers.get('x-azeroth-cache')).toBe('live');
        expect(await response.text()).not.toContain('SEEDED-GUARDLESS');
        expect(rig.cache.sets).toEqual([]);
    });
});

describe('mount refusal: a guarded static chain fails the deploy', () =>
{
    const expectThrow = (pages: PageRoute[], naming: string): void =>
    {
        const app = new App();
        expect(() => mountPages(app, {
            routes: pages,
            clientDir: makeClientDir(),
            renderer: () => Promise.resolve({ kind: 'html', html: '', status: 200 })
        })).toThrow(new RegExp(`guarded at "${ naming.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }"`));
    };

    it('plain static, enumerated static, and ISR - wildcard ISR included - all refuse, naming the guard-carrying route', () =>
    {
        expectThrow([{ path: '/x', render: 'static', component, guard: () => true }], '/x');
        expectThrow([{
            path: '/y/:id',
            render: 'static',
            component,
            guard: () => true,
            staticParams: () => Promise.resolve([{ id: 'a' }])
        }], '/y/:id');
        expectThrow([{ path: '/z', render: 'static', revalidate: 60, component, guard: () => true }], '/z');
        expectThrow([{ path: '/w/*rest', render: 'static', revalidate: 60, component, guard: () => true }], '/w/*rest');
    });

    it('a guarded PARENT poisons its static child, and the error names the parent', () =>
    {
        expectThrow([{
            path: '/admin',
            component,
            guard: () => true,
            children: [{ path: 'report', render: 'static', component }]
        }], '/admin');
    });

    it('the exemptions: wildcard-static without revalidate (never serves files) and guarded server pages mount fine', () =>
    {
        const app = new App();
        expect(() => mountPages(app, {
            routes: [
                { path: '/w/*rest', render: 'static', component, guard: () => true },
                { path: '/s', render: 'server', component, guard: () => true }
            ],
            clientDir: makeClientDir(),
            renderer: () => Promise.resolve({ kind: 'html', html: '', status: 200 })
        })).not.toThrow();
    });
});

describe('prerender refusal: declaration-based, verdict irrespective', () =>
{
    it('a guard that PASSES at build time still fails the build, naming the guard-carrying route', async () =>
    {
        const routes: PageRoute[] = [{ path: '/x', render: 'static', component, guard: () => true }];
        await expect(prerender({
            routes,
            clientDir: makeClientDir(),
            renderer: createPageRenderer(appFor(routes), routes)
        })).rejects.toThrow(/guarded at "\/x"/);
    });
});

describe('mismatch rig: the renderer was built over a DIFFERENT table (docs forbid it; the stamp leg still holds)', () =>
{
    // Mount table: '/m' is a plain unguarded ISR page, so the predicate sees no guard.
    // Renderer table: the same path IS guarded - only the stamp can speak.
    const mountTable = (): PageRoute[] => [{ path: '/m', render: 'static', revalidate: 0.01, component }];
    const rendererTable = (): Route[] => [{
        path: '/m',
        component,
        guard: () => who() === 'alice',
        loader: () => Promise.resolve(`PRIVATE-BALANCE-${ who() }`)
    }];

    /** A guarded entry in the persistent cache under the CURRENT build, and its seed on disk. */
    const poison = (rig: Rig): void =>
    {
        mkdirSync(join(rig.dir, 'm'), { recursive: true });
        writeFileSync(join(rig.dir, 'm', 'index.html'), '<html><body>SEEDED-GUARDLESS</body></html>');
        utimesSync(join(rig.dir, 'm', 'index.html'), new Date(0), new Date(0));
        rig.cache.entries.set('/m', { html: '<html><body>OLD-PRIVATE</body></html>', status: 200, createdAt: 0, build: BUILD_ID });
    };

    it('a poisoned stale entry serves ONCE, the vetoed refresh learns and drops it, and the seed file never resurrects it', async () =>
    {
        const rig = build(mountTable(), { rendererRoutes: rendererTable() });
        poison(rig);

        const stale = await as('alice', rig.app, '/m');
        expect(stale.headers.get('x-azeroth-cache')).toBe('stale');
        expect(await stale.text()).toContain('OLD-PRIVATE');
        await settle();

        // The shared refresh has no visitor, so the renderer's guard vetoes it. The veto is the
        // discovery: learned before the drop, so the seed file is never read again.
        expect(rig.cache.entries.has('/m')).toBe(false);
        const next = await as('mallory', rig.app, '/m');
        expect(next.status).toBe(403);
        expect(next.headers.get('x-azeroth-cache')).toBe('live');
        const body = await next.text();
        expect(body).not.toContain('OLD-PRIVATE');
        expect(body).not.toContain('SEEDED-GUARDLESS');
        const again = await as('alice', rig.app, '/m');
        expect(again.status).toBe(200);
        expect(await again.text()).toContain('PRIVATE-BALANCE-alice');
        expect(rig.cache.sets).toEqual([]);
    });

    it('a guard that redirects the refresh, and a guarded loader that fails in it, are discoveries too', async () =>
    {
        const redirecting: Route[] = [{ path: '/m', component, guard: () => (who() === 'alice' ? true : '/login') }];
        const failing: Route[] = [{
            path: '/m',
            component,
            guard: () => who() !== 'mallory',
            loader: () => (who() === 'anon' ? Promise.reject(new Error('no session')) : Promise.resolve(`PRIVATE-BALANCE-${ who() }`))
        }];
        for (const [routes, refused] of [[redirecting, 302], [failing, 403]] as const)
        {
            const rig = build(mountTable(), { rendererRoutes: routes });
            poison(rig);
            expect(await (await as('alice', rig.app, '/m')).text()).toContain('OLD-PRIVATE');
            await settle();
            const next = await as('mallory', rig.app, '/m');
            expect(next.status).toBe(refused);
            expect(next.headers.get('x-azeroth-cache')).toBe('live');
            expect(await next.text()).not.toMatch(/OLD-PRIVATE|SEEDED-GUARDLESS/);
            expect(rig.cache.entries.has('/m')).toBe(false);
        }
    });

    it('coalesced discovery: the vetoed shared render answers no one, so the creator and the joiner each render under their own identity', async () =>
    {
        const rig = build(mountTable(), { rendererRoutes: rendererTable(), holdFirstRender: true });
        // Alice's cold request enters produce and BLOCKS inside the renderer - the flight
        // stays open, nothing is learned yet, so mallory's request passes the gate and
        // provably JOINS the same flight before releasing the barrier.
        const alicePromise = as('alice', rig.app, '/m');
        await settle();
        const malloryPromise = as('mallory', rig.app, '/m');
        await settle();
        rig.release();
        const [alice, mallory] = await Promise.all([alicePromise, malloryPromise]);

        // One shared render that found the guard, then one live render per waiter; nothing cached.
        expect(alice.status).toBe(200);
        expect(await alice.text()).toContain('PRIVATE-BALANCE-alice');
        expect(mallory.status).toBe(403);
        expect(await mallory.text()).not.toContain('alice');
        expect(rig.renders()).toBe(3);
        expect(rig.cache.sets).toEqual([]);
    });

    it('coalesced discovery with a guard that passes anonymously: the stamp keeps it out of the cache and both waiters render live', async () =>
    {
        // The produce-site stamp check is the only thing between this render and the cache.
        const open: Route[] = [{ path: '/m', component, guard: () => true, loader: () => Promise.resolve(`PRIVATE-BALANCE-${ who() }`) }];
        const rig = build(mountTable(), { rendererRoutes: open, holdFirstRender: true });
        const alicePromise = as('alice', rig.app, '/m');
        await settle();
        const malloryPromise = as('mallory', rig.app, '/m');
        await settle();
        rig.release();
        const [alice, mallory] = await Promise.all([alicePromise, malloryPromise]);
        expect(alice.status).toBe(200);
        expect(alice.headers.get('x-azeroth-cache')).toBe('live');
        expect(await alice.text()).toContain('PRIVATE-BALANCE-alice');
        expect(mallory.headers.get('x-azeroth-cache')).toBe('live');
        expect(mallory.headers.get('cache-control')).toBe('private, no-store');
        expect(rig.renders()).toBe(3);
        expect(rig.cache.sets).toEqual([]);
    });

    it('under prefix routing a discovery in one language covers the page in every language', async () =>
    {
        const rig = build(mountTable(), { rendererRoutes: rendererTable(), locales: { supported: ['en', 'fa'], routing: 'prefix' } });
        mkdirSync(join(rig.dir, 'm'), { recursive: true });
        for (const tag of ['en', 'fa'])
        {
            writeFileSync(join(rig.dir, 'm', `index.${ tag }.html`), `<html data-azeroth-base="/${ tag }"><body>SEEDED-${ tag }</body></html>`);
            utimesSync(join(rig.dir, 'm', `index.${ tag }.html`), new Date(0), new Date(0));
        }
        expect(await (await as('anon', rig.app, '/fa/m')).text()).toContain('SEEDED-fa');
        await settle();
        const en = await as('anon', rig.app, '/en/m');
        expect(en.status).toBe(403);
        expect(en.headers.get('x-azeroth-cache')).toBe('live');
        expect(await en.text()).not.toContain('SEEDED');
    });

    it('REVERSE mismatch: predicate fires, result is unstamped - the handler\'s own headers still hold', async () =>
    {
        // Mount table carries the guarded foreign chain; the renderer's table has NO guard,
        // so nothing stamps. The headers must be the handler's, not the stamp's.
        const pages = foreignChain();
        const guardless: Route[] = [
            { path: '/docs/:slug', component, loader: () => Promise.resolve('public') },
            { path: '/docs/current', component },
            { path: '/about', component }
        ];
        const rig = build(pages, { rendererRoutes: guardless });
        const response = await as('anon', rig.app, '/docs/current');
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.get('x-azeroth-cache')).toBe('live');
        expect(rig.cache.sets).toEqual([]);
    });
});

const seedAt = (rig: Rig, file: string, text: string, fresh = false): void =>
{
    mkdirSync(join(rig.dir, file, '..'), { recursive: true });
    writeFileSync(join(rig.dir, file), text);
    if (!fresh)
    {
        utimesSync(join(rig.dir, file), new Date(0), new Date(0));
    }
};
const loader = (): Promise<string> => Promise.resolve(`PRIVATE-BALANCE-${ who() }`);
const LIVE_403 = '403 live private, no-store -';
const LIVE_ALICE = '200 live private, no-store PRIVATE-BALANCE-alice';

describe('the renderer\'s own table: a guard only it declares, as production mounts the renderer', () =>
{
    const guardedM: Route[] = [{ path: '/m', component, guard: () => who() === 'alice', loader }];

    it('answers every visitor live from the first request, whatever the guard does to a shared render', async () =>
    {
        // `/m`'s guard throws on the null request a shared render carries; `/p`'s lets anonymous
        // visitors in.
        const rendererRoutes: Route[] = [
            { path: '/m', component, guard: ({ request }) => (request === null ? nullRequest() : who() === 'alice'), loader },
            { path: '/p', component, guard: () => who() !== 'mallory', loader }
        ];
        const pages: PageRoute[] = [
            { path: '/m', render: 'static', revalidate: 60, component },
            { path: '/p', render: 'static', revalidate: 60, component }
        ];
        const rig = build(pages, { rendererRoutes, direct: true });
        seedAt(rig, 'm/index.html', '<html><body>SEEDED-FRESH</body></html>', true);
        seedAt(rig, 'p/index.html', '<html><body>SEEDED-OPEN</body></html>', true);
        rig.cache.entries.set('/m', { html: '<html><body>OLD-PRIVATE</body></html>', status: 200, createdAt: 0, build: BUILD_ID });

        const [alice, mallory] = await Promise.all([as('alice', rig.app, '/m'), as('mallory', rig.app, '/m')]);
        expect(await lineOf(alice)).toBe(LIVE_ALICE);
        expect(await lineOf(mallory)).toBe(LIVE_403);
        for (const spelling of ['/m', '/m/', '/%6D'])
        {
            expect(await lineOf(await as('anon', rig.app, spelling)), spelling).toBe(LIVE_403);
        }
        expect(await lineOf(await as('anon', rig.app, '/p'))).toBe('200 live private, no-store PRIVATE-BALANCE-anon');
        expect(await lineOf(await as('mallory', rig.app, '/p'))).toBe(LIVE_403);
        expect(rig.cache.sets).toEqual([]);
    });

    it('answers HEAD, conditional and query requests live, and its file url answers 404 to each', async () =>
    {
        const rig = build([{ path: '/m', render: 'static', revalidate: 0.01, component }], { rendererRoutes: guardedM, direct: true });
        seedAt(rig, 'm/index.html', '<html><body>SEEDED-GUARDLESS</body></html>');
        const page: Array<[string, RequestInit?]> = [
            ['/m', { method: 'HEAD' }],
            ['/m', { headers: { 'if-none-match': '*' } }],
            ['/m', { headers: { 'if-modified-since': 'Fri, 01 Jan 2100 00:00:00 GMT' } }],
            ['/m?x=1'],
            ['/m?'],
            ['/m/?a=1']
        ];
        for (const [path, init] of page)
        {
            expect(await lineOf(await as('anon', rig.app, path, init)), path).toBe(LIVE_403);
        }
        expect((await lineOf(await as('alice', rig.app, '/m', { method: 'HEAD' }))).slice(0, 8)).toBe('200 live');
        for (const init of [{ method: 'HEAD' }, { headers: { 'if-none-match': '*' } }, { headers: { range: 'bytes=0-40' } }])
        {
            const response = await as('anon', rig.app, '/m/index.html', init);
            expect(response.status).toBe(404);
            expect(await response.text()).not.toContain('SEEDED');
        }
    });

    it('under prefix routing every spelling of the url answers live in both languages, and its language files answer 404', async () =>
    {
        const rig = build([{ path: '/m', render: 'static', revalidate: 0.01, component }], {
            rendererRoutes: guardedM,
            direct: true,
            locales: { supported: ['fa', 'en'], routing: 'prefix' }
        });
        seedAt(rig, 'm/index.fa.html', '<html data-azeroth-base="/fa"><body>SEEDED-FA</body></html>');
        seedAt(rig, 'm/index.en.html', '<html data-azeroth-base="/en"><body>SEEDED-EN</body></html>');
        const page: Array<[string, RequestInit?]> = [['/fa/m'], ['/%66a/m'], ['/en/m/'], ['/en/%6D?x=1'], ['/fa/m', { method: 'HEAD' }]];
        for (const [path, init] of page)
        {
            expect(await lineOf(await as('anon', rig.app, path, init)), path).toBe(LIVE_403);
        }
        for (const path of ['/m/index.fa.html', '/m/index.en.html', '/M/INDEX.EN.HTML'])
        {
            const response = await as('anon', rig.app, path);
            expect(response.status, path).toBe(404);
            expect(await response.text()).not.toContain('SEEDED');
        }
    });

    it('answers a plain or an enumerated static page that table guards live, instead of serving its file', async () =>
    {
        const rendererRoutes: Route[] = [{ path: '/s', component, guard: () => who() === 'alice', loader }, { path: '/p/:id', component, guard: () => who() === 'alice', loader }];
        const rig = build([{ path: '/s', render: 'static', component }, { path: '/p/:id', render: 'static', component }], { rendererRoutes, direct: true });
        seedAt(rig, 's/index.html', '<html><body>SEEDED-STATIC</body></html>');
        seedAt(rig, 'p/1/index.html', '<html><body>SEEDED-PARAM</body></html>');
        expect(await lineOf(await as('anon', rig.app, '/s'))).toBe(LIVE_403);
        expect(await lineOf(await as('anon', rig.app, '/p/1'))).toBe(LIVE_403);
        expect(await lineOf(await as('alice', rig.app, '/s'))).toBe(LIVE_ALICE);
    });

    // The case, 8.3 and stream spellings reach a file only on a case-insensitive disk (Windows,
    // macOS).
    it('a static page that table guards never serves its file, by its file url or by an alias of its url', async () =>
    {
        const rendererRoutes: Route[] = [
            { path: '/terms', component, guard: () => who() === 'alice', loader },
            { path: '/q/vip', component, guard: () => who() === 'alice', loader },
            { path: '/q/:id', component },
            { path: '/about', component }
        ];
        const pages: PageRoute[] = [
            { path: '/terms', render: 'static', component },
            { path: '/about', render: 'static', component },
            { path: '/q/:id', render: 'static', component }
        ];
        const rig = build(pages, { rendererRoutes, direct: true });
        seedAt(rig, 'terms/index.html', '<html><body>SEEDED-TERMS</body></html>');
        seedAt(rig, 'terms/index.en.html', '<html><body>SEEDED-EN</body></html>');
        seedAt(rig, 'about/index.html', '<html><body>SEEDED-ABOUT</body></html>');
        seedAt(rig, 'q/vip/index.html', '<html><body>SEEDED-VIP</body></html>');
        seedAt(rig, 'q/open/index.html', '<html><body>SEEDED-OPEN</body></html>');
        const files: Array<[string, RequestInit?]> = [
            ['/terms/index.html'], ['/terms/index.html', { method: 'HEAD' }], ['/terms/index.en.html'], ['/q/vip/index.html'],
            ['/Terms'], ['/TERMS/'], ['/Terms', { method: 'HEAD' }], ['/Terms', { headers: { 'if-none-match': '*' } }],
            ['/Terms/INDEX.HTML'], ['/terms/index.html::$DATA'], ['/Q/vip'], ['/q/VIP/INDEX.HTML']
        ];
        for (const [path, init] of files)
        {
            const response = await as('anon', rig.app, path, init);
            expect(response.status, `${ init?.method ?? 'GET' } ${ path }`).toBe(404);
            expect(await response.text(), path).not.toContain('SEEDED');
        }
        const aliases: Array<[string, RequestInit?]> = [
            ['/q/VIP'], ['/q/Vip'], ['/q/VIP', { headers: { range: 'bytes=0-40' } }], ['/q/vip::$INDEX_ALLOCATION'], ['/q/VIP/']
        ];
        for (const [path, init] of aliases)
        {
            expect(await (await as('anon', rig.app, path, init)).text(), path).not.toContain('SEEDED');
        }
        expect(await lineOf(await as('anon', rig.app, '/terms'))).toBe(LIVE_403);
        expect(await lineOf(await as('anon', rig.app, '/q/vip'))).toBe(LIVE_403);
        for (const [path, marker] of [['/about', 'SEEDED-ABOUT'], ['/about/index.html', 'SEEDED-ABOUT'], ['/q/open', 'SEEDED-OPEN']] as const)
        {
            const response = await as('anon', rig.app, path);
            expect(response.status, path).toBe(200);
            expect(await response.text(), path).toContain(marker);
        }
    });

    it('a wrapper that forwards guarded, and the stamp of an outcome it rewrites, answers live from the first request', async () =>
    {
        const inner = createPageRenderer(appFor(guardedM), guardedM);
        const forward = async (url: string, shell: string, options?: PageRenderOptions): Promise<PageResult> =>
        {
            const result = await inner(url, shell, options);
            return result.kind === 'html' ? { kind: 'html', html: result.html, status: result.status, guarded: result.guarded } : result;
        };
        const renderer: PageRenderer = Object.assign(forward, { guarded: inner.guarded });
        const rig = build([{ path: '/m', render: 'static', revalidate: 60, component }], { renderer });
        seedAt(rig, 'm/index.html', '<html><body>SEEDED-FRESH</body></html>', true);
        expect(await lineOf(await as('anon', rig.app, '/m'))).toBe(LIVE_403);
        expect(await lineOf(await as('alice', rig.app, '/m'))).toBe(LIVE_ALICE);
        expect(rig.cache.sets).toEqual([]);
    });

    // Red only on a case-insensitive disk (Windows, macOS), where `/q/VIP` opens
    // `q/vip/index.html`.
    it('a prerendered file seeds only the url that names it exactly', async () =>
    {
        const qPages: PageRoute[] = [{ path: '/q/:id', render: 'static', revalidate: 0.01, component }];
        const qRenderer: Route[] = [{ path: '/q/vip', component, guard: () => who() === 'alice', loader }, { path: '/q/:id', component }];
        const shapes: Array<[string, Rig]> = [
            ['renderer as is', build(qPages, { rendererRoutes: qRenderer, direct: true })],
            ['through a wrapper', build(qPages, { rendererRoutes: qRenderer })],
            ['one table', build([{ path: '/q/vip', render: 'server', component, guard: () => who() === 'alice', loader }, ...qPages])]
        ];
        for (const [shape, rig] of shapes)
        {
            seedAt(rig, 'q/vip/index.html', '<html><body>SEEDED-VIP</body></html>');
            seedAt(rig, 'q/open/index.html', '<html><body>SEEDED-OPEN</body></html>');
            for (const spelling of ['/q/VIP', '/q/Vip', '/q/vip::$INDEX_ALLOCATION'])
            {
                expect(await (await as('anon', rig.app, spelling)).text(), `${ shape } ${ spelling }`).not.toContain('SEEDED');
            }
            expect(await (await as('anon', rig.app, '/q/open')).text(), shape).toContain('SEEDED-OPEN');
        }
    });
});

describe('a renderer that does not expose guarded: what a shared render finds', () =>
{
    const mountTable = (): PageRoute[] => [{ path: '/m', render: 'static', revalidate: 0.01, component }];

    it('whatever the guard does to the shared render is a discovery: the seed answers once, then every visitor renders live as themselves', async () =>
    {
        const failing = (): Promise<string> => Promise.reject(new Error('no session'));
        const outcomes: Array<[string, Route, string]> = [
            ['veto', { path: '/m', component, guard: () => who() === 'alice', loader }, LIVE_403],
            ['redirect', { path: '/m', component, guard: () => (who() === 'alice' ? true : '/login'), loader }, '302 live private, no-store -'],
            ['off-origin redirect', { path: '/m', component, guard: () => (who() === 'alice' ? true : 'https://sso.example/login'), loader }, '500 live private, no-store -'],
            ['loader failure', { path: '/m', component, guard: () => who() !== 'mallory', loader: ({ request }) => (request === null ? failing() : loader()) }, '200 live private, no-store PRIVATE-BALANCE-anon'],
            ['throw', { path: '/m', component, guard: ({ request }) => (request === null ? nullRequest() : who() === 'alice'), loader }, LIVE_403]
        ];
        for (const [outcome, route, anon] of outcomes)
        {
            const rig = build(mountTable(), { rendererRoutes: [route] });
            seedAt(rig, 'm/index.html', '<html><body>SEEDED-GUARDLESS</body></html>');
            expect(await lineOf(await as('anon', rig.app, '/m')), outcome).toContain('SEEDED-GUARDLESS');
            await settle();
            expect(await lineOf(await as('anon', rig.app, '/m')), outcome).toBe(anon);
            expect(await lineOf(await as('alice', rig.app, '/m')), outcome).toBe(LIVE_ALICE);
            const messages = rig.errors.map((entry) => (entry.error as Error).message);
            expect(messages.filter((message) => message.includes('guarded route chain')), outcome).toHaveLength(1);
            expect(messages.filter((message) => message.includes('entry dropped')), outcome).toEqual([]);
            // The seed's own write, dropped by the discovery and never made again.
            expect(rig.cache.sets, outcome).toEqual(['/m']);
            expect(rig.cache.entries.has('/m'), outcome).toBe(false);
        }
    });

    it('a guard that throws in the shared render is a discovery: the stale copy is dropped and a cold visitor gets her page', async () =>
    {
        const throwing: Route[] = [{ path: '/m', component, guard: ({ request }) => (request === null ? nullRequest() : who() === 'alice'), loader }];
        const rig = build(mountTable(), { rendererRoutes: throwing });
        seedAt(rig, 'm/index.html', '<html><body>SEEDED-GUARDLESS</body></html>');
        rig.cache.entries.set('/m', { html: '<html><body>OLD-PRIVATE</body></html>', status: 200, createdAt: 0, build: BUILD_ID });
        expect(await (await as('alice', rig.app, '/m')).text()).toContain('OLD-PRIVATE');
        await settle();
        expect(rig.cache.entries.has('/m')).toBe(false);
        expect(await lineOf(await as('mallory', rig.app, '/m'))).toBe(LIVE_403);

        const cold = build(mountTable(), { rendererRoutes: throwing });
        expect(await lineOf(await as('alice', cold.app, '/m'))).toBe(LIVE_ALICE);
    });

    it('a throw marked by another copy of the ssr module, as an SSR bundle carries, reaches the mount', async () =>
    {
        // @ts-expect-error -- a query-suffixed specifier loads a second instance of the module
        const second = await import('../src/ssr.ts?second-copy') as { createPageRenderer: typeof createPageRenderer };
        expect(second.createPageRenderer).not.toBe(createPageRenderer);
        const throwing: Route[] = [{ path: '/m', component, guard: ({ request }) => (request === null ? nullRequest() : who() === 'alice'), loader }];
        const inner = second.createPageRenderer(appFor(throwing), throwing);
        const rig = build(mountTable(), { renderer: (url, shell, options) => inner(url, shell, options) });
        seedAt(rig, 'm/index.html', '<html><body>SEEDED-GUARDLESS</body></html>');
        expect(await (await as('anon', rig.app, '/m')).text()).toContain('SEEDED-GUARDLESS');
        await settle();
        expect(await lineOf(await as('mallory', rig.app, '/m'))).toBe(LIVE_403);
        expect(await lineOf(await as('alice', rig.app, '/m'))).toBe(LIVE_ALICE);
    });

    it('pages whose shared renders throw one object from one wait are each found, up to 64 of them', async () =>
    {
        // A session store the guard awaits on every render, which throws one error with no request.
        const denied = new Error('no session');
        let connect: () => void = () => undefined;
        const connected = new Promise<void>((resolve) =>
        {
            connect = resolve;
        });
        const rendererRoutes: Route[] = [{
            path: '/u/:id',
            component,
            guard: async ({ request }) =>
            {
                await connected;
                if (request === null)
                {
                    throw denied;
                }
                return who() === 'alice';
            },
            loader
        }];
        const rig = build([{ path: '/u/:id', render: 'static', revalidate: 60, component }], { rendererRoutes });
        const ids = Array.from({ length: 65 }, (_, i) => `p${ i }`);
        for (const id of ids)
        {
            seedAt(rig, `u/${ id }/index.html`, `<html><body>SEEDED-${ id }</body></html>`);
            expect(await lineOf(await as('anon', rig.app, `/u/${ id }`))).toContain('SEEDED');
        }
        connect();
        await settle(200);
        const found: string[] = [];
        for (const id of ids)
        {
            if ((await as('anon', rig.app, `/u/${ id }`)).status === 403)
            {
                found.push(id);
            }
        }
        expect(found.length).toBeGreaterThanOrEqual(64);
    });

    it('what is learned covers every spelling that reaches the seed file', async () =>
    {
        const rig = build(mountTable(), { rendererRoutes: [{ path: '/m', component, guard: () => who() === 'alice', loader }] });
        seedAt(rig, 'm/index.html', '<html><body>SEEDED-GUARDLESS</body></html>');
        await as('anon', rig.app, '/m');
        await settle();
        for (const spelling of ['/m', '/m/', '/%6D', '/%6d'])
        {
            const response = await as('anon', rig.app, spelling);
            expect(response.status).toBe(403);
            expect(await response.text()).not.toContain('SEEDED');
        }
    });

    it('a copy a persistent cache kept from an earlier process answers until the first shared render, then never', async () =>
    {
        const open: PageRoute[] = [{ path: '/m', render: 'static', revalidate: 0.2, component, loader: () => Promise.resolve('OPEN-old') }];
        const old = build(open);
        await as('anon', old.app, '/m');
        const next = build(open, { rendererRoutes: [{ path: '/m', component, guard: () => who() === 'alice', loader }], from: old });
        expect(await lineOf(await as('anon', next.app, '/m'))).toBe('200 hit public, max-age=0, must-revalidate OPEN-old');
        await settle(250);
        expect(await lineOf(await as('anon', next.app, '/m'))).toContain('OPEN-old');
        await settle();
        expect(await lineOf(await as('anon', next.app, '/m'))).toBe(LIVE_403);
        expect(await lineOf(await as('alice', next.app, '/m'))).toBe(LIVE_ALICE);
        expect(next.cache.entries.has('/m')).toBe(false);
    });

    it('a renderer written by hand is caught by a veto or by an outcome it stamps guarded itself', async () =>
    {
        const anonymous: PageResult[] = [{ kind: 'blocked', status: 403, html: SHELL }, { kind: 'redirect', to: '/login', replace: false, guarded: true }];
        for (const answer of anonymous)
        {
            const rig = build(mountTable(), { renderer: handWritten(answer) });
            seedAt(rig, 'm/index.html', '<html><body>SEEDED-OLD</body></html>');
            expect(await lineOf(await as('anon', rig.app, '/m')), answer.kind).toContain('SEEDED-OLD');
            await settle();
            expect(await lineOf(await as('anon', rig.app, '/m')), answer.kind).toBe(`${ answer.kind === 'blocked' ? 403 : 302 } live private, no-store -`);
            expect(await lineOf(await as('alice', rig.app, '/m')), answer.kind).toBe(LIVE_ALICE);
        }
    });

    it('a renderer written by hand that exposes guarded answers live from the first request', async () =>
    {
        const renderer = Object.assign(handWritten({ kind: 'redirect', to: '/login', replace: false }), {
            guarded: (url: string): boolean => new URL(url, 'http://local').pathname === '/m'
        });
        const rig = build(mountTable(), { renderer });
        seedAt(rig, 'm/index.html', '<html><body>SEEDED-OLD</body></html>');
        expect(await lineOf(await as('anon', rig.app, '/m'))).toBe('302 live private, no-store -');
        expect(await lineOf(await as('alice', rig.app, '/m'))).toBe(LIVE_ALICE);
    });

    it('a page whose learned set is full vouches for no seed, so a flood cannot bring a learned file back', async () =>
    {
        const rendererRoutes: Route[] = [{ path: '/u/:id', component, guard: () => who() === 'alice', loader }];
        const rig = build([{ path: '/u/:id', render: 'static', revalidate: 0.01, component }], { rendererRoutes });
        seedAt(rig, 'u/vip/index.html', '<html><body>SEEDED-VIP</body></html>');
        await as('anon', rig.app, '/u/vip');
        await settle();
        expect((await as('anon', rig.app, '/u/vip')).status).toBe(403);
        for (let i = 0; i < 1000; i++)
        {
            await as('anon', rig.app, `/u/junk${ i }`);
        }
        const after = await as('anon', rig.app, '/u/vip');
        expect(after.status).toBe(403);
        expect(await after.text()).not.toContain('SEEDED');
    });

    it('a flood cannot bring back a spelling cached in the seed window', async () =>
    {
        const rendererRoutes: Route[] = [{ path: '/u/:id', component, guard: () => who() === 'alice', loader }];
        const rig = build([{ path: '/u/:id', render: 'static', revalidate: 1, component }], { rendererRoutes });
        seedAt(rig, 'u/vip/index.html', '<html><body>SEEDED-VIP</body></html>', true);
        await as('anon', rig.app, '/u/vip/');
        await settle(1100);
        await as('anon', rig.app, '/u/vip');
        await settle();
        for (let i = 0; i < 1000; i++)
        {
            await as('anon', rig.app, `/u/junk${ i }`);
        }
        const after = await as('anon', rig.app, '/u/vip/');
        expect(after.status).toBe(403);
        expect(await after.text()).not.toContain('SEEDED');
    });

    it('a page whose learned set a flood filled first never seeds', async () =>
    {
        const rendererRoutes: Route[] = [{ path: '/u/:id', component, guard: () => who() === 'alice', loader }];
        const rig = build([{ path: '/u/:id', render: 'static', revalidate: 0.01, component }], { rendererRoutes });
        seedAt(rig, 'u/vip/index.html', '<html><body>SEEDED-VIP</body></html>');
        for (let i = 0; i < 1000; i++)
        {
            await as('anon', rig.app, `/u/junk${ i }`);
        }
        for (const spelling of ['/u/vip', '/u/vip', '/u/vip/'])
        {
            const response = await as('anon', rig.app, spelling);
            expect(response.status).toBe(403);
            expect(await response.text()).not.toContain('SEEDED');
            await settle();
        }
    });
});

/**
 * A renderer written by hand: `anonymous` for a visitor with no session, a stamped private page
 * otherwise.
 */
function handWritten(anonymous: PageResult): PageRenderer
{
    return (_url, shell) => Promise.resolve(who() === 'anon'
        ? anonymous
        : { kind: 'html', html: shell.replace('<div id="root"></div>', `<div id="root">PRIVATE-BALANCE-${ who() }</div>`), status: 200, guarded: true });
}

describe('the file handler and a page\'s prerendered file', () =>
{
    it('never serves the file by any spelling of its file url', async () =>
    {
        const pages: PageRoute[] = [
            { path: '/m', render: 'static', revalidate: 0.01, component },
            { path: '/u/:id', render: 'static', revalidate: 0.01, component }
        ];
        const rig = build(pages, { rendererRoutes: [{ path: '/m', component, guard: () => who() === 'alice', loader }, { path: '/u/:id', component }] });
        seedAt(rig, 'm/index.html', '<html><body>SEEDED-GUARDLESS</body></html>');
        seedAt(rig, 'm/index.en.html', '<html><body>SEEDED-EN</body></html>');
        seedAt(rig, 'u/alice/index.html', '<html><body>SEEDED-ALICE</body></html>');
        for (const spelling of ['/m/index.html', '/%6D/index.html', '/m/index.en.html', '/u/alice/index.html'])
        {
            const response = await as('anon', rig.app, spelling);
            expect(response.status, spelling).toBe(404);
            expect(await response.text()).not.toContain('SEEDED');
        }
        // What case folding, a trailing dot or space, an 8.3 name or a stream suffix resolve to on
        // Windows.
        for (const spelling of ['/m/INDEX.HTML', '/M/index.html', '/M', '/M/', '/m/index.html::$DATA', '/m/index.html.', '/m/index.html%20', '/m./index.html', '/m/INDEX~1.HTM'])
        {
            expect(await (await as('anon', rig.app, spelling)).text(), spelling).not.toContain('SEEDED');
        }
    });

    it('answers /index.html of an ISR home with the 404, while the home still answers from its file', async () =>
    {
        const rig = build([{ path: '/', render: 'static', revalidate: 60, component, loader: () => Promise.resolve('OPEN-home') }]);
        seedAt(rig, 'index.html', '<html><body>SEEDED-HOME</body></html>');
        expect(await (await as('anon', rig.app, '/')).text()).toContain('SEEDED-HOME');
        expect((await as('anon', rig.app, '/index.html')).status).toBe(404);
        expect((await as('anon', rig.app, '/shell.html')).status).toBe(200);
    });

    it('serves every other file, a plain page\'s own file under an ISR pattern included', async () =>
    {
        const pages: PageRoute[] = [
            { path: '/about', render: 'static', component },
            { path: '/:slug', render: 'static', revalidate: 60, component, loader: () => Promise.resolve('OPEN-slug') }
        ];
        const rig = build(pages);
        seedAt(rig, 'about/index.html', '<html><body>SEEDED-ABOUT</body></html>');
        seedAt(rig, 'news/index.html', '<html><body>SEEDED-NEWS</body></html>');
        seedAt(rig, 'deep/a/index.html', '<html><body>SEEDED-DEEP</body></html>');
        seedAt(rig, 'deep/notes.txt', 'SEEDED-NOTES');
        expect(await lineOf(await as('anon', rig.app, '/about'))).toMatch(/^200 - .* SEEDED-ABOUT$/);
        for (const [path, marker] of [['/about/index.html', 'SEEDED-ABOUT'], ['/news', 'SEEDED-NEWS'], ['/deep/a/index.html', 'SEEDED-DEEP'], ['/deep/notes.txt', 'SEEDED-NOTES']] as const)
        {
            const response = await as('anon', rig.app, path);
            expect(response.status, path).toBe(200);
            expect(await response.text(), path).toContain(marker);
        }
    });

    it('a refused file answers as a missing one does: JSON unless the request takes html', async () =>
    {
        const pages: PageRoute[] = [
            { path: '/', render: 'static', revalidate: 60, component, loader: () => Promise.resolve('OPEN-home') },
            { path: '/u/:id', render: 'static', revalidate: 60, component }
        ];
        const rig = build(pages);
        seedAt(rig, 'index.html', '<html><body>SEEDED-HOME</body></html>');
        seedAt(rig, 'u/alice/index.html', '<html><body>SEEDED-ALICE</body></html>');
        const answer = async (path: string, accept: string | undefined): Promise<string> =>
        {
            const response = await as('anon', rig.app, path, accept === undefined ? {} : { headers: { accept } });
            expect(await response.text(), path).not.toContain('SEEDED');
            return `${ response.status } ${ response.headers.get('content-type') ?? '-' }`;
        };
        for (const accept of [undefined, 'application/json', '*/*', 'image/avif,image/webp,*/*', 'text/html'])
        {
            expect(await answer('/u/alice/index.html', accept), accept).toBe(await answer('/u/zelda/index.html', accept));
            expect(await answer('/index.html', accept), accept).toBe(await answer('/nope.html', accept));
        }
        expect(await answer('/u/alice/index.html', 'application/json')).toMatch(/^404 application\/json/);
        expect(await answer('/u/alice/index.html', 'text/html')).toMatch(/^404 text\/html/);
    });

    it('refuses an index file in a directory an ISR page answers for or a guarded page owns, whatever wrote it', async () =>
    {
        const isr = build([
            { path: '/m', render: 'static', revalidate: 60, component },
            { path: '/:slug', render: 'static', revalidate: 60, component }
        ]);
        seedAt(isr, 'storybook/index.html', '<html><body>SEEDED-STORYBOOK</body></html>');
        seedAt(isr, 'storybook/iframe.html', '<html><body>SEEDED-IFRAME</body></html>');
        seedAt(isr, 'storybook/deep/index.html', '<html><body>SEEDED-DEEP</body></html>');
        seedAt(isr, 'm/index.v2.html', '<html><body>SEEDED-V2</body></html>');
        seedAt(isr, 'm/other.html', '<html><body>SEEDED-OTHER</body></html>');
        const guarded = build([
            { path: '/docs/:slug', render: 'server', component, guard: () => who() === 'alice' },
            { path: '/t/:slug', render: 'server', component, guard: () => who() === 'alice' },
            { path: '/x', render: 'server', component, guard: () => who() === 'alice' }
        ]);
        seedAt(guarded, 'docs/a/index.html', '<html><body>SEEDED-DOCS</body></html>');
        seedAt(guarded, 't/100%/index.html', '<html><body>SEEDED-PERCENT</body></html>');
        seedAt(guarded, 'x#y/index.html', '<html><body>SEEDED-HASH</body></html>');
        seedAt(guarded, 'misc/index.html', '<html><body>SEEDED-MISC</body></html>');
        seedAt(guarded, 'site.css', 'SEEDED-CSS');
        for (const [rig, path] of [[isr, '/storybook/index.html'], [isr, '/m/index.v2.html'], [guarded, '/docs/a/index.html'], [guarded, '/t/100%25/index.html']] as const)
        {
            const response = await as('anon', rig.app, path);
            expect(response.status, path).toBe(404);
            expect(await response.text(), path).not.toContain('SEEDED');
        }
        const served = [
            [isr, '/storybook/iframe.html', 'SEEDED-IFRAME'], [isr, '/storybook/deep/index.html', 'SEEDED-DEEP'], [isr, '/m/other.html', 'SEEDED-OTHER'],
            [guarded, '/x%23y/index.html', 'SEEDED-HASH'], [guarded, '/misc/index.html', 'SEEDED-MISC'], [guarded, '/site.css', 'SEEDED-CSS']
        ] as const;
        for (const [rig, path, marker] of served)
        {
            const response = await as('anon', rig.app, path);
            expect(response.status, path).toBe(200);
            expect(await response.text(), path).toContain(marker);
        }
    });

    it('a guarded page of any render mode never serves the file an older build left, a guarded home included', async () =>
    {
        const guard = (): boolean => who() === 'alice';
        const rig = build([
            { path: '/', render: 'server', component, guard },
            { path: '/report', render: 'server', component, guard, loader },
            { path: '/inbox', render: 'client', component, guard },
            { path: '/kb/:slug', render: 'client', component, guard },
            { path: '/kb/latest', render: 'static', component },
            { path: '/open', render: 'server', component }
        ]);
        seedAt(rig, 'index.html', '<html><body>SEEDED-HOME</body></html>');
        seedAt(rig, 'report/index.html', '<html><body>SEEDED-REPORT</body></html>');
        seedAt(rig, 'report/index.en.html', '<html><body>SEEDED-EN</body></html>');
        seedAt(rig, 'inbox/index.html', '<html><body>SEEDED-INBOX</body></html>');
        seedAt(rig, 'kb/latest/index.html', '<html><body>SEEDED-LATEST</body></html>');
        seedAt(rig, 'open/index.html', '<html><body>SEEDED-OPEN</body></html>');
        expect((await as('anon', rig.app, '/report')).status).toBe(403);
        for (const path of ['/report/index.html', '/report/index.en.html', '/Report', '/REPORT/', '/report/INDEX.HTML', '/inbox/index.html', '/kb/latest/index.html', '/index.html', '/INDEX.HTML'])
        {
            const response = await as('anon', rig.app, path);
            expect(response.status, path).toBe(404);
            expect(await response.text(), path).not.toContain('SEEDED');
        }
        for (const [path, marker] of [['/open/index.html', 'SEEDED-OPEN'], ['/shell.html', '<div id="root">']] as const)
        {
            const response = await as('anon', rig.app, path);
            expect(response.status, path).toBe(200);
            expect(await response.text(), path).toContain(marker);
        }
    });

    it('under /assets a page\'s file answers 404, while a hashed asset stays immutable', async () =>
    {
        const pages: PageRoute[] = [
            { path: '/assets/coins/:sym', render: 'static', revalidate: 60, component },
            { path: '/:slug', render: 'static', revalidate: 60, component }
        ];
        // The assets mount exists only for a dir that exists at mount, so the files land first.
        const built = build(pages);
        seedAt(built, 'assets/coins/vip/index.html', '<html><body>SEEDED-VIP</body></html>');
        seedAt(built, 'assets/index.html', '<html><body>SEEDED-ASSETS</body></html>');
        seedAt(built, 'assets/app-1.js', 'SEEDED-JS');
        const rig = build(pages, { from: built });
        for (const path of ['/assets/coins/vip/index.html', '/assets/coins/VIP/INDEX.HTML', '/assets/index.html'])
        {
            const response = await as('anon', rig.app, path);
            expect(response.status, path).toBe(404);
            expect(await response.text(), path).not.toContain('SEEDED');
        }
        const asset = await as('anon', rig.app, '/assets/app-1.js');
        expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(await asset.text()).toContain('SEEDED-JS');
    });

    it('under /assets a guarded server page\'s old file answers 404', async () =>
    {
        for (const [path, file] of [['/assets/report', 'assets/report/index.html'], ['/:slug', 'assets/index.html']] as const)
        {
            const pages: PageRoute[] = [{ path, render: 'server', component, guard: () => who() === 'alice' }];
            const built = build(pages);
            seedAt(built, file, '<html><body>SEEDED-OLD</body></html>');
            seedAt(built, 'assets/app-1.js', 'SEEDED-JS');
            const rig = build(pages, { from: built });
            const response = await as('anon', rig.app, `/${ file }`);
            expect(response.status, file).toBe(404);
            expect(await response.text(), file).not.toContain('SEEDED');
        }
    });

    it('judges a file on the client dir as it resolves at the request, after the dir is re-pointed', async () =>
    {
        const first = build([{ path: '/m', render: 'static', revalidate: 60, component }], { rendererRoutes: [{ path: '/m', component, guard: () => who() === 'alice', loader }] });
        seedAt(first, 'm/index.html', '<html><body>SEEDED-A</body></html>');
        const parent = mkdtempSync(join(tmpdir(), 'az-isrg-swap-'));
        dirs.push(parent);
        // A release whose real path is a different length, so a cached root would slice it wrong.
        const next = join(parent, 'release-number-two');
        cpSync(first.dir, next, { recursive: true });
        writeFileSync(join(next, 'm', 'index.html'), '<html><body>SEEDED-B</body></html>');
        const current = join(parent, 'current');
        symlinkSync(first.dir, current, 'junction');
        const rig = build([{ path: '/m', render: 'static', revalidate: 60, component }], {
            rendererRoutes: [{ path: '/m', component, guard: () => who() === 'alice', loader }],
            direct: true,
            from: { ...first, dir: current }
        });
        expect((await as('anon', rig.app, '/m/index.html')).status).toBe(404);
        rmSync(current);
        symlinkSync(next, current, 'junction');
        for (const path of ['/m/index.html', '/M/INDEX.HTML'])
        {
            const response = await as('anon', rig.app, path);
            expect(response.status, path).toBe(404);
            expect(await response.text(), path).not.toContain('SEEDED');
        }
        expect(await lineOf(await as('anon', rig.app, '/m'))).toBe(LIVE_403);
        expect((await as('anon', rig.app, '/shell.html')).status).toBe(200);
        rmSync(current);
    });
});

describe('pages that were fine keep their answers', () =>
{
    it('an unguarded page that throws the very object a guarded page threw keeps its stale copy and caches again after', async () =>
    {
        // A config read that rethrows one cached failure until it recovers, read by a guard and
        // by a page.
        let failure: Error | undefined;
        const config = (): string =>
        {
            if (failure !== undefined)
            {
                throw failure;
            }
            return 'CFG';
        };
        const News = (): HTMLElement => h('main', {}, `NEWS-${ config() }`);
        for (const touched of [true, false])
        {
            failure = undefined;
            const rig = build([
                { path: '/account', render: 'server', component, guard: () => config() === 'CFG' },
                { path: '/news', render: 'static', revalidate: 0.01, component: News }
            ], { direct: true });
            const news = async (): Promise<string> =>
            {
                const line = await lineOf(await as('anon', rig.app, '/news'));
                await settle(40);
                return line;
            };
            await news();
            failure = new Error('config store unreachable');
            if (touched)
            {
                await as('alice', rig.app, '/account');
            }
            await news();
            expect(await news(), `touched ${ touched }`).toBe('200 stale public, max-age=0, must-revalidate NEWS-CFG');
            failure = undefined;
            const after = [await news(), await news(), await news()];
            expect(after.join('|'), `touched ${ touched }`).not.toContain('live');
            expect(after.at(-1)).toContain('public, max-age=0, must-revalidate');
            expect(rig.errors.filter((entry) => (entry.error as Error).message.includes('guarded route chain'))).toEqual([]);
        }
    });

    it('an unguarded page keeps its stale copy when another mount\'s guarded page at its url threw the same object per request', async () =>
    {
        const failure = new Error('config store unreachable');
        let down = false;
        const config = (): string =>
        {
            if (down)
            {
                throw failure;
            }
            return 'CFG';
        };
        const News = (): HTMLElement => h('main', {}, `NEWS-${ config() }`);
        const account = build([{ path: '/n', render: 'server', component, guard: () => config() === 'CFG' }], { direct: true });
        const open = build([{ path: '/n', render: 'static', revalidate: 0.01, component: News }], { direct: true });
        const news = async (): Promise<string> =>
        {
            const line = await lineOf(await as('anon', open.app, '/n'));
            await settle(40);
            return line;
        };
        await news();
        down = true;
        await as('alice', account.app, '/n');
        await news();
        expect(await news()).toBe('200 stale public, max-age=0, must-revalidate NEWS-CFG');
        expect(open.errors.filter((entry) => (entry.error as Error).message.includes('guarded route chain'))).toEqual([]);
    });

    it('an unguarded page on a mount that found a guard seeds, caches, and keeps its stale copy through a failed regeneration', async () =>
    {
        for (const fault of ['reject', 'throw'] as const)
        {
            let down = false;
            const Open = (): HTMLElement =>
            {
                if (down && fault === 'throw')
                {
                    throw new Error('component down');
                }
                return h('main', {}, 'OPEN-page');
            };
            const openLoader = (): Promise<string> => (down && fault === 'reject' ? Promise.reject(new Error('down')) : Promise.resolve('OPEN-data'));
            const pages: PageRoute[] = [
                { path: '/m', render: 'static', revalidate: 0.01, component },
                { path: '/open', render: 'static', revalidate: 0.01, component: Open, loader: openLoader },
                { path: '/cold', render: 'static', revalidate: 0.01, component: Open, loader: openLoader }
            ];
            const rendererRoutes: Route[] = [
                { path: '/m', component, guard: () => who() === 'alice', loader },
                { path: '/open', component: Open, loader: openLoader },
                { path: '/cold', component: Open, loader: openLoader }
            ];
            const rig = build(pages, { rendererRoutes });
            seedAt(rig, 'open/index.html', '<html><body>SEEDED-OPEN</body></html>');
            expect(await lineOf(await as('anon', rig.app, '/open')), fault).toBe('200 stale public, max-age=0, must-revalidate SEEDED-OPEN');
            await settle();
            await as('anon', rig.app, '/m');
            await settle();
            expect(await lineOf(await as('anon', rig.app, '/m')), fault).toMatch(/^403 /);
            expect(await lineOf(await as('alice', rig.app, '/open')), fault).toMatch(/^200 (hit|stale) public, max-age=0, must-revalidate OPEN-/);
            await settle();
            down = true;
            await as('anon', rig.app, '/open');
            await settle();
            expect(await lineOf(await as('alice', rig.app, '/open')), fault).toMatch(/^200 stale public, max-age=0, must-revalidate OPEN-/);
            expect((await as('anon', rig.app, '/cold')).status, fault).toBe(500);
            expect(rig.cache.sets.filter((key) => key === '/open').length, fault).toBeGreaterThanOrEqual(2);
            expect(rig.cache.sets, fault).not.toContain('/m');
        }
    });

    it('a moved page with no guard answers its loader\'s redirect and is never learned', async () =>
    {
        const pages: PageRoute[] = [{
            path: '/mv',
            render: 'static',
            revalidate: 0.01,
            component,
            loader: (): never =>
            {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- the documented redirect sentinel
                throw redirect('/elsewhere');
            }
        }];
        const rig = build(pages, { direct: true });
        for (const user of ['anon', 'alice', 'anon'])
        {
            const response = await as(user, rig.app, '/mv');
            expect(response.status).toBe(302);
            expect(response.headers.get('x-azeroth-cache')).not.toBe('live');
            await settle();
        }
        expect(rig.errors.filter((entry) => (entry.error as Error).message.includes('guarded route chain'))).toEqual([]);
    });
});

describe('selection agreement and the stamp source', () =>
{
    it('guardedMatch follows flatten order in BOTH directions, exactly as matchAndLoad selects', () =>
    {
        const guarded: Route = { path: '/p/:page', component, guard: () => true };
        const specific: Route = { path: '/p/pricing', component };
        // Guarded first: its chain wins the order-first match for the specific URL too.
        expect(guardedMatch([guarded, specific], '/p/pricing')).toBe(true);
        // Specific first: the specific unguarded chain wins its own URL; the param chain
        // still guards everything else.
        expect(guardedMatch([specific, guarded], '/p/pricing')).toBe(false);
        expect(guardedMatch([specific, guarded], '/p/other')).toBe(true);
        expect(guardedMatch([specific, guarded], '/elsewhere')).toBe(false);
    });

    it('the renderer stamps every outcome of a guarded chain but a veto, and no outcome of an unguarded one', async () =>
    {
        const routes: Route[] = [
            { path: '/r', component, guard: () => '/login' },
            { path: '/x', component, guard: () => 'https://sso.example/login' },
            { path: '/e', component, guard: () => true, loader: () => Promise.reject(new Error('down')) },
            {
                path: '/moved',
                component,
                loader: (): never =>
                {
                    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the documented redirect sentinel
                    throw redirect('/elsewhere');
                }
            },
            { path: '/down', component, loader: () => Promise.reject(new Error('down')) }
        ];
        const render = createPageRenderer(appFor(routes), routes);
        const stampOf = async (url: string): Promise<string> =>
        {
            const result = await render(url, SHELL);
            return `${ result.kind }:${ 'guarded' in result && result.guarded }`;
        };
        expect(await stampOf('/r')).toBe('redirect:true');
        expect(await stampOf('/x')).toBe('refused-redirect:true');
        expect(await stampOf('/e')).toBe('error:true');
        expect(await stampOf('/moved')).toBe('redirect:false');
        expect(await stampOf('/down')).toBe('error:false');
    });
});

describe('the default observer and the header closure beyond ISR', () =>
{
    it('with no onError configured, the policy notice reaches console.error once', async () =>
    {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const rig = build(foreignChain(), { onError: false });
        await as('alice', rig.app, '/docs/current');
        await as('alice', rig.app, '/docs/current');
        const lines = spy.mock.calls.filter((call) => String(call[0]).includes('kit revalidate failed for'));
        expect(lines).toHaveLength(1);
        expect((lines[0]?.[1] as Error).message).toContain('not a failure');
    });

    it('a guarded render:server page answers with private, no-store through the stamp', async () =>
    {
        const pages: PageRoute[] = [
            { path: '/s', render: 'server', component, guard: () => who() === 'alice' },
            { path: '/open', render: 'server', component }
        ];
        const rig = build(pages);
        const guarded = await as('alice', rig.app, '/s');
        expect(guarded.status).toBe(200);
        expect(guarded.headers.get('cache-control')).toBe('private, no-store');
        const open = await as('anon', rig.app, '/open');
        expect(open.status).toBe(200);
        expect(open.headers.get('cache-control')).toBeNull();
    });

    it('a stamped stream upgrades no-cache to private, no-store; an unstamped one keeps no-cache', async () =>
    {
        const streamOf = (guarded: boolean): PageResult => ({
            kind: 'stream',
            status: 200,
            stream: new ReadableStream<Uint8Array>({
                start(controller): void
                {
                    controller.enqueue(new TextEncoder().encode('<html/>'));
                    controller.close();
                }
            }),
            ...(guarded ? { guarded: true } : {})
        });
        for (const [guarded, expected] of [[true, 'private, no-store'], [false, 'no-cache']] as const)
        {
            const app = new App();
            mountPages(app, {
                routes: [{ path: '/st', render: 'stream', component }],
                clientDir: makeClientDir(),
                renderer: () => Promise.resolve(streamOf(guarded))
            });
            const response = await app.handle(new Request('http://local/st'));
            expect(response.headers.get('cache-control')).toBe(expected);
        }
    });
});

describe('the guarded gate under prefix routing', () =>
{
    const PREFIX = { supported: ['en', 'fa'], routing: 'prefix' as const };

    it('answers live on the FIRST prefixed request and never caches', async () =>
    {
        const rig = build(foreignChain(), { locales: PREFIX });
        const alice = await as('alice', rig.app, '/fa/docs/current');
        expect(alice.status).toBe(200);
        expect(alice.headers.get('x-azeroth-cache')).toBe('live');
        expect(alice.headers.get('cache-control')).toBe('private, no-store');
        expect(await alice.text()).toContain('PRIVATE-BALANCE-alice');
        const mallory = await as('mallory', rig.app, '/fa/docs/current');
        expect(mallory.status).toBe(403);
        expect(rig.cache.sets).toEqual([]);
    });

    it('a guard that redirects answers in the request\'s url space, live', async () =>
    {
        const pages: PageRoute[] = [
            { path: '/docs/:slug', render: 'client', component, guard: () => '/login' },
            { path: '/docs/current', render: 'static', revalidate: 60, component }
        ];
        const rig = build(pages, { locales: PREFIX });
        const response = await as('alice', rig.app, '/fa/docs/current');
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('/fa/login');
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.get('x-azeroth-cache')).toBe('live');
        expect(rig.cache.sets).toEqual([]);
    });
});
