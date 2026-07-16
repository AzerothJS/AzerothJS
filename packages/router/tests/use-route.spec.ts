// Full behavioral coverage for the route composables (use-route.ts):
// useRoute/useMatch (pass-through getters), useParams/useQuery (slice-memoized,
// re-firing only when their slice changes), and useNavigate (destructurable
// imperative API). Reactivity verified by counting effect runs inside a real
// createRoot, driven by a memory-history router - no mocks.
import { describe, it, expect } from 'vitest';
import { createRoot, createEffect } from '@azerothjs/reactivity';
import {
    createRouter,
    createMemoryHistory,
    useRoute,
    useMatch,
    useParams,
    useQuery,
    useNavigate
} from '@azerothjs/router';
import type { Route, Router } from '@azerothjs/router';

const leaf = (): HTMLElement => document.createElement('div');

const routes: Route[] =
[
    { path: '/', component: leaf },
    { path: '/about', component: leaf },
    { path: '/users/:id', component: leaf }
];

// Runs `fn` inside a root with a fresh memory-history router, then disposes.
function withRouter(initialUrl: string, fn: (router: Router, dispose: () => void) => void): void
{
    createRoot((dispose) =>
    {
        const router = createRouter({ routes, history: createMemoryHistory(initialUrl) });
        fn(router, dispose);
        dispose();
    });
}

describe('useRoute', () =>
{
    it('returns the full reactive location getter', () =>
    {
        withRouter('/about?x=1#h', (router) =>
        {
            const location = useRoute(router);
            const loc = location();
            expect(loc.pathname).toBe('/about');
            expect(loc.search).toBe('?x=1');
            expect(loc.hash).toBe('#h');
        });
    });

    it('is the same getter the router exposes', () =>
    {
        withRouter('/', (router) =>
        {
            expect(useRoute(router)).toBe(router.location);
        });
    });

    it('re-fires an effect on any location change', () =>
    {
        withRouter('/', (router) =>
        {
            const location = useRoute(router);
            const seen: string[] = [];
            createEffect(() =>
            {
                seen.push(location().pathname);
            });
            router.navigate('/about');
            router.navigate('/users/1');
            expect(seen).toEqual(['/', '/about', '/users/1']);
        });
    });
});

describe('useMatch', () =>
{
    it('returns the matched route getter', () =>
    {
        withRouter('/users/9', (router) =>
        {
            const match = useMatch(router);
            expect(match()!.params).toEqual({ id: '9' });
        });
    });

    it('is the same getter the router exposes', () =>
    {
        withRouter('/', (router) =>
        {
            expect(useMatch(router)).toBe(router.match);
        });
    });

    it('returns null when no route matches', () =>
    {
        withRouter('/nope', (router) =>
        {
            expect(useMatch(router)()).toBeNull();
        });
    });
});

describe('useParams - slice memoization', () =>
{
    it('exposes the current path params', () =>
    {
        withRouter('/users/42', (router) =>
        {
            const params = useParams(router);
            expect(params()).toEqual({ id: '42' });
        });
    });

    it('re-fires when a param value changes', () =>
    {
        withRouter('/users/1', (router) =>
        {
            const params = useParams(router);
            const seen: string[] = [];
            createEffect(() =>
            {
                seen.push(params().id ?? '');
            });
            router.navigate('/users/2');
            router.navigate('/users/3');
            expect(seen).toEqual(['1', '2', '3']);
        });
    });

    it('does NOT re-fire when only the hash changes (params identical)', () =>
    {
        withRouter('/users/42', (router) =>
        {
            const params = useParams(router);
            let runs = 0;
            createEffect(() =>
            {
                params();
                runs++;
            });
            expect(runs).toBe(1);

            router.navigate('/users/42#bio');
            expect(runs).toBe(1); // slice unchanged
            router.navigate('/users/42?tab=x');
            expect(runs).toBe(1); // slice unchanged
        });
    });

    it('re-fires once when navigating to the same param then a different one', () =>
    {
        withRouter('/users/1', (router) =>
        {
            const params = useParams(router);
            let runs = 0;
            createEffect(() =>
            {
                params();
                runs++;
            });
            router.navigate('/users/1#a'); // same id -> no re-fire
            expect(runs).toBe(1);
            router.navigate('/users/2'); // new id -> re-fire
            expect(runs).toBe(2);
        });
    });
});

describe('useQuery - slice memoization', () =>
{
    it('exposes the parsed query', () =>
    {
        withRouter('/about?page=2&sort=desc', (router) =>
        {
            const query = useQuery(router);
            expect(query()).toEqual({ page: '2', sort: 'desc' });
        });
    });

    it('returns repeated keys as arrays', () =>
    {
        withRouter('/about?tag=a&tag=b', (router) =>
        {
            const query = useQuery(router);
            expect(query()).toEqual({ tag: ['a', 'b'] });
        });
    });

    it('re-fires when a query value changes', () =>
    {
        withRouter('/about?page=1', (router) =>
        {
            const query = useQuery(router);
            const seen: unknown[] = [];
            createEffect(() =>
            {
                seen.push(query().page);
            });
            router.navigate('/about?page=2');
            expect(seen).toEqual(['1', '2']);
        });
    });

    it('does NOT re-fire when only the path/hash changes but the query is identical', () =>
    {
        withRouter('/about?page=1', (router) =>
        {
            const query = useQuery(router);
            let runs = 0;
            createEffect(() =>
            {
                query();
                runs++;
            });
            expect(runs).toBe(1);
            router.navigate('/about?page=1#section'); // same query
            expect(runs).toBe(1);
        });
    });

    it('does NOT re-fire when an array-valued query is reordered to the identical value', () =>
    {
        withRouter('/about?tag=a&tag=b', (router) =>
        {
            const query = useQuery(router);
            let runs = 0;
            createEffect(() =>
            {
                query();
                runs++;
            });
            router.navigate('/about?tag=a&tag=b#x'); // identical query -> no re-fire
            expect(runs).toBe(1);
            router.navigate('/about?tag=a&tag=c'); // changed -> re-fire
            expect(runs).toBe(2);
        });
    });
});

describe('useNavigate', () =>
{
    it('returns an object bundling navigate/replace/back/forward', () =>
    {
        withRouter('/', (router) =>
        {
            const api = useNavigate(router);
            expect(typeof api.navigate).toBe('function');
            expect(typeof api.replace).toBe('function');
            expect(typeof api.back).toBe('function');
            expect(typeof api.forward).toBe('function');
        });
    });

    it('navigate() drives the router and is safe to destructure', () =>
    {
        withRouter('/', (router) =>
        {
            const { navigate } = useNavigate(router);
            navigate('/about');
            expect(router.location().pathname).toBe('/about');
        });
    });

    it('replace() destructured works without this-binding', () =>
    {
        withRouter('/', (router) =>
        {
            const { navigate, replace } = useNavigate(router);
            navigate('/about');
            navigate('/users/1');
            replace('/users/2'); // overwrites /users/1
            expect(router.location().pathname).toBe('/users/2');
            router.back();
            expect(router.location().pathname).toBe('/about');
        });
    });

    it('back() and forward() destructured navigate the history', () =>
    {
        withRouter('/', (router) =>
        {
            const { navigate, back, forward } = useNavigate(router);
            navigate('/about');
            navigate('/users/1');
            back();
            expect(router.location().pathname).toBe('/about');
            forward();
            expect(router.location().pathname).toBe('/users/1');
        });
    });
});
