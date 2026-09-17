/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The ambient request: useRequest() inside a render, the default-scope refusal on a host with
// no request root, a streamed continuation reading the shell's request, the read flag that
// makes a page private, and survival across awaits on twenty interleaved requests.
//
// Runs in the DEFAULT (happy-dom) environment on purpose: one arm mounts the same component
// into a real DOM and must observe null there, which is the browser half of the contract.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Suspense, createResource, h, matchAndLoad, render, renderToStream, renderToString, useRequest } from 'azerothjs';
import type { Route } from 'azerothjs';
import { requestWasRead, resetDataCache, setStoreScopeResolver } from 'azerothjs/internal';

const leaf = (): HTMLElement => document.createElement('div');

afterEach(() =>
{
    resetDataCache();
    vi.restoreAllMocks();
});

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string>
{
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let text = '';
    for (;;)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            break;
        }
        text += decoder.decode(value, { stream: true });
    }
    return text;
}

describe('useRequest inside a render', () =>
{
    it('reads the request renderToString was given, and null in a DOM render', () =>
    {
        const request = new Request('http://shop.test/account');
        let fromString: Request | null | undefined;
        let fromDom: Request | null | undefined;

        const html = renderToString(() =>
        {
            fromString = useRequest();
            return h('p', {}, 'account');
        }, { request });

        expect(html).toContain('account');
        expect(fromString).toBe(request);

        const container = document.createElement('div');
        render(() =>
        {
            fromDom = useRequest();
            return h('p', {}, 'account');
        }, container);

        expect(fromDom).toBeNull();
    });
});

describe('the default-scope refusal on a host with no request root', () =>
{
    it('never hands the second request the first one\'s identity, and names both causes once', async () =>
    {
        // The diagnostic is latched once per process, so this must stay the FIRST arm in this
        // file that installs at the default scope, or the count below reads zero.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const ambient: Array<Request | null> = [];
        const routes: Route[] = [{
            path: '/a',
            component: leaf,
            loader: () =>
            {
                ambient.push(useRequest());
                return Promise.resolve('a');
            }
        }];
        const first = new Request('http://shop.test/a');
        const second = new Request('http://shop.test/a?two');

        await matchAndLoad(routes, '/a', { request: first });
        await matchAndLoad(routes, '/a?two', { request: second });

        // Refused, not installed: null both times, and in particular never the FIRST request
        // served to the second visitor.
        expect(ambient).toEqual([null, null]);
        expect(ambient[1]).not.toBe(first);

        expect(warn).toHaveBeenCalledTimes(1);
        const message = String(warn.mock.calls[0]?.[0]);
        expect(message).toMatch(/runInRequestRoot/);
        expect(message).toMatch(/second copy/i);
        expect(message).toMatch(/ssr\.external/);
    });
});

describe('a streamed page', () =>
{
    it('reads the shell\'s request inside a Suspense continuation', async () =>
    {
        const request = new Request('http://shop.test/feed');
        let settle!: (value: string) => void;
        const gate = new Promise<string>((resolve) =>
        {
            settle = resolve;
        });
        let fromShell: Request | null | undefined;
        let fromContinuation: Request | null | undefined;

        const page = (): HTMLElement =>
        {
            fromShell = useRequest();
            const resource = createResource<string>(() => gate);
            return h('main', {}, Suspense({
                fallback: () => h('p', {}, 'loading'),
                on: [resource],
                children: () =>
                {
                    fromContinuation = useRequest();
                    return h('section', {}, () => resource.data() ?? '');
                }
            }));
        };

        const stream = renderToStream(page, { request });
        const text = readAll(stream);
        settle('feed');
        expect(await text).toContain('feed');

        expect(fromShell).toBe(request);
        expect(fromContinuation).toBe(request);
    });
});

describe('the read flag', () =>
{
    it('leaves a request unread when nothing consulted identity', async () =>
    {
        const request = new Request('http://shop.test/prices');
        const routes: Route[] = [{
            path: '/prices',
            component: leaf,
            loader: ({ params }) => Promise.resolve(Object.keys(params).length)
        }];

        await matchAndLoad(routes, '/prices', { request });
        renderToString(() => h('p', {}, 'prices'), { request });

        expect(requestWasRead(request)).toBe(false);
    });

    it('raises the flag when a loader destructures args.request', async () =>
    {
        const request = new Request('http://shop.test/orders');
        const routes: Route[] = [{
            path: '/orders',
            component: leaf,
            loader: ({ request: live }) => Promise.resolve(live === null ? 'anon' : 'visitor')
        }];

        await matchAndLoad(routes, '/orders', { request });

        expect(requestWasRead(request)).toBe(true);
    });

    it('raises the flag when a component calls useRequest', () =>
    {
        const request = new Request('http://shop.test/greeting');

        renderToString(() =>
        {
            const live = useRequest();
            return h('p', {}, live === null ? 'anon' : 'visitor');
        }, { request });

        expect(requestWasRead(request)).toBe(true);
    });
});

describe('survival across awaits', () =>
{
    it('gives twenty interleaved requests their own request, never a neighbour\'s', async () =>
    {
        const storage = new AsyncLocalStorage<object>();
        setStoreScopeResolver(() => storage.getStore());
        try
        {
            const seen = new Map<string, Request | null>();
            const routes: Route[] = [{
                path: '/p/:id',
                component: leaf,
                loader: async ({ params }) =>
                {
                    const id = String(params.id);
                    // Jittered but deterministic, so the awaits genuinely interleave and the
                    // arm does not depend on a random draw to reproduce.
                    await new Promise((resolve) => setTimeout(resolve, (Number(id) * 7) % 13));
                    seen.set(id, useRequest());
                    return id;
                }
            }];
            const requests = Array.from({ length: 20 }, (_, i) => new Request(`http://shop.test/p/${ i }`));

            await Promise.all(requests.map((request, i) =>
                storage.run({}, () => matchAndLoad(routes, `/p/${ i }`, { request }))));

            expect(seen.size).toBe(20);
            for (let i = 0; i < 20; i++)
            {
                expect(seen.get(String(i))).toBe(requests[i]);
            }
        }
        finally
        {
            setStoreScopeResolver(null);
        }
    });
});
