// @vitest-environment node
//
// A write reaches the ISR page it redirects to. A page action that lands a visitor on a cached
// page - by redirecting there, or by covering its url with a wildcard - marks that page, and
// `revalidate(path)` marks one for a write that happened somewhere else; the next reader of ANY
// copy of it renders fresh instead of being handed a copy made before the write. Measured
// before this existed: the redirected visitor's GET answered `hit` with the pre-write body.
//
// The ledger is process-wide and never cleared, so every arm owns its own pathname - a stamp
// one arm leaves would otherwise skip a later arm's seed for the rest of the file.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { redirect, unsafeUrl } from 'azerothjs';
import { App, csrfToken } from '@azerothjs/http';
import { mountPages, revalidate, type PageCache, type PageEntry, type PageRoute } from '@azerothjs/kit';
import type { PageRenderOptions, PageResult } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';
const COOKIE = 'azcsrf';
const component = (): HTMLElement => (undefined as unknown as HTMLElement);

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
    const dir = mkdtempSync(join(tmpdir(), 'az-isr-rv-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    dirs.push(dir);
    return dir;
}

/** The page's data: one cell a loader reads and an action writes. */
interface Source
{
    value: string;
}

interface SpyCache extends PageCache
{
    sets: string[];
    entries: Map<string, PageEntry>;
    releaseSet: () => void;

    /** Settles when the parked write has been entered, so an arm can order a mark after it. */
    entered: Promise<void>;
}

/** A PageCache that records every write and can park the FIRST one, mid-flight. */
function spyCache(holdFirstSet: boolean): SpyCache
{
    const entries = new Map<string, PageEntry>();
    const sets: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) =>
    {
        release = resolve;
    });
    let enter: () => void = () => undefined;
    const entered = new Promise<void>((resolve) =>
    {
        enter = resolve;
    });
    let parks = holdFirstSet;
    return {
        entries,
        sets,
        entered,
        releaseSet: () => release(),
        get: (key) => Promise.resolve(entries.get(key)),
        set: async (key, entry) =>
        {
            if (parks)
            {
                parks = false;
                enter();
                await held;
            }
            sets.push(key);
            entries.set(key, entry);
        },
        delete: (key) =>
        {
            entries.delete(key);
            return Promise.resolve();
        }
    };
}

interface Rig
{
    app: App;
    dir: string;
    cache: SpyCache;
    renders: () => number;
    release: () => void;
    fail: (failing: boolean) => void;
    errors: Array<{ error: unknown; path: string; phase: string }>;

    /** Settles when the parked render has snapshotted its data and stopped at the gate. */
    entered: Promise<void>;
}

interface RigOptions
{
    dir?: string;
    locales?: { supported: string[]; routing?: 'prefix' };

    /** Which render to park, so a write can land while that one is in flight. */
    holdRender?: number;
    holdFirstSet?: boolean;
}

/**
 * One mount over a mutable source. The renderer snapshots the value the way a loader does -
 * BEFORE the gate - so a render parked open answers with what it read when it started.
 */
function build(routes: PageRoute[], source: Source, options: RigOptions = {}): Rig
{
    const dir = options.dir ?? clientDir();
    const cache = spyCache(options.holdFirstSet === true);
    const errors: Rig['errors'] = [];
    let failing = false;
    let count = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) =>
    {
        release = resolve;
    });
    let enter: () => void = () => undefined;
    const entered = new Promise<void>((resolve) =>
    {
        enter = resolve;
    });
    const renderer = async (url: string, _shell: string, renderOptions?: PageRenderOptions): Promise<PageResult> =>
    {
        count++;
        const at = count;
        const seen = source.value;
        if (at === options.holdRender)
        {
            enter();
            await held;
        }
        if (failing)
        {
            renderOptions?.onError?.(new Error('the loader blew up'));
            return { kind: 'error', status: 500, html: '<html><body>LOADER-FAILED</body></html>' };
        }
        return { kind: 'html', status: 200, html: `<html><body>DATA:${ seen }|R${ at }:${ url }</body></html>` };
    };
    const app = new App();
    mountPages(app, {
        routes,
        clientDir: dir,
        renderer,
        cache,
        csrf: { cookie: COOKIE },
        ...(options.locales !== undefined ? { locales: options.locales } : {}),
        onError: (error, context): void => void errors.push({ error, path: context.path, phase: context.phase })
    });
    return {
        app,
        dir,
        cache,
        errors,
        entered,
        renders: () => count,
        release: () => release(),
        fail: (next: boolean) =>
        {
            failing = next;
        }
    };
}

/** An action that writes and then redirects - the shape the defect was found on. */
const writeThenRedirect = (source: Source, to: string) => async (): Promise<undefined> =>
{
    source.value = 'second';
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the documented redirect sentinel
    throw redirect(to);
};

/** An action that writes and returns nothing, so the visitor is sent back to the arriving url. */
const writeInPlace = (source: Source) => (): Promise<undefined> =>
{
    source.value = 'second';
    return Promise.resolve(undefined);
};

const get = (app: App, path: string, headers: Record<string, string> = {}): Promise<Response> =>
    app.handle(new Request(`http://local${ path }`, { headers: { accept: 'text/html', ...headers } }));

const post = (app: App, path: string, headers: Record<string, string> = {}): Promise<Response> =>
{
    const token = csrfToken();
    return app.handle(new Request(`http://local${ path }`, {
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            cookie: `${ COOKIE }=${ token }`,
            origin: 'http://local',
            ...headers
        },
        body: new URLSearchParams({ _csrf: token, text: 'x' }).toString()
    }));
};

const verdict = (response: Response): string | null => response.headers.get('x-azeroth-cache');

async function settle(): Promise<void>
{
    await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * A mark stamps whole milliseconds, so anything stamped inside the marked one counts as
 * unordered with the write: a render started there is discarded rather than cached, and a file
 * mtime there is not older than the mark (mtimes carry a fraction, Date.now() does not). An arm
 * that needs the two ordered waits for the clock to leave that millisecond.
 */
async function pastThisMillisecond(): Promise<void>
{
    const at = Date.now();
    while (Date.now() <= at)
    {
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}

describe('a write reaches the page it lands on', () =>
{
    it('Regression: the visitor a write redirects to reads the copy made before the write', async () =>
    {
        const source: Source = { value: 'first' };
        const rig = build([
            { path: '/r1-book', component, render: 'static', revalidate: 300 },
            { path: '/r1-other', component, render: 'static', revalidate: 300 },
            { path: '/r1-write', component, render: 'server', action: writeThenRedirect(source, '/r1-book') }
        ], source);

        expect(verdict(await get(rig.app, '/r1-book'))).toBe('miss');
        expect(verdict(await get(rig.app, '/r1-book'))).toBe('hit');
        expect(verdict(await get(rig.app, '/r1-other'))).toBe('miss');
        expect(verdict(await get(rig.app, '/r1-other'))).toBe('hit');

        const sent = await post(rig.app, '/r1-write');
        expect(sent.status).toBe(303);
        expect(sent.headers.get('location')).toBe('/r1-book');

        const landing = await get(rig.app, '/r1-book');
        expect(verdict(landing)).toBe('miss');
        expect(await landing.text()).toContain('DATA:second');

        // CONTROL: a page the write never lands on keeps its copy.
        const untouched = await get(rig.app, '/r1-other');
        expect(verdict(untouched)).toBe('hit');
        expect(await untouched.text()).toContain('DATA:first');
    });

    it('the enhanced submit carries no cache signal, so the next document load must render', async () =>
    {
        const source: Source = { value: 'first' };
        const rig = build([
            { path: '/r2-book', component, render: 'static', revalidate: 300 },
            { path: '/r2-write', component, render: 'server', action: writeThenRedirect(source, '/r2-book') }
        ], source);

        expect(verdict(await get(rig.app, '/r2-book'))).toBe('miss');
        expect(verdict(await get(rig.app, '/r2-book'))).toBe('hit');

        const answered = await post(rig.app, '/r2-write', { accept: 'application/json' });
        expect(await answered.json()).toEqual({ ok: true, redirect: '/r2-book' });

        const landing = await get(rig.app, '/r2-book');
        expect(verdict(landing)).toBe('miss');
        expect(await landing.text()).toContain('DATA:second');
    });

    it('a wildcard action covering an ISR sibling marks it, declared after it or before it', async () =>
    {
        const after: Source = { value: 'first' };
        const afterRig = build([
            { path: '/w1/book', component, render: 'static', revalidate: 300 },
            { path: '/w1/*rest', component, render: 'server', action: writeInPlace(after) }
        ], after);
        expect(verdict(await get(afterRig.app, '/w1/book'))).toBe('miss');
        expect(verdict(await get(afterRig.app, '/w1/book'))).toBe('hit');

        // The ISR page registers GET only, so the POST dead-ends there and the wildcard's
        // action answers it - a 303 back to the url the writer arrived at.
        const sent = await post(afterRig.app, '/w1/book');
        expect(sent.status).toBe(303);
        expect(sent.headers.get('location')).toBe('/w1/book');
        const landing = await get(afterRig.app, '/w1/book');
        expect(verdict(landing)).toBe('miss');
        expect(await landing.text()).toContain('DATA:second');

        const before: Source = { value: 'first' };
        const beforeRig = build([
            { path: '/w2/*rest', component, render: 'server', action: writeInPlace(before) },
            { path: '/w2/book', component, render: 'static', revalidate: 300 }
        ], before);
        expect(verdict(await get(beforeRig.app, '/w2/book'))).toBe('miss');
        expect(verdict(await get(beforeRig.app, '/w2/book'))).toBe('hit');

        // Order-first selection would pick the wildcard for this url; any ISR pattern the
        // pathname matches counts, so the sibling is marked whichever was declared first.
        expect((await post(beforeRig.app, '/w2/book')).status).toBe(303);
        const second = await get(beforeRig.app, '/w2/book');
        expect(verdict(second)).toBe('miss');
        expect(await second.text()).toContain('DATA:second');
    });
});

describe('the spelling of the target does not decide whether the write is seen', () =>
{
    it('a relative redirect resolves against the arriving url', async () =>
    {
        const source: Source = { value: 'first' };
        const rig = build([
            { path: '/s1/book', component, render: 'static', revalidate: 300 },
            { path: '/s1/shop/checkout', component, render: 'server', action: writeThenRedirect(source, '../book') }
        ], source);

        expect(verdict(await get(rig.app, '/s1/book'))).toBe('miss');
        expect(verdict(await get(rig.app, '/s1/book'))).toBe('hit');

        const sent = await post(rig.app, '/s1/shop/checkout');
        // Without a url prefix the Location is the target verbatim; the browser resolves it.
        expect(sent.headers.get('location')).toBe('../book');

        const landing = await get(rig.app, '/s1/book');
        expect(verdict(landing)).toBe('miss');
        expect(await landing.text()).toContain('DATA:second');
    });

    it('a decoded non-ASCII target marks the encoded url the reader asks for', async () =>
    {
        const source: Source = { value: 'first' };
        const rig = build([
            { path: '/tag/:slug', component, render: 'static', revalidate: 300 },
            { path: '/t1-write', component, render: 'server', action: writeThenRedirect(source, '/tag/caf\u00e9') }
        ], source);

        // A raw-byte request answers 400, so the percent-encoded spelling is the only reader.
        expect(verdict(await get(rig.app, '/tag/caf%C3%A9'))).toBe('miss');
        expect(verdict(await get(rig.app, '/tag/caf%C3%A9'))).toBe('hit');

        const sent = await post(rig.app, '/t1-write');
        expect(sent.headers.get('location')).toBe('/tag/caf\u00e9');

        const landing = await get(rig.app, '/tag/caf%C3%A9');
        expect(verdict(landing)).toBe('miss');
        expect(await landing.text()).toContain('DATA:second');
    });

    it('an escape spelling the reader typed is covered by the mark the app writes', async () =>
    {
        const source: Source = { value: 'first' };
        const rig = build([
            { path: '/pe/:slug', component, render: 'static', revalidate: 300 },
            { path: '/pa/:slug', component, render: 'static', revalidate: 300 },
            { path: '/pe-write', component, render: 'server', action: writeThenRedirect(source, '/pe/caf\u00e9') },
            { path: '/pa-write', component, render: 'server', action: writeThenRedirect(source, '/pa/book') }
        ], source);

        // A hand-typed href reaches the server as typed and warms its own entry: lowercase hex
        // and an escaped unreserved letter are two more keys of the same two pages.
        expect(verdict(await get(rig.app, '/pe/caf%c3%a9'))).toBe('miss');
        expect(verdict(await get(rig.app, '/pe/caf%c3%a9'))).toBe('hit');
        expect(verdict(await get(rig.app, '/pa/bo%6Fk'))).toBe('miss');
        expect(verdict(await get(rig.app, '/pa/bo%6Fk'))).toBe('hit');

        expect((await post(rig.app, '/pe-write')).status).toBe(303);
        expect((await post(rig.app, '/pa-write')).status).toBe(303);

        for (const url of ['/pe/caf%c3%a9', '/pa/bo%6Fk'])
        {
            const response = await get(rig.app, url);
            expect(verdict(response)).toBe('miss');
            expect(await response.text()).toContain('DATA:second');
        }
    });

    it('revalidate() takes the same two spellings, plus a trailing slash', async () =>
    {
        const source: Source = { value: 'first' };
        const rig = build([
            { path: '/s2/book', component, render: 'static', revalidate: 300 },
            { path: '/tag2/:slug', component, render: 'static', revalidate: 300 }
        ], source);

        expect(verdict(await get(rig.app, '/s2/book'))).toBe('miss');
        expect(verdict(await get(rig.app, '/s2/book'))).toBe('hit');
        expect(verdict(await get(rig.app, '/tag2/caf%C3%A9'))).toBe('miss');
        expect(verdict(await get(rig.app, '/tag2/caf%C3%A9'))).toBe('hit');

        source.value = 'second';
        revalidate('/s2/book/');
        revalidate('/tag2/caf\u00e9');

        const plain = await get(rig.app, '/s2/book');
        expect(verdict(plain)).toBe('miss');
        expect(await plain.text()).toContain('DATA:second');
        const encoded = await get(rig.app, '/tag2/caf%C3%A9');
        expect(verdict(encoded)).toBe('miss');
        expect(await encoded.text()).toContain('DATA:second');
    });

    it('an off-origin redirect marks nothing, however its path reads', async () =>
    {
        const source: Source = { value: 'first' };
        const away = async (): Promise<undefined> =>
        {
            source.value = 'second';
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- the documented redirect sentinel
            throw redirect(unsafeUrl('https://evil.example/x1-book'));
        };
        const rig = build([
            { path: '/x1-book', component, render: 'static', revalidate: 300 },
            { path: '/x1-write', component, render: 'server', action: away }
        ], source);

        expect(verdict(await get(rig.app, '/x1-book'))).toBe('miss');
        expect(verdict(await get(rig.app, '/x1-book'))).toBe('hit');

        const sent = await post(rig.app, '/x1-write');
        expect(sent.headers.get('location')).toBe('https://evil.example/x1-book');

        // The path of a foreign origin names no page of this app.
        const local = await get(rig.app, '/x1-book');
        expect(verdict(local)).toBe('hit');
        expect(await local.text()).toContain('DATA:first');
    });
});

describe('one mark covers every key of the page', () =>
{
    it('both slash spellings and a query variant each render fresh on their next read', async () =>
    {
        const source: Source = { value: 'first' };
        const rig = build([
            { path: '/k1-book', component, render: 'static', revalidate: 300 },
            { path: '/k1-write', component, render: 'server', action: writeThenRedirect(source, '/k1-book') }
        ], source);

        expect(verdict(await get(rig.app, '/k1-book'))).toBe('miss');
        expect(verdict(await get(rig.app, '/k1-book/'))).toBe('miss');
        // A query key earns its slot on the second observation, so it is warmed twice.
        expect(verdict(await get(rig.app, '/k1-book?utm_source=x'))).toBe('miss');
        expect(verdict(await get(rig.app, '/k1-book?utm_source=x'))).toBe('miss');
        expect(verdict(await get(rig.app, '/k1-book'))).toBe('hit');
        expect(verdict(await get(rig.app, '/k1-book/'))).toBe('hit');
        expect(verdict(await get(rig.app, '/k1-book?utm_source=x'))).toBe('hit');

        expect((await post(rig.app, '/k1-write')).status).toBe(303);

        for (const url of ['/k1-book', '/k1-book/', '/k1-book?utm_source=x'])
        {
            const response = await get(rig.app, url);
            expect(verdict(response)).toBe('miss');
            expect(await response.text()).toContain('DATA:second');
        }
    });

    it('a negotiated page renders fresh in every language', async () =>
    {
        const source: Source = { value: 'first' };
        const rig = build([
            { path: '/k2-book', component, render: 'static', revalidate: 300 },
            { path: '/k2-write', component, render: 'server', action: writeThenRedirect(source, '/k2-book') }
        ], source, { locales: { supported: ['en', 'fa'] } });
        const english = { 'accept-language': 'en' };
        const persian = { 'accept-language': 'fa' };

        expect(verdict(await get(rig.app, '/k2-book', english))).toBe('miss');
        expect(verdict(await get(rig.app, '/k2-book', persian))).toBe('miss');
        expect(verdict(await get(rig.app, '/k2-book', english))).toBe('hit');
        expect(verdict(await get(rig.app, '/k2-book', persian))).toBe('hit');

        expect((await post(rig.app, '/k2-write', english)).status).toBe(303);

        for (const headers of [english, persian])
        {
            const response = await get(rig.app, '/k2-book', headers);
            expect(verdict(response)).toBe('miss');
            expect(await response.text()).toContain('DATA:second');
        }
    });

    it('a prefix mount marks the app-space page, so both its urls render fresh', async () =>
    {
        const source: Source = { value: 'first' };
        const rig = build([
            { path: '/k3-book', component, render: 'static', revalidate: 300 },
            { path: '/k3-write', component, render: 'server', action: writeThenRedirect(source, '/k3-book') }
        ], source, { locales: { supported: ['en', 'fa'], routing: 'prefix' } });

        expect(verdict(await get(rig.app, '/en/k3-book'))).toBe('miss');
        expect(verdict(await get(rig.app, '/fa/k3-book'))).toBe('miss');
        expect(verdict(await get(rig.app, '/en/k3-book'))).toBe('hit');
        expect(verdict(await get(rig.app, '/fa/k3-book'))).toBe('hit');

        const sent = await post(rig.app, '/en/k3-write');
        expect(sent.headers.get('location')).toBe('/en/k3-book');

        for (const url of ['/en/k3-book', '/fa/k3-book'])
        {
            const response = await get(rig.app, url);
            expect(verdict(response)).toBe('miss');
            expect(await response.text()).toContain('DATA:second');
        }
    });
});

describe('a marked page never re-seeds its build output', () =>
{
    it('the prerendered file is skipped and the page renders live, once', async () =>
    {
        const dir = clientDir();
        mkdirSync(join(dir, 'seed1'));
        writeFileSync(join(dir, 'seed1', 'index.html'), '<html><body>BUILD-TIME-BYTES</body></html>');
        await pastThisMillisecond();
        const source: Source = { value: 'first' };
        const rig = build([
            { path: '/seed1', component, render: 'static', revalidate: 300 },
            { path: '/seed1-write', component, render: 'server', action: writeThenRedirect(source, '/seed1') }
        ], source, { dir });

        const seeded = await get(rig.app, '/seed1');
        expect(verdict(seeded)).toBe('hit');
        expect(await seeded.text()).toContain('BUILD-TIME-BYTES');
        expect(rig.renders()).toBe(0);

        expect((await post(rig.app, '/seed1-write')).status).toBe(303);

        const landing = await get(rig.app, '/seed1');
        expect(verdict(landing)).toBe('miss');
        const html = await landing.text();
        expect(html).toContain('DATA:second');
        expect(html).not.toContain('BUILD-TIME-BYTES');
        expect(rig.renders()).toBe(1);
    });

    it('a deploy-check drop after a mark costs one live render, not a seed read', async () =>
    {
        const dir = clientDir();
        mkdirSync(join(dir, 'seed2'));
        writeFileSync(join(dir, 'seed2', 'index.html'), '<html><body>BUILD-TIME-BYTES</body></html>');
        const source: Source = { value: 'first' };
        const rig = build([{ path: '/seed2', component, render: 'static', revalidate: 300 }], source, { dir });
        // An entry the PREVIOUS deploy wrote: the build check drops it on read.
        rig.cache.entries.set('/seed2', {
            html: '<html><body>PREVIOUS-BUILD</body></html>',
            status: 200,
            createdAt: Date.now(),
            build: 'a-previous-build'
        });

        source.value = 'second';
        revalidate('/seed2');

        const response = await get(rig.app, '/seed2');
        expect(verdict(response)).toBe('miss');
        const html = await response.text();
        expect(html).toContain('DATA:second');
        expect(html).not.toContain('BUILD-TIME-BYTES');
        expect(html).not.toContain('PREVIOUS-BUILD');
        expect(rig.renders()).toBe(1);
    });
});

describe('nothing rendered before the mark is adopted or cached', () =>
{
    it('a reader arriving after the write does not join the flight that predates it', async () =>
    {
        const source: Source = { value: 'first' };
        const rig = build([
            { path: '/join1', component, render: 'static', revalidate: 300 },
            { path: '/join1-write', component, render: 'server', action: writeThenRedirect(source, '/join1') }
        ], source, { holdRender: 1 });

        const parked = get(rig.app, '/join1');
        await rig.entered;
        expect((await post(rig.app, '/join1-write')).status).toBe(303);
        await pastThisMillisecond();

        const landing = await get(rig.app, '/join1');
        expect(verdict(landing)).toBe('miss');
        expect(await landing.text()).toContain('DATA:second');

        rig.release();
        // The waiter who asked before the write keeps the answer to the question they asked.
        expect(await (await parked).text()).toContain('DATA:first');
        await settle();
        expect(rig.renders()).toBe(2);
        expect(rig.cache.sets).toEqual(['/join1']);
        expect(rig.cache.entries.get('/join1')?.html).toContain('DATA:second');

        const next = await get(rig.app, '/join1');
        expect(verdict(next)).toBe('hit');
        expect(await next.text()).toContain('DATA:second');
    });

    it('a seed parked at its write never becomes what the next reader is served', async () =>
    {
        const dir = clientDir();
        mkdirSync(join(dir, 'join2'));
        writeFileSync(join(dir, 'join2', 'index.html'), '<html><body>BUILD-TIME-BYTES</body></html>');
        await pastThisMillisecond();
        const source: Source = { value: 'first' };
        const rig = build([
            { path: '/join2', component, render: 'static', revalidate: 300 },
            { path: '/join2-write', component, render: 'server', action: writeThenRedirect(source, '/join2') }
        ], source, { dir, holdFirstSet: true });

        const parked = get(rig.app, '/join2');
        await rig.cache.entered;
        expect((await post(rig.app, '/join2-write')).status).toBe(303);

        const landing = await get(rig.app, '/join2');
        expect(verdict(landing)).toBe('miss');
        expect(await landing.text()).toContain('DATA:second');

        rig.cache.releaseSet();
        expect(await (await parked).text()).toContain('BUILD-TIME-BYTES');
        await settle();
        // The artifact copy landed behind the mark, so it answers nobody.
        expect(rig.cache.entries.get('/join2')?.html).toContain('BUILD-TIME-BYTES');

        const next = await get(rig.app, '/join2');
        const html = await next.text();
        expect(html).toContain('DATA:second');
        expect(html).not.toContain('BUILD-TIME-BYTES');
    });

    it('a background regeneration that raced the write does not write, and does not undo it', async () =>
    {
        const source: Source = { value: 'first' };
        const rig = build([{ path: '/bg1', component, render: 'static', revalidate: 0.01 }], source, { holdRender: 2 });

        expect(verdict(await get(rig.app, '/bg1'))).toBe('miss');
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(verdict(await get(rig.app, '/bg1'))).toBe('stale');
        await rig.entered;

        source.value = 'second';
        revalidate('/bg1');
        rig.release();
        await settle();

        // The refresh read the data before the write, so its html reaches no cache at all.
        expect(rig.cache.sets).toEqual(['/bg1']);
        expect(rig.cache.entries.get('/bg1')?.html).toContain('DATA:first');

        const fresh = await get(rig.app, '/bg1');
        expect(verdict(fresh)).toBe('miss');
        expect(await fresh.text()).toContain('DATA:second');
    });
});

describe('what the ledger records, and for whom', () =>
{
    it('an action marks only its own mount\'s ISR pages; revalidate() reaches every mount', async () =>
    {
        const served: Source = { value: 'first' };
        const reader = build([{ path: '/nowhere', component, render: 'static', revalidate: 300 }], served);
        const writer: Source = { value: 'first' };
        const writing = build([
            { path: '/a-write', component, render: 'server', action: writeThenRedirect(writer, '/nowhere') }
        ], writer);

        expect(verdict(await get(reader.app, '/nowhere'))).toBe('miss');
        expect(verdict(await get(reader.app, '/nowhere'))).toBe('hit');

        const sent = await post(writing.app, '/a-write');
        expect(sent.headers.get('location')).toBe('/nowhere');
        served.value = 'second';

        // The writing mount has no ISR page at that url, so its action marks nothing.
        const untouched = await get(reader.app, '/nowhere');
        expect(verdict(untouched)).toBe('hit');
        expect(await untouched.text()).toContain('DATA:first');

        // The explicit call is process-wide and takes no mount's opinion.
        revalidate('/nowhere');
        const fresh = await get(reader.app, '/nowhere');
        expect(verdict(fresh)).toBe('miss');
        expect(await fresh.text()).toContain('DATA:second');
    });

    it('a guard redirect before the action ran marks nothing', async () =>
    {
        const source: Source = { value: 'first' };
        let ran = 0;
        const rig = build([
            { path: '/login-isr', component, render: 'static', revalidate: 300 },
            {
                path: '/gated-write',
                component,
                render: 'server',
                guard: () => '/login-isr',
                action: (): Promise<undefined> =>
                {
                    ran++;
                    return Promise.resolve(undefined);
                }
            }
        ], source);

        expect(verdict(await get(rig.app, '/login-isr'))).toBe('miss');
        expect(verdict(await get(rig.app, '/login-isr'))).toBe('hit');

        const bounced = await post(rig.app, '/gated-write');
        expect(bounced.status).toBe(303);
        expect(bounced.headers.get('location')).toBe('/login-isr');
        expect(ran).toBe(0);
        source.value = 'second';

        // Nothing was written, so the page the visitor was bounced to keeps its copy.
        const landing = await get(rig.app, '/login-isr');
        expect(verdict(landing)).toBe('hit');
        expect(await landing.text()).toContain('DATA:first');
    });

    it('a re-marked page is the newest entry, so the next mark evicts an older one', async () =>
    {
        const source: Source = { value: 'first' };
        const rig = build([{ path: '/bound-keep', component, render: 'static', revalidate: 300 }], source);
        expect(verdict(await get(rig.app, '/bound-keep'))).toBe('miss');
        expect(verdict(await get(rig.app, '/bound-keep'))).toBe('hit');

        // Flush whatever this file marked earlier, then leave the page SECOND-oldest in a full
        // ledger: re-marking the oldest entry would be moved to the newest end by the eviction
        // itself, which hides whether the re-mark deletes first. Two more marks then evict two
        // entries, and the page is only one of them if its re-mark left it where it was.
        for (let n = 0; n < 4096; n++)
        {
            revalidate(`/bound-flush-${ n }`);
        }
        revalidate('/bound-keep');
        for (let n = 0; n < 4094; n++)
        {
            revalidate(`/bound-fill-${ n }`);
        }
        revalidate('/bound-keep');
        revalidate('/bound-evict-one');
        revalidate('/bound-evict-two');
        source.value = 'second';

        const fresh = await get(rig.app, '/bound-keep');
        expect(verdict(fresh)).toBe('miss');
        expect(await fresh.text()).toContain('DATA:second');
    });
});

describe('what a marked page costs', () =>
{
    it('a query key re-earns its slot: two renders and three reads', async () =>
    {
        const source: Source = { value: 'first' };
        const rig = build([
            { path: '/q1', component, render: 'static', revalidate: 300 },
            { path: '/q1-write', component, render: 'server', action: writeThenRedirect(source, '/q1') }
        ], source);

        expect(verdict(await get(rig.app, '/q1'))).toBe('miss');
        expect(verdict(await get(rig.app, '/q1'))).toBe('hit');
        expect(verdict(await get(rig.app, '/q1?utm_source=x'))).toBe('miss');
        expect(verdict(await get(rig.app, '/q1?utm_source=x'))).toBe('miss');
        expect(verdict(await get(rig.app, '/q1?utm_source=x'))).toBe('hit');

        expect((await post(rig.app, '/q1-write')).status).toBe(303);
        await pastThisMillisecond();

        // The page's own identity is written at once and is a plain hit again.
        expect(verdict(await get(rig.app, '/q1'))).toBe('miss');
        expect(verdict(await get(rig.app, '/q1'))).toBe('hit');
        // A query-bearing key pays exactly what a cold one pays.
        expect(verdict(await get(rig.app, '/q1?utm_source=x'))).toBe('miss');
        expect(verdict(await get(rig.app, '/q1?utm_source=x'))).toBe('miss');
        const admitted = await get(rig.app, '/q1?utm_source=x');
        expect(verdict(admitted)).toBe('hit');
        expect(await admitted.text()).toContain('DATA:second');
    });

    it('a marked page has no stale-on-error until its first successful render', async () =>
    {
        const source: Source = { value: 'first' };
        const rig = build([
            { path: '/fail1', component, render: 'static', revalidate: 300 },
            { path: '/fail1-write', component, render: 'server', action: writeThenRedirect(source, '/fail1') }
        ], source);

        expect(verdict(await get(rig.app, '/fail1'))).toBe('miss');
        expect((await post(rig.app, '/fail1-write')).status).toBe(303);
        await pastThisMillisecond();
        rig.fail(true);

        for (const attempt of [1, 2])
        {
            const failed = await get(rig.app, '/fail1');
            expect(failed.status).toBe(500);
            expect(failed.headers.get('cache-control')).toBe('private, no-store');
            // Never the kept copy: serving it would show the writer their pre-write page.
            expect(await failed.text()).not.toContain('DATA:first');
            expect(rig.errors.filter((entry) => entry.phase === 'render')).toHaveLength(attempt);
        }

        rig.fail(false);
        const recovered = await get(rig.app, '/fail1');
        expect(verdict(recovered)).toBe('miss');
        expect(await recovered.text()).toContain('DATA:second');
        expect(verdict(await get(rig.app, '/fail1'))).toBe('hit');
    });

    it('CONTROL: under shell an ISR page renders live and the ledger decides nothing', async () =>
    {
        const source: Source = { value: 'first' };
        let count = 0;
        const app = new App();
        mountPages(app, {
            routes: [{ path: '/shell-isr', component, render: 'static', revalidate: 300 }],
            shell: SHELL,
            csrf: { cookie: COOKIE },
            renderer: (url: string): Promise<PageResult> =>
            {
                count++;
                return Promise.resolve({ kind: 'html', status: 200, html: `<html><body>DATA:${ source.value }:${ url }</body></html>` });
            }
        });

        expect(typeof revalidate).toBe('function');
        const first = await get(app, '/shell-isr');
        expect(verdict(first)).toBeNull();
        expect(await first.text()).toContain('DATA:first');

        source.value = 'second';
        revalidate('/shell-isr');
        const second = await get(app, '/shell-isr');
        expect(await second.text()).toContain('DATA:second');
        expect(count).toBe(2);
    });
});
