// @vitest-environment node
//
// What a regeneration keeps, what it drops, the language it renders in, and what it reports.
// Settled on the cache write or the notice itself, never on a timer.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { App } from '@azerothjs/http';
import { MemoryPageCache, mountPages, type PageCache, type PageEntry, type PageRoute } from '@azerothjs/kit';
import type { PageRenderOptions, PageResult } from '@azerothjs/kit/ssr';
import { registerIsr } from '../src/isr.ts';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';
const component = (): HTMLElement => (undefined as unknown as HTMLElement);

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

type Renderer = (url: string, shell: string, options?: PageRenderOptions) => Promise<PageResult>;
interface Report
{
    error: unknown;
    path: string;
    phase: string;
}

interface Rig
{
    app: App;
    dir: string;
    errors: Report[];
    peek: (key: string) => Promise<PageEntry | undefined>;
    /** Resolves when the next cache write or drop lands. */
    nextWrite: () => Promise<'set' | 'delete'>;
    /** Resolves with the next report. */
    nextReport: () => Promise<Report>;
    /** Removes the entry behind the handler's back, as an eviction would. */
    drop: (key: string) => Promise<void>;
}

function build(routes: PageRoute[], renderer: Renderer, locales?: { supported: string[]; routing?: 'prefix' }): Rig
{
    const dir = mkdtempSync(join(tmpdir(), 'az-isr-life-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    dirs.push(dir);

    const inner = new MemoryPageCache();
    let writeWaiters: Array<(event: 'set' | 'delete') => void> = [];
    const wrote = (event: 'set' | 'delete'): void =>
    {
        const waiters = writeWaiters;
        writeWaiters = [];
        for (const resolve of waiters)
        {
            resolve(event);
        }
    };
    const cache: PageCache = {
        get: (key) => inner.get(key),
        set: async (key, entry) =>
        {
            await inner.set(key, entry);
            wrote('set');
        },
        delete: async (key) =>
        {
            await inner.delete(key);
            wrote('delete');
        }
    };

    const errors: Report[] = [];
    let reportWaiters: Array<(report: Report) => void> = [];
    const app = new App();
    mountPages(app, {
        routes,
        clientDir: dir,
        cache,
        renderer,
        ...(locales !== undefined ? { locales } : {}),
        onError: (error, context) =>
        {
            const report = { error, path: context.path, phase: context.phase };
            errors.push(report);
            const waiters = reportWaiters;
            reportWaiters = [];
            for (const resolve of waiters)
            {
                resolve(report);
            }
        }
    });
    return {
        app,
        dir,
        errors,
        peek: (key) => inner.get(key),
        drop: (key) => inner.delete(key),
        nextWrite: () => new Promise((resolve) => writeWaiters.push(resolve)),
        nextReport: () => new Promise((resolve) => reportWaiters.push(resolve))
    };
}

const get = (app: App, path: string, headers: Record<string, string> = {}): Promise<Response> =>
    app.handle(new Request(`http://local${ path }`, { headers }));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const page = (body: string): PageResult => ({ kind: 'html', status: 200, html: `<html><body>${ body }</body></html>` });

describe.each([
    ['prefix routing', { supported: ['en', 'fa'], routing: 'prefix' as const }, '/fa/about', {}],
    ['negotiation', { supported: ['en', 'fa'] }, '/about', { cookie: 'locale=fa' }]
])('a regenerated copy keeps its language under %s', (_mode, locales, path, headers) =>
{
    it('is produced in the language it is filed under', async () =>
    {
        let renders = 0;
        const rig = build(
            [{ path: '/about', component, render: 'static', revalidate: 0.01 }],
            (_url, _shell, options) =>
            {
                renders++;
                return Promise.resolve(page(`R${ renders } LOCALE=${ options?.locale ?? '-' }`));
            },
            locales
        );
        expect(await (await get(rig.app, path, headers)).text()).toContain('R1 LOCALE=fa');
        expect((await get(rig.app, path, headers)).headers.get('x-azeroth-cache')).toBe('hit');
        await sleep(30);

        const written = rig.nextWrite();
        const stale = await get(rig.app, path, headers);
        expect(stale.headers.get('x-azeroth-cache')).toBe('stale');
        expect(await stale.text()).toContain('R1 LOCALE=fa');
        expect(await written).toBe('set');

        const fresh = await get(rig.app, path, headers);
        expect(fresh.headers.get('x-azeroth-cache')).toBe('hit');
        expect(await fresh.text()).toContain('R2 LOCALE=fa');
        expect(renders).toBe(2);
    });
});

describe('what a regeneration keeps and what it drops', () =>
{
    const rows: Array<[string, () => PageResult | Promise<PageResult>, 'keep' | 'drop' | 'guarded' | 'write']> = [
        ['a throw', () => Promise.reject(new Error('render threw')), 'keep'],
        ['kind error', () => ({ kind: 'error', status: 500, html: '<p>failed</p>' }), 'keep'],
        ['a redirect', () => ({ kind: 'redirect', to: '/login', replace: true }), 'drop'],
        ['a refused redirect', () => ({ kind: 'refused-redirect', target: 'https://evil.example/x' }), 'drop'],
        ['a veto', () => ({ kind: 'blocked', status: 403, html: '<p>no</p>' }), 'drop'],
        ['html 404', () => ({ kind: 'html', status: 404, html: '<p>gone</p>' }), 'drop'],
        ['html 503', () => ({ kind: 'html', status: 503, html: '<p>busy</p>' }), 'drop'],
        ['a stream', () => ({ kind: 'stream', status: 200, stream: new ReadableStream<Uint8Array>() }), 'drop'],
        ['an unknown kind', () => ({ kind: 'mystery' } as unknown as PageResult), 'drop'],
        ['html 200 guarded', () => ({ kind: 'html', status: 200, html: '<p>secret</p>', guarded: true }), 'guarded'],
        ['html 200', () => page('NEW'), 'write']
    ];

    it.each(rows)('%s -> %s', async (_label, outcome, disposition) =>
    {
        let warm = true;
        const rig = build(
            [{ path: '/about', component, render: 'static', revalidate: 0.01 }],
            () => (warm ? Promise.resolve(page('OLD')) : Promise.resolve(outcome()))
        );
        expect(await (await get(rig.app, '/about')).text()).toContain('OLD');
        warm = false;
        await sleep(30);

        const settled = disposition === 'keep' ? rig.nextReport() : rig.nextWrite();
        const stale = await get(rig.app, '/about');
        expect(stale.headers.get('x-azeroth-cache')).toBe('stale');
        await settled;

        const entry = await rig.peek('/about');
        if (disposition === 'keep')
        {
            expect(entry?.html).toContain('OLD');
            const next = await get(rig.app, '/about');
            expect(next.status).toBe(200);
            expect(next.headers.get('x-azeroth-cache')).toBe('stale');
            expect(await next.text()).toContain('OLD');
        }
        else if (disposition === 'write')
        {
            expect(entry?.html).toContain('NEW');
            const next = await get(rig.app, '/about');
            expect(next.headers.get('x-azeroth-cache')).toBe('hit');
            expect(await next.text()).toContain('NEW');
        }
        else
        {
            expect(entry).toBeUndefined();
            if (disposition === 'guarded')
            {
                expect((await get(rig.app, '/about')).headers.get('x-azeroth-cache')).toBe('live');
            }
        }
    });
});

describe('what a failed regeneration reports', () =>
{
    async function tripStale(renderer: Renderer): Promise<Rig>
    {
        const rig = build([{ path: '/about', component, render: 'static', revalidate: 0.01 }], renderer);
        await get(rig.app, '/about');
        await sleep(30);
        const reported = rig.nextReport();
        await get(rig.app, '/about');
        await reported;
        return rig;
    }

    it('one notice, carrying the level that failed as its cause, and no raw report beside it', async () =>
    {
        let warm = true;
        const upstream = new Error('orders service down');
        const rig = await tripStale((_url, _shell, options) =>
        {
            if (warm)
            {
                warm = false;
                return Promise.resolve(page('OLD'));
            }
            options?.onError?.(upstream);
            return Promise.resolve({ kind: 'error', status: 500, html: '<p>failed</p>' });
        });
        expect(rig.errors).toHaveLength(1);
        const notice = rig.errors[0] as Report;
        expect(notice.phase).toBe('revalidate');
        expect(notice.path).toBe('/about');
        expect((notice.error as Error).message).toContain('kept');
        expect((notice.error as Error).cause).toBe(upstream);
    });

    it('two failed levels arrive as one AggregateError', async () =>
    {
        let warm = true;
        const rig = await tripStale((_url, _shell, options) =>
        {
            if (warm)
            {
                warm = false;
                return Promise.resolve(page('OLD'));
            }
            options?.onError?.(new Error('level 0'));
            options?.onError?.(new Error('level 1'));
            return Promise.resolve({ kind: 'error', status: 500, html: '<p>failed</p>' });
        });
        const cause = (rig.errors[0]?.error as Error).cause;
        expect(cause).toBeInstanceOf(AggregateError);
        expect((cause as AggregateError).errors.map((error) => (error as Error).message)).toEqual(['level 0', 'level 1']);
    });

    it('a render that throws reports the thrown value as the cause', async () =>
    {
        let warm = true;
        const thrown = new Error('render threw');
        const rig = await tripStale(() =>
        {
            if (warm)
            {
                warm = false;
                return Promise.resolve(page('OLD'));
            }
            return Promise.reject(thrown);
        });
        expect(rig.errors).toHaveLength(1);
        expect((rig.errors[0]?.error as Error).cause).toBe(thrown);
    });

    it('a cold production forwards each failed level as it happens, and answers 500 never stored', async () =>
    {
        const upstream = new Error('orders service down');
        const rig = build([{ path: '/about', component, render: 'static', revalidate: 60 }], (_url, _shell, options) =>
        {
            options?.onError?.(upstream);
            return Promise.resolve({ kind: 'error', status: 500, html: '<p>failed</p>' });
        });
        const response = await get(rig.app, '/about');
        expect(response.status).toBe(500);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(rig.errors).toEqual([{ error: upstream, path: '/about', phase: 'render' }]);
        expect(await rig.peek('/about')).toBeUndefined();
    });
});

// A failed regeneration holds its key for one window and reports once per fault.
describe('a failing regeneration is held for a window and reported once per fault', () =>
{
    const WINDOW = 0.06;

    /** Warms the key, backdates it past the window, then storms it for `windows` windows. */
    type Storming = (attempt: number, options?: PageRenderOptions) => Promise<PageResult>;

    async function storm(renderer: Storming, windows: number): Promise<{ rig: Rig; attempts: number[]; elapsed: number }>
    {
        const attempts: number[] = [];
        const rig = build([{ path: '/about', component, render: 'static', revalidate: WINDOW }], (_url, _shell, options) =>
        {
            attempts.push(Date.now());
            return renderer(attempts.length, options);
        });
        await get(rig.app, '/about');
        attempts.length = 0;
        await sleep(WINDOW * 1000 + 15);
        const started = Date.now();
        const until = started + windows * WINDOW * 1000;
        while (Date.now() < until)
        {
            await get(rig.app, '/about');
            await sleep(4);
        }
        await sleep(20);
        return { rig, attempts, elapsed: Date.now() - started };
    }

    it('a constant fault: attempts bounded by the window, one notice, every reader served stale', async () =>
    {
        let warm = true;
        const { rig, attempts, elapsed } = await storm(() =>
        {
            if (warm)
            {
                warm = false;
                return Promise.resolve(page('OLD'));
            }
            return Promise.reject(new Error('upstream down'));
        }, 3.4);
        const windows = elapsed / (WINDOW * 1000);
        expect(attempts.length).toBeGreaterThanOrEqual(2);
        expect(attempts.length).toBeLessThanOrEqual(Math.floor(windows) + 1);
        for (let i = 1; i < attempts.length; i++)
        {
            expect((attempts[i] as number) - (attempts[i - 1] as number)).toBeGreaterThanOrEqual(WINDOW * 1000 - 10);
        }
        expect(rig.errors).toHaveLength(1);
        expect(await (await get(rig.app, '/about')).text()).toContain('OLD');
    });

    it('a NEW fault reports again; the same one stays quiet', async () =>
    {
        let phase = 0;
        const { rig, attempts } = await storm((attempt) =>
        {
            if (phase === 0)
            {
                phase = 1;
                return Promise.resolve(page('OLD'));
            }
            return Promise.reject(new Error(attempt <= 1 ? 'CAUSE-A' : 'CAUSE-B'));
        }, 3.4);
        expect(attempts.length).toBeGreaterThanOrEqual(2);
        const causes = rig.errors.map((report) => ((report.error as Error).cause as Error).message);
        expect(causes).toEqual(['CAUSE-A', 'CAUSE-B']);
    });

    it('a cause that is not an Error never throws, and distinct strings are distinct faults', async () =>
    {
        let phase = 0;
        const values: unknown[] = [null, undefined, 'first', 'second', 'second'];
        const { rig, attempts } = await storm((attempt) =>
        {
            if (phase === 0)
            {
                phase = 1;
                return Promise.resolve(page('OLD'));
            }
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the arm is about a loader that rejects with anything
            return Promise.reject(values[Math.min(attempt - 1, values.length - 1)]);
        }, 5.4);
        expect(attempts.length).toBeGreaterThanOrEqual(4);
        const causes = rig.errors.map((report) => (report.error as Error).cause);
        expect(causes.slice(0, 4)).toEqual([null, undefined, 'first', 'second']);
        expect(rig.errors.length).toBeLessThanOrEqual(4);
    });

    it('a write landing during a failing attempt leaves the key unheld and unnoticed; the next failure reports', async () =>
    {
        let mode: 'warm' | 'slow-fail' | 'ok' | 'fail' = 'warm';
        let slowStarted: (() => void) | undefined;
        let release: (() => void) | undefined;
        const started = new Promise<void>((resolve) =>
        {
            slowStarted = resolve;
        });
        const held = new Promise<void>((resolve) =>
        {
            release = resolve;
        });
        const rig = build([{ path: '/about', component, render: 'static', revalidate: WINDOW }], () =>
        {
            if (mode === 'warm')
            {
                mode = 'slow-fail';
                return Promise.resolve(page('OLD'));
            }
            if (mode === 'slow-fail')
            {
                mode = 'ok';
                slowStarted?.();
                return held.then(() => Promise.reject(new Error('slow failure')));
            }
            if (mode === 'ok')
            {
                mode = 'fail';
                return Promise.resolve(page('NEW'));
            }
            return Promise.reject(new Error('later failure'));
        });
        await get(rig.app, '/about');
        await sleep(WINDOW * 1000 + 15);
        await get(rig.app, '/about'); // trips the slow failing regeneration
        await started;
        // The entry goes away while the attempt is in flight, and a reader produces a fresh one.
        await rig.drop('/about');
        const written = rig.nextWrite();
        expect(await (await get(rig.app, '/about')).text()).toContain('NEW');
        expect(await written).toBe('set');
        release?.();
        await sleep(30);
        // The attempt landed after the write: nothing reported, nothing held.
        expect(rig.errors).toHaveLength(0);
        await sleep(WINDOW * 1000 + 15);
        const reported = rig.nextReport();
        await get(rig.app, '/about'); // stale again: a regeneration starts at once and fails
        await reported;
        expect(rig.errors).toHaveLength(1);
        expect(((rig.errors[0] as Report).error as Error).message).toContain('kept');
    });

    it('a warm entry under a 0 ms failing loader renders at most once per window', async () =>
    {
        let warm = true;
        const { attempts, elapsed } = await storm(() =>
        {
            if (warm)
            {
                warm = false;
                return Promise.resolve(page('OLD'));
            }
            return Promise.resolve({ kind: 'error', status: 500, html: '<p>failed</p>' });
        }, 2.4);
        expect(attempts.length).toBeLessThanOrEqual(Math.floor(elapsed / (WINDOW * 1000)) + 1);
    });
});

// The hold map's backstop: at the ceiling an expired hold goes first, then the soonest to
// expire - never the first inserted, which a re-armed key still is.
describe('the hold map at its ceiling', () =>
{
    const WINDOW = 0.06;

    it('evicts the soonest-expiring hold, so a key held later keeps its hold', async () =>
    {
        const failing = new Set<string>();
        const attempts = new Map<string, number>();
        const errors: string[] = [];
        const app = new App();
        registerIsr({
            app,
            path: '/p/:id',
            revalidate: WINDOW,
            cache: new MemoryPageCache(),
            renderer: (url: string): Promise<PageResult> =>
            {
                attempts.set(url, (attempts.get(url) ?? 0) + 1);
                return failing.has(url) ? Promise.reject(new Error('down')) : Promise.resolve(page(`OK ${ url }`));
            },
            shell: Promise.resolve(SHELL),
            seedFile: () => Promise.resolve(null),
            guarded: () => false,
            onError: (error) => void errors.push((error as Error).message),
            buildId: Promise.resolve('build'),
            artifactPath: (pathname) => pathname,
            holdCeiling: 3
        });
        const keys = ['/p/a', '/p/b', '/p/c', '/p/d'];
        for (const key of keys)
        {
            await get(app, key);
            failing.add(key);
        }
        const fail = async (key: string): Promise<void> =>
        {
            await get(app, key);
            await sleep(8);
        };
        // Window 1: b, c, a hold in that insertion order.
        await sleep(WINDOW * 1000 + 15);
        await fail('/p/b');
        await fail('/p/c');
        await fail('/p/a');
        // Window 2: all three expired; re-arm a in place FIRST (oldest position, newest expiry
        // among the three so far), then b and c, which now expire after a. Then d fills the map.
        await sleep(WINDOW * 1000 + 15);
        await fail('/p/a');
        await fail('/p/b');
        await fail('/p/c');
        await fail('/p/d');
        // The soonest to expire is a; the first inserted is b. b must still be held: a stale
        // request inside its window regenerates nothing.
        const before = attempts.get('/p/b');
        await get(app, '/p/b');
        await sleep(15);
        expect(attempts.get('/p/b')).toBe(before);
        // And a, whose hold went, regenerates once more inside the window.
        const beforeA = attempts.get('/p/a');
        await get(app, '/p/a');
        await sleep(15);
        expect(attempts.get('/p/a')).toBe((beforeA as number) + 1);
    });
});

describe('an ISR page under prefix routing', () =>
{
    const PREFIX = { supported: ['en', 'fa'], routing: 'prefix' as const };
    const echo = (attempt: number, options?: PageRenderOptions): PageResult =>
        page(`R${ attempt } LOCALE=${ options?.locale ?? '-' } BASE=${ options?.base ?? '-' }`);

    it('produces and regenerates the copy under its base', async () =>
    {
        let renders = 0;
        const rig = build(
            [{ path: '/about', component, render: 'static', revalidate: 0.01 }],
            (_url, _shell, options) => Promise.resolve(echo(++renders, options)),
            PREFIX
        );
        expect(await (await get(rig.app, '/fa/about')).text()).toContain('R1 LOCALE=fa BASE=/fa');
        await sleep(30);
        const written = rig.nextWrite();
        await get(rig.app, '/fa/about');
        expect(await written).toBe('set');
        expect(await (await get(rig.app, '/fa/about')).text()).toContain('R2 LOCALE=fa BASE=/fa');
    });

    it('refuses an unstamped seed before it can enter the cache', async () =>
    {
        let renders = 0;
        const rig = build(
            [{ path: '/about', component, render: 'static', revalidate: 60 }],
            (_url, _shell, options) => Promise.resolve(echo(++renders, options)),
            PREFIX
        );
        mkdirSync(join(rig.dir, 'about'), { recursive: true });
        writeFileSync(join(rig.dir, 'about', 'index.fa.html'), '<html lang="fa"><body>UNSTAMPED SEED</body></html>');
        const response = await get(rig.app, '/fa/about');
        expect(response.status).toBe(500);
        expect(await response.text()).not.toContain('UNSTAMPED');
        expect(renders).toBe(0);
        expect(await rig.peek('fa\u0000/about')).toBeUndefined();
        expect((rig.errors[0]?.error as Error).message).toContain('index.fa.html');
        expect((rig.errors[0]?.error as Error).message).toContain("routing: 'prefix'");
        // A stamped seed serves and seeds.
        writeFileSync(join(rig.dir, 'about', 'index.fa.html'), '<html lang="fa" data-azeroth-base="/fa"><body>STAMPED SEED</body></html>');
        const seeded = await get(rig.app, '/fa/about');
        expect(seeded.status).toBe(200);
        expect(await seeded.text()).toContain('STAMPED SEED');
        expect(renders).toBe(0);
    });

    it('a cold page whose loader redirects answers in the request\'s url space and caches nothing', async () =>
    {
        const rig = build(
            [{ path: '/news', component, render: 'static', revalidate: 60 }],
            () => Promise.resolve({ kind: 'redirect', to: '/login', replace: false }),
            PREFIX
        );
        const response = await get(rig.app, '/fa/news');
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('/fa/login');
        expect(await rig.peek('fa\u0000/news')).toBeUndefined();
    });
});
