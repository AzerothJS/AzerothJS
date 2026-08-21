// @vitest-environment node
//
// A guard-carrying page must never be served from a shared cache. Guards run inside the
// renderer, so a cached copy answers without consulting them and carries the first
// visitor's loader data verbatim; these arms pin the four refusals that close that hole:
// the mount-time throw for a guarded static chain, the per-URL guarded gate ahead of the
// cache/seed/inflight, the result stamp the cache layers refuse, and the
// `private, no-store` headers on every guarded answer. Request identity rides
// AsyncLocalStorage exactly as the http request root carries it in production.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { RouterProvider, Routes, createMemoryHistory, createRouter, h } from 'azerothjs';
import type { LoaderHandoff, Route } from 'azerothjs';
import { guardedMatch } from 'azerothjs/internal';
import { App } from '@azerothjs/http';
import { mountPages, type PageCache, type PageEntry, type PageRoute } from '@azerothjs/kit';
import { prerender } from '@azerothjs/kit/prerender';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import type { PageRenderer, PageResult } from '@azerothjs/kit/ssr';

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
 * default over the same table, or over `rendererRoutes` for the mismatch arms.
 */
function build(pages: PageRoute[], options: { rendererRoutes?: Route[]; onError?: false; holdFirstRender?: boolean } = {}): Rig
{
    const dir = makeClientDir();
    const cache = recordingCache();
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
        renderer,
        cache,
        ...(options.onError === false
            ? {}
            : { onError: (error, context): void => void errors.push({ error, path: context.path, phase: context.phase }) })
    });
    return { app, cache, dir, renders: () => count, release, errors };
}

const as = (user: string, app: App, path: string): Promise<Response> =>
    identity.run(user, () => app.handle(new Request(`http://local${ path }`)));

async function settle(): Promise<void>
{
    await new Promise((resolve) => setTimeout(resolve, 25));
}

const component = (): HTMLElement => h('div', {}, 'page');

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

    it('a poisoned stale entry serves ONCE, the refresh stamp-drops AND learns, and the seed file never resurrects it', async () =>
    {
        const rig = build(mountTable(), { rendererRoutes: rendererTable() });
        // The pre-fix world: a guarded entry already in the persistent cache under the
        // CURRENT build, plus its seed file still on disk.
        mkdirSync(join(rig.dir, 'm'), { recursive: true });
        writeFileSync(join(rig.dir, 'm', 'index.html'), '<html><body>SEEDED-GUARDLESS</body></html>');
        utimesSync(join(rig.dir, 'm', 'index.html'), new Date(0), new Date(0));
        rig.cache.entries.set('/m', { html: '<html><body>OLD-PRIVATE</body></html>', status: 200, createdAt: 0, build: BUILD_ID });

        const stale = await as('alice', rig.app, '/m');
        expect(stale.headers.get('x-azeroth-cache')).toBe('stale');
        expect(await stale.text()).toContain('OLD-PRIVATE');
        await settle();

        // regenerate rendered a STAMPED result: entry dropped, pathname learned.
        expect(rig.cache.entries.has('/m')).toBe(false);
        const next = await as('mallory', rig.app, '/m');
        expect(next.status).toBe(403);
        expect(await next.text()).not.toContain('OLD-PRIVATE');
        expect(next.headers.get('x-azeroth-cache')).toBe('live');
        // The still-on-disk seed file must not have refilled the cache (the v1 loop).
        expect(rig.cache.entries.has('/m')).toBe(false);
        const third = await as('alice', rig.app, '/m');
        expect(await third.text()).not.toContain('SEEDED-GUARDLESS');
        expect(rig.cache.entries.has('/m')).toBe(false);
    });

    it('coalesced discovery: the creator keeps its own render, the joiner re-renders under its own identity', async () =>
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

        // The creator keeps her own render; the vetoed joiner re-renders under her own
        // identity - pre-fix she received alice's body off the shared promise.
        expect(alice.status).toBe(200);
        expect(await alice.text()).toContain('PRIVATE-BALANCE-alice');
        expect(mallory.status).toBe(403);
        expect(await mallory.text()).not.toContain('alice');
        // Discovery costs N+1 renders: the creator's plus one per joiner.
        expect(rig.renders()).toBe(2);
        expect(rig.cache.sets).toEqual([]);
        // From here on the pathname is learned: no more flights, still nothing cached.
        const after = await as('alice', rig.app, '/m');
        expect(after.headers.get('x-azeroth-cache')).toBe('live');
        expect(rig.cache.sets).toEqual([]);
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
