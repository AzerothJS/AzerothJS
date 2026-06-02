import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBrowserHistory } from '../../packages/router/src/history.ts';

describe('createBrowserHistory', () =>
{
    // Each test starts from the same known URL so assertions on
    // `current()` aren't sensitive to leftover state from prior
    // tests.
    beforeEach(() =>
    {
        window.history.replaceState({}, '', '/initial');
    });

    it('reflects the current URL via current()', () =>
    {
        window.history.replaceState({}, '', '/users/42?tab=posts#bio');
        const history = createBrowserHistory();

        expect(history.current()).toBe('/users/42?tab=posts#bio');
    });

    it('updates current() after push()', () =>
    {
        const history = createBrowserHistory();

        history.push('/users/43');
        expect(history.current()).toBe('/users/43');

        history.push('/login?redirect=/home');
        expect(history.current()).toBe('/login?redirect=/home');
    });

    it('notifies subscribers when push() is called', () =>
    {
        const history = createBrowserHistory();
        const listener = vi.fn();

        const unsub = history.subscribe(listener);
        history.push('/users/43');

        expect(listener).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith('/users/43');

        unsub();
    });

    it('updates current() and notifies subscribers on replace()', () =>
    {
        const history = createBrowserHistory();
        const listener = vi.fn();

        const unsub = history.subscribe(listener);
        history.replace('/login');

        expect(history.current()).toBe('/login');
        expect(listener).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith('/login');

        unsub();
    });

    it('detaches a listener via the returned unsubscribe', () =>
    {
        const history = createBrowserHistory();
        const listener = vi.fn();

        const unsub = history.subscribe(listener);
        history.push('/a');
        expect(listener).toHaveBeenCalledOnce();

        unsub();
        history.push('/b');

        // No further calls after unsubscribe.
        expect(listener).toHaveBeenCalledOnce();
    });

    it('fans out each notification to multiple subscribers', () =>
    {
        const history = createBrowserHistory();
        const listenerA = vi.fn();
        const listenerB = vi.fn();
        const listenerC = vi.fn();

        const unsubs =
        [
            history.subscribe(listenerA),
            history.subscribe(listenerB),
            history.subscribe(listenerC)
        ];

        history.push('/page-1');

        expect(listenerA).toHaveBeenCalledWith('/page-1');
        expect(listenerB).toHaveBeenCalledWith('/page-1');
        expect(listenerC).toHaveBeenCalledWith('/page-1');

        for (const unsub of unsubs)
        {
            unsub();
        }
    });

    it('propagates a manual popstate event (back/forward simulation) to subscribers', () =>
    {
        const history = createBrowserHistory();
        const listener = vi.fn();

        const unsub = history.subscribe(listener);

        // Simulate a back/forward by changing history out-of-band
        // and dispatching popstate manually. The adapter's shared
        // popstate handler will read window.location and notify.
        window.history.replaceState({}, '', '/back-target');
        window.dispatchEvent(new PopStateEvent('popstate'));

        expect(listener).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith('/back-target');

        unsub();
    });

    it('detaches the native popstate listener when the last subscriber leaves', () =>
    {
        const removeSpy = vi.spyOn(window, 'removeEventListener');
        const history = createBrowserHistory();

        const unsubA = history.subscribe(() =>
        {});
        const unsubB = history.subscribe(() =>
        {});

        // Removing one of two subscribers must NOT detach the
        // native listener - there's still another consumer.
        unsubA();
        expect(removeSpy).not.toHaveBeenCalledWith('popstate', expect.any(Function));

        // Removing the last subscriber must detach it.
        unsubB();
        expect(removeSpy).toHaveBeenCalledWith('popstate', expect.any(Function));

        removeSpy.mockRestore();
    });
});
