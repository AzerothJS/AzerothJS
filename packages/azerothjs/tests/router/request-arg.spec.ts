/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The `request` member on the guard and loader arguments: the live Request on the server,
// reaching EVERY level of the chain, and null in the browser - never a synthesised Request,
// whose empty cookie jar would read as the visitor's.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, createRouter, createMemoryHistory, matchAndLoad } from 'azerothjs';
import type { Route, Router } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';

const leaf = (): HTMLElement => document.createElement('div');

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() =>
{
    resetDataCache();
    vi.restoreAllMocks();
});

/** The chain under test: two levels, each guarded and each loading. */
function twoLevels(
    guardSaw: Array<Request | null>,
    loaderSaw: Array<Request | null>
): Route[]
{
    const record = (into: Array<Request | null>) => (request: Request | null): boolean =>
    {
        into.push(request);
        return true;
    };
    return [{
        path: '/orders',
        component: leaf,
        guard: ({ request }) => record(guardSaw)(request),
        loader: ({ request }) =>
        {
            loaderSaw.push(request);
            return Promise.resolve('orders');
        },
        children: [{
            path: ':id',
            component: leaf,
            guard: ({ request }) => record(guardSaw)(request),
            loader: ({ request }) =>
            {
                loaderSaw.push(request);
                return Promise.resolve('order');
            }
        }]
    }];
}

describe('matchAndLoad threads the live request', () =>
{
    it('hands the SAME Request object to every guard and every level\'s loader', async () =>
    {
        // The default-scope ambient refusal is expected on this resolver-less host; what the
        // refusal itself does is pinned in tests/ssr/request-context.spec.ts, not here.
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const guardSaw: Array<Request | null> = [];
        const loaderSaw: Array<Request | null> = [];
        const request = new Request('http://shop.test/orders/7');

        await matchAndLoad(twoLevels(guardSaw, loaderSaw), '/orders/7', { request });

        expect(guardSaw).toHaveLength(2);
        expect(loaderSaw).toHaveLength(2);
        for (const seen of [...guardSaw, ...loaderSaw])
        {
            expect(seen).toBe(request);
        }
    });

    it('reads null at every guard and every loader when the option is omitted', async () =>
    {
        const guardSaw: Array<Request | null> = [];
        const loaderSaw: Array<Request | null> = [];

        await matchAndLoad(twoLevels(guardSaw, loaderSaw), '/orders/7');

        expect(guardSaw).toEqual([null, null]);
        expect(loaderSaw).toEqual([null, null]);
    });
});

describe('the client router passes null', () =>
{
    it('gives the browser guard and the browser loader null, not a synthesised Request', async () =>
    {
        let guardRequest: Request | null | undefined;
        let loaderRequest: Request | null | undefined;
        const routes: Route[] = [
            { path: '/', component: leaf },
            {
                path: '/account',
                component: leaf,
                guard: ({ request }) =>
                {
                    guardRequest = request;
                    return true;
                },
                loader: ({ request }) =>
                {
                    loaderRequest = request;
                    return Promise.resolve('account');
                }
            }
        ];

        let dispose!: () => void;
        let router!: Router;
        createRoot((d) =>
        {
            dispose = d;
            router = createRouter({ routes, history: createMemoryHistory('/') });
        });
        try
        {
            router.navigate('/account');
            await flush();

            expect(guardRequest).toBeNull();
            expect(loaderRequest).toBeNull();
        }
        finally
        {
            dispose();
        }
    });
});
