// @vitest-environment happy-dom
//
// The server memoizes its top-level route-table flatten, because every server-side selection
// pays one: a warm ISR hit (the guarded predicate runs before the cache read), an SSR render,
// and a cold miss. At a large table that flatten dominates a cache hit.
//
// The memo is TOP LEVEL ONLY, and these arms exist to keep it there. flattenRoutes recurses on
// `route.children` with a different parentPath/parentChain, so an array's identity determines
// its table only at the ROOT. A children array mounted under two parents is legal, and a memo
// consulted inside the recursion would hand the second parent the first's chains - which makes
// guardedMatch answer about the wrong chain. That is an authorization bug, so the first arm
// below is the load-bearing one.
import { describe, expect, it } from 'vitest';

import { flattenRoutesFor, guardedMatch } from 'azerothjs/internal';
import type { Route } from 'azerothjs';

const leaf = (): HTMLElement => document.createElement('div');

describe('the flatten memo cannot cross two parents that share a children array', () =>
{
    it('keeps each parent\'s own chain AND its own guard verdict', async () =>
    {
        // ONE array, two mounts. A memo inside the recursion returns the first parent's table
        // for the second and /account/* disappears entirely.
        const settings: Route[] = [
            { path: 'profile', component: leaf },
            { path: 'billing', component: leaf }
        ];
        const routes: Route[] = [
            { path: '/admin', component: leaf, guard: () => false, children: settings },
            { path: '/account', component: leaf, children: settings }
        ];

        for (const pass of [1, 2])
        {
            const table = flattenRoutesFor(routes);
            const patterns = table.map((entry) => entry.matcher.pattern);
            expect(patterns, `pass ${ pass }`).toEqual([
                '/admin/profile', '/admin/billing', '/account/profile', '/account/billing'
            ]);
        }

        // The verdict each URL actually gets, which is what the hazard would corrupt.
        expect(guardedMatch(routes, '/admin/profile')).toBe(true);
        expect(guardedMatch(routes, '/account/profile')).toBe(false);
        await Promise.resolve();
    });

    it('the SAME array used as a top-level table AND as children elsewhere stays correct, both orders', () =>
    {
        const shared: Route[] = [{ path: '/thing', component: leaf }];
        const wrapper: Route[] = [{ path: '/wrap', component: leaf, guard: () => false, children: shared }];

        // Top level first, then as children.
        expect(flattenRoutesFor(shared).map((e) => e.matcher.pattern)).toEqual(['/thing']);
        expect(flattenRoutesFor(wrapper).map((e) => e.matcher.pattern)).toEqual(['/wrap/thing']);

        // And the reverse order on fresh identities, so neither priming can poison the other.
        const shared2: Route[] = [{ path: '/thing', component: leaf }];
        const wrapper2: Route[] = [{ path: '/wrap', component: leaf, children: shared2 }];
        expect(flattenRoutesFor(wrapper2).map((e) => e.matcher.pattern)).toEqual(['/wrap/thing']);
        expect(flattenRoutesFor(shared2).map((e) => e.matcher.pattern)).toEqual(['/thing']);
    });
});

describe('what the memo promises and what it requires', () =>
{
    it('returns the SAME table for one array, and a separate one for an identical copy', () =>
    {
        const routes: Route[] = [{ path: '/a', component: leaf }];
        const twin: Route[] = [{ path: '/a', component: leaf }];

        expect(flattenRoutesFor(routes)).toBe(flattenRoutesFor(routes));
        expect(flattenRoutesFor(twin)).not.toBe(flattenRoutesFor(routes));
        expect(flattenRoutesFor(twin).map((e) => e.matcher.pattern))
            .toEqual(flattenRoutesFor(routes).map((e) => e.matcher.pattern));
    });

    it('DOCUMENTED LIMIT: a table mutated after its first selection goes stale, and fails OPEN', () =>
    {
        // Pinned deliberately rather than fixed: the memo keys on identity, not contents. A
        // guard added after the first selection is INVISIBLE, which means a page that should be
        // treated as guarded would not be - so the invariant "do not mutate a routes array after
        // its first selection" is load-bearing, not stylistic. A server building routes per
        // request must build a NEW array, which simply misses the memo.
        const routes: Route[] = [{ path: '/open', component: leaf }];
        expect(guardedMatch(routes, '/secret')).toBe(false);

        routes.push({ path: '/secret', component: leaf, guard: () => false });

        // Still false: the appended guarded route is not seen. If this ever starts returning
        // true, the memo gained content-awareness and this arm should be deleted, not "fixed".
        expect(guardedMatch(routes, '/secret')).toBe(false);
        // A fresh array sees the truth, which is the documented escape hatch.
        expect(guardedMatch([...routes], '/secret')).toBe(true);
    });

    it('never negative-caches: a malformed table throws EVERY time, not just the first', () =>
    {
        // flattenRoutes throws on a duplicate param. If the memo cached around the throw, a
        // second call could hand back a half-built table instead of raising.
        const bad: Route[] = [{ path: '/x/:id', component: leaf, children: [{ path: 'y/:id', component: leaf }] }];
        expect(() => flattenRoutesFor(bad)).toThrow();
        expect(() => flattenRoutesFor(bad)).toThrow();
    });
});
