import { describe, it, expect, vi } from 'vitest';
import { createRoot, createEffect, createSignal } from '@azerothjs/core';
import {
    useRoute,
    useMatch,
    useParams,
    useQuery,
    useNavigate
} from '../../packages/router/src/use-route.ts';
import type { Router } from '../../packages/router/src/router.ts';
import type { RouteLocation } from '../../packages/router/src/types.ts';

// ── Router stub ──────────────────────────────────────────────
//
// Same shape as the link tests' stub. Real signals so the slice-
// memoization assertions exercise the actual reactivity path.

interface RouterStub
{
    router: Router;
    setLocation: (loc: RouteLocation) => void;
    navigateSpy: ReturnType<typeof vi.fn>;
    replaceSpy: ReturnType<typeof vi.fn>;
    backSpy: ReturnType<typeof vi.fn>;
    forwardSpy: ReturnType<typeof vi.fn>;
}

function makeRouterStub(initial: Partial<RouteLocation> = {}): RouterStub
{
    const initialLocation: RouteLocation =
    {
        pathname: '/',
        search: '',
        hash: '',
        params: {},
        query: {},
        fullPath: '/',
        ...initial
    };

    const [location, setLocationInternal] = createSignal<RouteLocation>(initialLocation);

    const navigateSpy = vi.fn();
    const replaceSpy = vi.fn();
    const backSpy = vi.fn();
    const forwardSpy = vi.fn();

    const router: Router =
    {
        location,
        match: () => null,
        navigate: navigateSpy,
        replace: replaceSpy,
        back: backSpy,
        forward: forwardSpy
    };

    return { router, setLocation: setLocationInternal, navigateSpy, replaceSpy, backSpy, forwardSpy };
}

/** A complete RouteLocation with sensible defaults for tests that override one slice. */
function loc(overrides: Partial<RouteLocation>): RouteLocation
{
    return {
        pathname: '/',
        search: '',
        hash: '',
        params: {},
        query: {},
        fullPath: '/',
        ...overrides
    };
}

describe('useRoute / useMatch — passthrough composables', () =>
{
    it('useRoute returns the same getter as router.location', () =>
    {
        const { router } = makeRouterStub();
        expect(useRoute(router)).toBe(router.location);
    });

    it('useMatch returns the same getter as router.match', () =>
    {
        const { router } = makeRouterStub();
        expect(useMatch(router)).toBe(router.match);
    });
});

describe('useParams — slice-memoized', () =>
{
    it('reflects the current params', () =>
    {
        createRoot((dispose) =>
        {
            const { router, setLocation } = makeRouterStub();
            const params = useParams(router);

            setLocation(loc({ pathname: '/users/42', params: { id: '42' } }));
            expect(params()).toEqual({ id: '42' });

            dispose();
        });
    });

    it('does NOT re-fire downstream effects when only the hash changes', () =>
    {
        createRoot((dispose) =>
        {
            const { router, setLocation } = makeRouterStub();
            setLocation(loc({ pathname: '/users/42', params: { id: '42' } }));

            const params = useParams(router);
            const downstream = vi.fn();

            createEffect(() =>
            {
                params();
                downstream();
            });

            // Initial effect run on creation.
            expect(downstream).toHaveBeenCalledOnce();

            // Hash-only change — params unchanged → no re-fire.
            setLocation(loc({
                pathname: '/users/42',
                hash: '#bio',
                params: { id: '42' }
            }));

            expect(downstream).toHaveBeenCalledOnce();

            dispose();
        });
    });

    it('DOES re-fire downstream effects when params change', () =>
    {
        createRoot((dispose) =>
        {
            const { router, setLocation } = makeRouterStub();
            setLocation(loc({ pathname: '/users/42', params: { id: '42' } }));

            const params = useParams(router);
            const downstream = vi.fn();

            createEffect(() =>
            {
                params();
                downstream();
            });

            expect(downstream).toHaveBeenCalledOnce();

            setLocation(loc({ pathname: '/users/43', params: { id: '43' } }));
            expect(downstream).toHaveBeenCalledTimes(2);

            dispose();
        });
    });
});

describe('useQuery — slice-memoized', () =>
{
    it('reflects the current query', () =>
    {
        createRoot((dispose) =>
        {
            const { router, setLocation } = makeRouterStub();

            setLocation(loc({
                pathname: '/search',
                search: '?q=azeroth&page=2',
                query: { q: 'azeroth', page: '2' }
            }));

            const query = useQuery(router);
            expect(query()).toEqual({ q: 'azeroth', page: '2' });

            dispose();
        });
    });

    it('does NOT re-fire downstream effects when only the path changes', () =>
    {
        createRoot((dispose) =>
        {
            const { router, setLocation } = makeRouterStub();
            setLocation(loc({
                pathname: '/search',
                search: '?q=azeroth',
                query: { q: 'azeroth' }
            }));

            const query = useQuery(router);
            const downstream = vi.fn();

            createEffect(() =>
            {
                query();
                downstream();
            });

            expect(downstream).toHaveBeenCalledOnce();

            // Path changes, query stays the same → no re-fire.
            setLocation(loc({
                pathname: '/different-page',
                search: '?q=azeroth',
                query: { q: 'azeroth' }
            }));

            expect(downstream).toHaveBeenCalledOnce();

            dispose();
        });
    });

    it('DOES re-fire downstream effects when an array-valued query slice changes', () =>
    {
        createRoot((dispose) =>
        {
            const { router, setLocation } = makeRouterStub();
            setLocation(loc({
                search: '?tags=a&tags=b',
                query: { tags: ['a', 'b'] }
            }));

            const query = useQuery(router);
            const downstream = vi.fn();

            createEffect(() =>
            {
                query();
                downstream();
            });

            expect(downstream).toHaveBeenCalledOnce();

            // Same key but different array contents — must re-fire.
            setLocation(loc({
                search: '?tags=a&tags=c',
                query: { tags: ['a', 'c'] }
            }));

            expect(downstream).toHaveBeenCalledTimes(2);

            dispose();
        });
    });
});

describe('useNavigate — bundled imperative API', () =>
{
    it('returns navigate / replace / back / forward bound to the router', () =>
    {
        const { router } = makeRouterStub();
        const api = useNavigate(router);

        expect(api.navigate).toBe(router.navigate);
        expect(api.replace).toBe(router.replace);
        expect(api.back).toBe(router.back);
        expect(api.forward).toBe(router.forward);
    });

    it('methods still call through to the router after destructuring', () =>
    {
        const stub = makeRouterStub();
        const { navigate, replace, back, forward } = useNavigate(stub.router);

        navigate('/foo');
        expect(stub.navigateSpy).toHaveBeenCalledWith('/foo');

        replace('/bar');
        expect(stub.replaceSpy).toHaveBeenCalledWith('/bar');

        back();
        expect(stub.backSpy).toHaveBeenCalledOnce();

        forward();
        expect(stub.forwardSpy).toHaveBeenCalledOnce();
    });
});
