/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Route identity is the POSITION in the tree, not the config object. A route object reused
// under two parents occupies two positions: they must match separately, key separately, and
// run their own guards. Before this was true, both positions shared one match and one loader
// key, so the second URL served the first tenant's data and never entered its own guard.
//
// The three behaviours around it that must NOT change are pinned here beside it, because two
// of them refute the repairs that suggest themselves first: keying by leaf would stop sibling
// routes sharing their layout's loader, and a param change must still invalidate.
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, createRouter, createMemoryHistory, matchAndLoad } from 'azerothjs';
import type { Route, Router } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';

const leaf = (): HTMLElement => document.createElement('div');

const flush = async (): Promise<void> =>
{
    for (let tick = 0; tick < 4; tick++)
    {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

afterEach(() =>
{
    resetDataCache();
});

async function withRouter(routes: Route[], initialUrl: string, fn: (router: Router) => Promise<void>): Promise<void>
{
    let dispose!: () => void;
    let router!: Router;
    createRoot((d) =>
    {
        dispose = d;
        router = createRouter({ routes, history: createMemoryHistory(initialUrl), scroll: false });
    });
    try
    {
        await flush();
        await fn(router);
    }
    finally
    {
        dispose();
    }
}

/** The chain's component names, which is what "which position is rendered" reduces to. */
const chainOf = (router: Router): string =>
{
    const match = router.match();
    return match === null ? 'null' : match.matched.map((route) => route.component?.name ?? '?').join(' > ');
};

const named = (name: string): (() => HTMLElement) =>
{
    const component = (): HTMLElement => document.createElement('div');
    Object.defineProperty(component, 'name', { value: name });
    return component;
};

describe('a route object reused under two parents', () =>
{
    it('matches, keys and loads each POSITION separately', async () =>
    {
        // ONE settings object, referenced by both tenants - ordinary configuration reuse.
        const settingsRuns: string[] = [];
        const settings: Route =
        {
            path: 'settings',
            component: named('SettingsView'),
            loader: async ({ parent }): Promise<string> =>
            {
                const from = await parent as string;
                settingsRuns.push(from);
                return `SETTINGS(${ from })`;
            }
        };
        const routes: Route[] =
        [
            { path: '/org-a', component: named('OrgALayout'), loader: async (): Promise<string> => 'ORG-A-SECRETS', children: [settings] },
            { path: '/org-b', component: named('OrgBLayout'), loader: async (): Promise<string> => 'ORG-B-SECRETS', children: [settings] }
        ];

        await withRouter(routes, '/org-a/settings', async (router) =>
        {
            expect(chainOf(router)).toBe('OrgALayout > SettingsView');
            expect(router.loaders[0]?.data()).toBe('ORG-A-SECRETS');

            router.navigate('/org-b/settings');
            await flush();

            // Three observables, and the third is the one that detects the KEY half: with only
            // the match fixed the chain flips and the layout re-loads, while the leaf keeps
            // serving org-a's payload out of the shared entry.
            expect(chainOf(router)).toBe('OrgBLayout > SettingsView');
            expect(router.loaders[0]?.data()).toBe('ORG-B-SECRETS');
            expect(router.loaders[1]?.data()).toBe('SETTINGS(ORG-B-SECRETS)');
            expect(settingsRuns).toEqual(['ORG-A-SECRETS', 'ORG-B-SECRETS']);
        });
    });

    it('enters the second position\'s OWN guard', async () =>
    {
        // The collapse was an authorization bypass, not only wrong data: with no new match
        // there is no guard pass, so the second tenant's guard never ran at all.
        const guarded: string[] = [];
        const page: Route = { path: 'page', component: named('Page') };
        const routes: Route[] =
        [
            {
                path: '/t-a',
                component: named('TenantALayout'),
                guard: (): boolean =>
                {
                    guarded.push('a');
                    return true;
                },
                children: [page]
            },
            {
                path: '/t-b',
                component: named('TenantBLayout'),
                guard: (): boolean =>
                {
                    guarded.push('b');
                    return true;
                },
                children: [page]
            }
        ];

        await withRouter(routes, '/t-a/page', async (router) =>
        {
            expect(guarded).toEqual(['a']);
            router.navigate('/t-b/page');
            await flush();
            expect(chainOf(router)).toBe('TenantBLayout > Page');
            expect(guarded).toEqual(['a', 'b']);
        });
    });
});

// INTEGRATION PINS, and their honest standing: neither of these two BITES the position-identity
// change - an independent audit built a full revert and measured both still passing. They are
// here because they guard the two integrations that a future change to level keys could plausibly
// break: the handoff is POSITIONAL by level and carries no keys at all, and a navigation between
// two positions sharing a leaf now enters the ordinary supersede path. Recorded as pins rather
// than presented as evidence for the fix.
describe('integrations a level-key change could break (pins, not evidence)', () =>
{
    it('the SSR handoff still aligns index-for-index with a reused-object chain', async () =>
    {
        const shared: Route =
        {
            path: 'settings',
            component: named('Shared'),
            loader: async ({ parent }): Promise<string> => `S(${ await parent as string })`
        };
        const routes: Route[] =
        [
            { path: '/org-a', component: named('OrgA'), loader: async (): Promise<string> => 'A-SECRET', children: [shared] },
            { path: '/org-b', component: named('OrgB'), loader: async (): Promise<string> => 'B-SECRET', children: [shared] }
        ];

        const handoff = await matchAndLoad(routes, '/org-b/settings');
        expect(handoff).not.toBeNull();
        // Positional by level: index 0 is the layout, index 1 the shared leaf, and the leaf's
        // payload must be derived from the SECOND tenant, not the first.
        expect((handoff as { data: unknown[] }).data).toEqual(['B-SECRET', 'S(B-SECRET)']);

        let dispose!: () => void;
        let router!: Router;
        createRoot((d) =>
        {
            dispose = d;
            router = createRouter({
                routes,
                history: createMemoryHistory('/org-b/settings'),
                scroll: false,
                initialLoaderData: handoff as never
            });
        });
        try
        {
            await flush();
            expect(router.loaders[0]?.data()).toBe('B-SECRET');
            expect(router.loaders[1]?.data()).toBe('S(B-SECRET)');
        }
        finally
        {
            dispose();
        }
    });

    it('an interleaved A -> B -> A navigation settles on the LAST position', async () =>
    {
        let release!: () => void;
        const gate = new Promise<void>((resolve) =>
        {
            release = resolve;
        });
        let gatedOnce = false;
        const shared: Route = { path: 'page', component: named('Page') };
        const routes: Route[] =
        [
            {
                path: '/a',
                component: named('ALayout'),
                loader: async (): Promise<string> =>
                {
                    if (!gatedOnce)
                    {
                        gatedOnce = true;
                        await gate;
                    }
                    return 'A';
                },
                children: [shared]
            },
            { path: '/b', component: named('BLayout'), loader: async (): Promise<string> => 'B', children: [shared] }
        ];

        await withRouter(routes, '/a/page', async (router) =>
        {
            router.navigate('/b/page');
            router.navigate('/a/page');
            release();
            await flush();
            expect(chainOf(router)).toBe('ALayout > Page');
            expect(router.loaders[0]?.data()).toBe('A');
        });
    });
});

describe('what position identity must NOT change', () =>
{
    it('two sibling leaves still SHARE their layout\'s loader entry', async () =>
    {
        // Refutes keying by leaf: that gives each sibling its own layout entry and refetches
        // the layout on every sibling navigation.
        let layoutRuns = 0;
        const routes: Route[] =
        [{
            path: '/app',
            component: named('AppLayout'),
            loader: async (): Promise<string> =>
            {
                layoutRuns += 1;
                return `LAYOUT#${ layoutRuns }`;
            },
            children: [
                { path: 'one', component: named('PageOne') },
                { path: 'two', component: named('PageTwo') }
            ]
        }];

        await withRouter(routes, '/app/one', async (router) =>
        {
            router.navigate('/app/two');
            await flush();
            router.navigate('/app/one');
            await flush();
            expect(layoutRuns).toBe(1);
        });
    });

    it('a param change on one position still invalidates', async () =>
    {
        const seen: string[] = [];
        const routes: Route[] =
        [{
            path: '/u/:id',
            component: leaf,
            loader: async ({ params }): Promise<string> =>
            {
                seen.push(params.id as string);
                return `USER:${ params.id }`;
            }
        }];

        await withRouter(routes, '/u/1', async (router) =>
        {
            router.navigate('/u/2');
            await flush();
            router.navigate('/u/3');
            await flush();
            expect(seen).toEqual(['1', '2', '3']);
        });
    });
});
