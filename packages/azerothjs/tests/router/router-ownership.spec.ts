/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// A router built OUTSIDE any ownership scope - module scope, the app-lifetime singleton
// shape the README models - must own its internal effects: no ownerless-effect warnings
// at construction, and the reactive machinery still works. Under an ambient owner the
// router keeps disposing with that owner.
import { describe, it, expect, vi } from 'vitest';
import { createRoot, createRouter, createMemoryHistory } from 'azerothjs';
import type { Route } from 'azerothjs';

const leaf = (): HTMLElement => document.createElement('div');

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('router ownership', () =>
{
    it('an UNOWNED createRouter warns nothing and still navigates', async () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            const routes: Route[] =
            [
                { path: '/', component: leaf, loader: async () => 'home' },
                { path: '/about', component: leaf }
            ];
            // Deliberately OUTSIDE createRoot: the app-lifetime singleton shape.
            const router = createRouter({ routes, history: createMemoryHistory('/') });
            await flush();

            const ownerless = warn.mock.calls.filter((call) =>
                String(call[0]).includes('no owner'));
            expect(ownerless).toEqual([]);

            // The self-rooted effects are live, not inert: navigation commits.
            expect(router.loaders[0]!.data()).toBe('home');
            router.navigate('/about');
            expect(router.location().pathname).toBe('/about');
        }
        finally
        {
            warn.mockRestore();
        }
    });

    it('an OWNED createRouter still disposes with its owner', async () =>
    {
        let runs = 0;
        const routes: Route[] =
        [{ path: '/:id', component: leaf, loader: async ({ params }) =>
        {
            runs += 1;
            return params.id;
        } }];
        let dispose!: () => void;
        let router!: ReturnType<typeof createRouter>;
        createRoot((d) =>
        {
            dispose = d;
            router = createRouter({ routes, history: createMemoryHistory('/1') });
        });
        await flush();
        expect(runs).toBe(1);

        dispose();
        // A disposed owner tears the router's effects down: navigation no longer fetches.
        router.navigate('/2');
        await flush();
        expect(runs).toBe(1);
    });
});
