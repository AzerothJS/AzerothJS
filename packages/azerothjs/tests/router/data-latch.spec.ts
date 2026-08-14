/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The server latch, in its own file: every spec here executes a server entry point, which
// permanently latches this process, so no client-caching assertion may follow in THIS file
// (per-file vitest isolation is the latch boundary). The probes: loader-phase reads under
// public matchAndLoad on a resolver-less host never share entries across calls, and each
// render frame's registry dedupes within its own pass while staying isolated from the next.
import { describe, it, expect, afterEach } from 'vitest';
import { cached, createResource, createRoot, h, matchAndLoad, renderToStream, renderToString } from 'azerothjs';
import type { Route } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';

const leaf = (): HTMLElement => document.createElement('div');

afterEach(() =>
{
    resetDataCache();
});

describe('the loader-phase latch probe', () =>
{
    it('two sequential matchAndLoad calls each fetch: DEFAULT_SCOPE never caches once latched', async () =>
    {
        let fetches = 0;
        const getData = cached('latch-loader-probe', async () =>
        {
            fetches += 1;
            return fetches;
        });
        const routes: Route[] =
        [{ path: '/', component: leaf, loader: async () => getData() }];

        const first = await matchAndLoad(routes, '/');
        const second = await matchAndLoad(routes, '/');

        // Request A's loader-phase read must never be served to request B.
        expect(fetches).toBe(2);
        expect(first).toMatchObject({ data: [1] });
        expect(second).toMatchObject({ data: [2] });
    });
});

describe('render-frame registries', () =>
{
    it('a STREAM session dedupes same-key eager reads; the next render fetches its own', async () =>
    {
        let fetches = 0;
        const getShared = cached('stream-frame-dedupe', async () =>
        {
            fetches += 1;
            return fetches;
        });
        const drain = async (): Promise<void> =>
        {
            const stream = renderToStream(() =>
            {
                createResource(getShared);
                createResource(getShared);
                return h('div', {}, 'x');
            });
            const reader = stream.getReader();
            let done = false;
            while (!done)
            {
                done = (await reader.read()).done;
            }
        };

        await drain();
        // Streaming starts eager fetches at construction: two same-key readers in one
        // pass share ONE fetch through the render frame's registry.
        expect(fetches).toBe(1);
        await drain();
        // The next render's frame is its own: it fetched again rather than reading the
        // previous request's entry - the isolation half, now with a count that CAN fail.
        expect(fetches).toBe(2);
    });

    it('plain string mode without a session starts no fetches at all', () =>
    {
        let fetches = 0;
        const getIdle = cached('string-idle-probe', async () =>
        {
            fetches += 1;
            return fetches;
        });
        renderToString(() =>
        {
            createResource(getIdle);
            return h('div', {}, 'x');
        });
        expect(fetches).toBe(0);
    });
});

describe('the plain-fetcher island after latching', () =>
{
    it('un-keyed resources keep exact island semantics under a latched process', async () =>
    {
        let fetches = 0;
        const fetcher = async (): Promise<string> =>
        {
            fetches += 1;
            return 'x';
        };
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            createResource(fetcher);
            createResource(fetcher);
        });
        try
        {
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(fetches).toBe(2);
        }
        finally
        {
            dispose();
        }
    });
});
