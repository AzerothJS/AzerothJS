import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoot, createSignal } from '@azerothjs/core';
import { Link } from '../../packages/router/src/link.ts';
import type { Router } from '../../packages/router/src/router.ts';
import type { RouteLocation } from '../../packages/router/src/types.ts';

// ── Router stub ──────────────────────────────────────────────
//
// Constructing a full router for every test would couple Link's
// behaviour to the router's. This stub mirrors only the surface
// Link reads (`location()`, `navigate()`, `replace()`) and uses
// real signals so the activeClass tests still exercise reactivity.

interface RouterStub
{
    router: Router;
    setLocation: (loc: RouteLocation) => void;
    navigateSpy: ReturnType<typeof vi.fn>;
    replaceSpy: ReturnType<typeof vi.fn>;
}

function makeRouterStub(pathname = '/'): RouterStub
{
    const [location, setLocationInternal] = createSignal<RouteLocation>(
        {
            pathname,
            search: '',
            hash: '',
            params: {},
            query: {},
            fullPath: pathname
        }
    );

    const navigateSpy = vi.fn();
    const replaceSpy = vi.fn();

    // Inert loader resource — Link doesn't read it, but the Router
    // type requires the field, so we provide a no-op stub.
    const stubLoader = {
        data: () => undefined,
        loading: () => false,
        error: () => null,
        refetch: () =>
        {}
    };

    const router: Router =
    {
        location,
        match: () => null,
        loader: stubLoader,
        navigate: navigateSpy,
        replace: replaceSpy,
        back: vi.fn(),
        forward: vi.fn()
    };

    return { router, setLocation: setLocationInternal, navigateSpy, replaceSpy };
}

/**
 * Builds a left-button MouseEvent that bubbles and is cancelable —
 * the shape Link's handler expects to intercept.
 */
function plainClickEvent(init: Partial<MouseEventInit> = {}): MouseEvent
{
    return new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...init
    });
}

describe('Link component', () =>
{
    beforeEach(() =>
    {
        // Each test renders into document.body. Clean up between
        // tests so a click in one doesn't bubble into another.
        document.body.innerHTML = '';
    });

    // Note: bail-out tests dispatch the click on a DETACHED link.
    // happy-dom only emulates browser navigation for in-document
    // anchors, so detaching keeps the bail-out cases free of
    // ECONNREFUSED noise without compromising the assertion (our
    // click handler still runs on a detached target).

    // ── Rendering ────────────────────────────────────────────

    it('renders an anchor with the correct href from a string target', () =>
    {
        createRoot((dispose) =>
        {
            const { router } = makeRouterStub();
            const link = Link({ to: '/users/42', router, children: 'View user' });

            expect(link.tagName).toBe('A');
            expect(link.getAttribute('href')).toBe('/users/42');
            expect(link.textContent).toBe('View user');

            dispose();
        });
    });

    it('renders an anchor with the correct href from a structured target', () =>
    {
        createRoot((dispose) =>
        {
            const { router } = makeRouterStub();
            const link = Link({
                to: { pathname: '/search', query: { q: 'azeroth' }, hash: '#top' },
                router
            });

            expect(link.getAttribute('href')).toBe('/search?q=azeroth#top');

            dispose();
        });
    });

    // ── Interception (positive case) ─────────────────────────

    it('intercepts a plain left-click and calls router.navigate', () =>
    {
        createRoot((dispose) =>
        {
            const { router, navigateSpy } = makeRouterStub();
            const link = Link({ to: '/users/42', router });
            document.body.appendChild(link);

            const event = plainClickEvent();
            link.dispatchEvent(event);

            expect(navigateSpy).toHaveBeenCalledOnce();
            expect(navigateSpy).toHaveBeenCalledWith('/users/42', { scroll: undefined });
            expect(event.defaultPrevented).toBe(true);

            dispose();
        });
    });

    // ── Interception (bail-out cases) ────────────────────────

    it('does NOT intercept when a modifier key is held', () =>
    {
        createRoot((dispose) =>
        {
            const { router, navigateSpy } = makeRouterStub();
            const link = Link({ to: '/users/42', router });

            // One assertion per modifier — they should ALL pass through.
            for (const init of [
                { ctrlKey: true },
                { metaKey: true },
                { shiftKey: true },
                { altKey: true }
            ])
            {
                const event = plainClickEvent(init);
                link.dispatchEvent(event);
                expect(event.defaultPrevented).toBe(false);
            }

            expect(navigateSpy).not.toHaveBeenCalled();

            dispose();
        });
    });

    it('does NOT intercept a middle-click (button !== 0)', () =>
    {
        createRoot((dispose) =>
        {
            const { router, navigateSpy } = makeRouterStub();
            const link = Link({ to: '/users/42', router });

            const event = plainClickEvent({ button: 1 });
            link.dispatchEvent(event);

            expect(navigateSpy).not.toHaveBeenCalled();
            expect(event.defaultPrevented).toBe(false);

            dispose();
        });
    });

    it('does NOT intercept when target is _blank (or any non-_self target)', () =>
    {
        createRoot((dispose) =>
        {
            const { router, navigateSpy } = makeRouterStub();
            const link = Link({ to: '/users/42', router, target: '_blank' });

            const event = plainClickEvent();
            link.dispatchEvent(event);

            expect(navigateSpy).not.toHaveBeenCalled();
            expect(event.defaultPrevented).toBe(false);

            dispose();
        });
    });

    it('does NOT intercept external URLs (https://, mailto:, tel:, …)', () =>
    {
        createRoot((dispose) =>
        {
            const { router, navigateSpy } = makeRouterStub();

            for (const href of [
                'https://example.com',
                'mailto:hi@example.com',
                'tel:+1234567890',
                '//cdn.example.com/asset.js'
            ])
            {
                const link = Link({ to: href, router });

                const event = plainClickEvent();
                link.dispatchEvent(event);

                expect(event.defaultPrevented).toBe(false);
            }

            expect(navigateSpy).not.toHaveBeenCalled();

            dispose();
        });
    });

    // ── Replace mode ─────────────────────────────────────────

    it('calls router.replace when replace is set', () =>
    {
        createRoot((dispose) =>
        {
            const { router, navigateSpy, replaceSpy } = makeRouterStub();
            const link = Link({ to: '/login', router, replace: true });
            document.body.appendChild(link);

            link.dispatchEvent(plainClickEvent());

            expect(replaceSpy).toHaveBeenCalledOnce();
            expect(replaceSpy).toHaveBeenCalledWith('/login', { scroll: undefined });
            expect(navigateSpy).not.toHaveBeenCalled();

            dispose();
        });
    });

    // ── activeClass / aria-current ───────────────────────────

    it('applies activeClass when the current pathname matches', () =>
    {
        createRoot((dispose) =>
        {
            const { router } = makeRouterStub('/users/42');
            const link = Link({
                to: '/users/42',
                router,
                activeClass: 'is-active',
                class: 'btn'
            });

            expect(link.className).toBe('btn is-active');

            dispose();
        });
    });

    it('does not apply activeClass when the current pathname differs', () =>
    {
        createRoot((dispose) =>
        {
            const { router } = makeRouterStub('/about');
            const link = Link({
                to: '/users/42',
                router,
                activeClass: 'is-active',
                class: 'btn'
            });

            expect(link.className).toBe('btn');

            dispose();
        });
    });

    it('reactively toggles activeClass when the location changes', () =>
    {
        createRoot((dispose) =>
        {
            const { router, setLocation } = makeRouterStub('/about');
            const link = Link({
                to: '/users/42',
                router,
                activeClass: 'is-active'
            });

            expect(link.className).toBe('');

            setLocation({
                pathname: '/users/42',
                search: '',
                hash: '',
                params: {},
                query: {},
                fullPath: '/users/42'
            });
            expect(link.className).toBe('is-active');

            setLocation({
                pathname: '/about',
                search: '',
                hash: '',
                params: {},
                query: {},
                fullPath: '/about'
            });
            expect(link.className).toBe('');

            dispose();
        });
    });

    it('toggles aria-current="page" in lockstep with activeClass', () =>
    {
        createRoot((dispose) =>
        {
            const { router, setLocation } = makeRouterStub('/users/42');
            const link = Link({
                to: '/users/42',
                router,
                activeClass: 'is-active'
            });

            expect(link.getAttribute('aria-current')).toBe('page');

            setLocation({
                pathname: '/somewhere-else',
                search: '',
                hash: '',
                params: {},
                query: {},
                fullPath: '/somewhere-else'
            });
            expect(link.getAttribute('aria-current')).toBeNull();

            dispose();
        });
    });
});
