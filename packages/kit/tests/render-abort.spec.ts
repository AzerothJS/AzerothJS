// @vitest-environment node
//
// WHOSE render is it? kit drives the renderer from several entry points, and they do not all
// have the same answer, so they must not all get the same signal.
//
// A render that exists for ONE waiting client takes that client's disconnect signal: when the
// connection goes, the render's reason to exist goes with it, and without the signal a client
// that opens connections and drops them still buys every loader's full fan-out to the backing
// services with nobody left to read the answer. The streamed path always did this; the
// BUFFERED `render: 'server'` path - which is the DEFAULT whenever a renderer is configured -
// did not, and neither did the guarded live path.
//
// A SHARED render must not take it, and the two CONTROL arms below are the load-bearing half
// of this file. `produce` is coalesced: every request for the same key adopts one promise and
// its result may be cached for requests that have not arrived yet, so cancelling on one
// waiter's disconnect would fail everyone queued behind it. `regenerate` has no waiter at all -
// its request was already answered from the stale copy - so tying it to that connection would
// make a page's freshness depend on whether one visitor stayed on it. Both deliberately
// receive NO request signal, and these arms exist so a later consistency pass cannot "finish
// the job" by wiring them up.
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { App } from '@azerothjs/http';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import type { PageResult } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';
const component = (): HTMLElement => (undefined as unknown as HTMLElement);

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

interface Seen
{
    url: string;
    signal: AbortSignal | undefined;
}

interface Rig
{
    app: App;
    seen: Seen[];
}

function build(routes: PageRoute[]): Rig
{
    const dir = mkdtempSync(join(tmpdir(), 'az-abort-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), SHELL);

    const seen: Seen[] = [];
    const app = new App();
    mountPages(app, {
        routes,
        clientDir: dir,
        renderer: (url, _shell, options) =>
        {
            seen.push({ url, signal: options?.signal });
            return Promise.resolve<PageResult>({ kind: 'html', status: 200, html: `<html><body>R:${ url }</body></html>` });
        },
        onError: () => undefined
    });
    return { app, seen };
}

/** Issues a request whose signal this test controls, exactly as a real client's socket would. */
async function request(rig: Rig, path: string, as = 'anon'): Promise<AbortController>
{
    const controller = new AbortController();
    await identity.run(as, () => rig.app.handle(new Request(`http://local${ path }`, { signal: controller.signal })));
    return controller;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe('a render with ONE waiting client takes that client\'s signal', () =>
{
    it('the buffered render:server path - the default mode - hands the renderer a live disconnect signal', async () =>
    {
        const rig = build([{ path: '/s', render: 'server', component }]);
        const controller = await request(rig, '/s');

        expect(rig.seen).toHaveLength(1);
        const signal = rig.seen[0]!.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        // Not merely PRESENT - actually wired to this client. A detached signal would satisfy
        // the check above and cancel nothing in production.
        expect(signal!.aborted).toBe(false);
        controller.abort();
        expect(signal!.aborted).toBe(true);
    });

    it('the guarded live path takes it too - that render is private, no-store and shares nothing', async () =>
    {
        // `/docs/current` is registered static, but the earlier guarded `/docs/:slug` chain
        // matches its URL, so the guarded gate answers it live per request.
        const rig = build([
            { path: '/docs/:slug', render: 'client', component, guard: () => who() === 'alice' },
            { path: '/docs/current', render: 'static', revalidate: 60, component }
        ]);
        const controller = await request(rig, '/docs/current', 'alice');

        expect(rig.seen).toHaveLength(1);
        const signal = rig.seen[0]!.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal!.aborted).toBe(false);
        controller.abort();
        expect(signal!.aborted).toBe(true);
    });
});

describe('CONTROL: a SHARED render takes no request signal', () =>
{
    it('produce is coalesced, so one waiter\'s disconnect must not be able to abort it', async () =>
    {
        const rig = build([{ path: '/about', render: 'static', revalidate: 60, component }]);
        await request(rig, '/about');

        expect(rig.seen).toHaveLength(1);
        expect(rig.seen[0]!.signal).toBeUndefined();
    });

    it('background regeneration has no waiter at all, so it takes none either', async () =>
    {
        const rig = build([{ path: '/about', render: 'static', revalidate: 0.01, component }]);
        await request(rig, '/about');
        expect(rig.seen).toHaveLength(1);

        // Past the window: this request is answered from the stale copy and kicks off a
        // background refresh that belongs to nobody.
        await settle();
        await request(rig, '/about');
        await settle();

        expect(rig.seen.length).toBeGreaterThan(1);
        for (const call of rig.seen)
        {
            expect(call.signal).toBeUndefined();
        }
    });
});
