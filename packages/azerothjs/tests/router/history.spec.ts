// Full behavioral coverage for the HistoryAdapter implementations (history.ts):
// createMemoryHistory's stack/cursor semantics (push truncation, back/forward
// clamping, subscribe notification) and createBrowserHistory wired to happy-dom's
// real window.history (push/replace notify, back/forward via popstate, the lazily
// attached shared popstate listener). Real execution - no mocked history.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMemoryHistory, createBrowserHistory } from 'azerothjs';

describe('createMemoryHistory', () =>
{
    it('defaults to "/" when no initial url is given', () =>
    {
        const h = createMemoryHistory();
        expect(h.current()).toBe('/');
    });

    it('starts at the supplied initial url', () =>
    {
        const h = createMemoryHistory('/users/42?tab=posts#bio');
        expect(h.current()).toBe('/users/42?tab=posts#bio');
    });

    it('push advances current() to the new entry', () =>
    {
        const h = createMemoryHistory('/');
        h.push('/about');
        expect(h.current()).toBe('/about');
    });

    it('push notifies subscribers with the new full path', () =>
    {
        const h = createMemoryHistory('/');
        const seen: string[] = [];
        h.subscribe((p) => seen.push(p));
        h.push('/a');
        h.push('/b');
        expect(seen).toEqual(['/a', '/b']);
    });

    it('replace overwrites the current entry without growing the stack', () =>
    {
        const h = createMemoryHistory('/');
        h.push('/a');
        h.replace('/b');
        expect(h.current()).toBe('/b');
        // Only one entry beyond root, so a single back returns to root.
        h.back();
        expect(h.current()).toBe('/');
    });

    it('replace notifies subscribers', () =>
    {
        const h = createMemoryHistory('/');
        const seen: string[] = [];
        h.subscribe((p) => seen.push(p));
        h.replace('/x');
        expect(seen).toEqual(['/x']);
    });

    it('back moves the cursor to the previous entry and notifies', () =>
    {
        const h = createMemoryHistory('/');
        h.push('/a');
        h.push('/b');
        const seen: string[] = [];
        h.subscribe((p) => seen.push(p));
        h.back();
        expect(h.current()).toBe('/a');
        expect(seen).toEqual(['/a']);
    });

    it('forward moves the cursor toward the newest entry and notifies', () =>
    {
        const h = createMemoryHistory('/');
        h.push('/a');
        h.push('/b');
        h.back();
        h.back();
        expect(h.current()).toBe('/');
        const seen: string[] = [];
        h.subscribe((p) => seen.push(p));
        h.forward();
        expect(h.current()).toBe('/a');
        expect(seen).toEqual(['/a']);
    });

    it('back clamps at the start (no underflow, no notify)', () =>
    {
        const h = createMemoryHistory('/');
        const seen: string[] = [];
        h.subscribe((p) => seen.push(p));
        h.back();
        h.back();
        expect(h.current()).toBe('/');
        expect(seen).toEqual([]);
    });

    it('forward clamps at the end (no overflow, no notify)', () =>
    {
        const h = createMemoryHistory('/');
        h.push('/a');
        const seen: string[] = [];
        h.subscribe((p) => seen.push(p));
        h.forward();
        expect(h.current()).toBe('/a');
        expect(seen).toEqual([]);
    });

    it('a push after a back truncates the forward history', () =>
    {
        const h = createMemoryHistory('/');
        h.push('/a');
        h.push('/b');
        h.back(); // back to /a, /b is now forward
        h.push('/c'); // truncates /b
        expect(h.current()).toBe('/c');
        // forward must do nothing - /b was discarded.
        h.forward();
        expect(h.current()).toBe('/c');
        // back returns to /a, then /.
        h.back();
        expect(h.current()).toBe('/a');
        h.back();
        expect(h.current()).toBe('/');
    });

    it('unsubscribe stops further notifications', () =>
    {
        const h = createMemoryHistory('/');
        const seen: string[] = [];
        const unsub = h.subscribe((p) => seen.push(p));
        h.push('/a');
        unsub();
        h.push('/b');
        expect(seen).toEqual(['/a']);
    });

    it('supports multiple independent subscribers', () =>
    {
        const h = createMemoryHistory('/');
        const a: string[] = [];
        const b: string[] = [];
        h.subscribe((p) => a.push(p));
        h.subscribe((p) => b.push(p));
        h.push('/x');
        expect(a).toEqual(['/x']);
        expect(b).toEqual(['/x']);
    });

    it('a subscriber that unsubscribes mid-notification does not skip the next one', () =>
    {
        const h = createMemoryHistory('/');
        const order: string[] = [];
        const unsubFirst = h.subscribe(() =>
        {
            order.push('first');
            unsubFirst();
        });
        h.subscribe(() => order.push('second'));
        h.push('/x');
        expect(order).toEqual(['first', 'second']);
    });
});

describe('createBrowserHistory', () =>
{
    beforeEach(() =>
    {
        // Reset the real happy-dom URL to a known state between tests.
        window.history.replaceState(null, '', '/');
    });

    it('current() reads window.location (pathname + search + hash)', () =>
    {
        window.history.replaceState(null, '', '/users/7?tab=x#h');
        const h = createBrowserHistory();
        expect(h.current()).toBe('/users/7?tab=x#h');
    });

    it('push mutates window.history and notifies subscribers', () =>
    {
        const h = createBrowserHistory();
        const seen: string[] = [];
        h.subscribe((p) => seen.push(p));
        h.push('/about');
        expect(window.location.pathname).toBe('/about');
        expect(seen).toEqual(['/about']);
        expect(h.current()).toBe('/about');
    });

    it('replace mutates window.history and notifies subscribers', () =>
    {
        const h = createBrowserHistory();
        const seen: string[] = [];
        h.subscribe((p) => seen.push(p));
        h.replace('/replaced');
        expect(window.location.pathname).toBe('/replaced');
        expect(seen).toEqual(['/replaced']);
    });

    it('attaches state to the history entry on push', () =>
    {
        const h = createBrowserHistory();
        h.push('/with-state', { from: 'test' });
        expect(window.history.state).toEqual({ from: 'test' });
    });

    it('unsubscribe stops notifications', () =>
    {
        const h = createBrowserHistory();
        const seen: string[] = [];
        const unsub = h.subscribe((p) => seen.push(p));
        h.push('/a');
        unsub();
        h.push('/b');
        expect(seen).toEqual(['/a']);
    });

    it('back fires popstate which notifies via the shared listener', async () =>
    {
        const h = createBrowserHistory();
        const seen: string[] = [];
        h.subscribe((p) => seen.push(p));
        h.push('/first');
        h.push('/second');
        // push notifications already recorded; clear them to isolate back().
        seen.length = 0;

        await new Promise<void>((resolve) =>
        {
            const onPop = (): void =>
            {
                window.removeEventListener('popstate', onPop);
                resolve();
            };
            window.addEventListener('popstate', onPop);
            h.back();
        });

        expect(window.location.pathname).toBe('/first');
        expect(seen).toEqual(['/first']);
    });

    it('does not notify a subscriber added after a push', () =>
    {
        const h = createBrowserHistory();
        h.push('/early');
        const seen: string[] = [];
        h.subscribe((p) => seen.push(p));
        // No navigation since subscribing.
        expect(seen).toEqual([]);
    });

    it('multiple adapters each maintain their own subscriber set over the shared window', () =>
    {
        const a = createBrowserHistory();
        const b = createBrowserHistory();
        const seenA: string[] = [];
        const seenB: string[] = [];
        a.subscribe((p) => seenA.push(p));
        b.subscribe((p) => seenB.push(p));
        // a.push notifies only a's subscribers (manual fan-out), though both see
        // the shared window.location via current().
        a.push('/shared');
        expect(seenA).toEqual(['/shared']);
        expect(seenB).toEqual([]);
        expect(b.current()).toBe('/shared');
    });
});

// Leaving the app is a DOCUMENT navigation, not a history write: pushState/replaceState
// refuse a cross-origin URL with SecurityError, which used to escape from inside the effect
// that committed a guard or loader redirect. These arms pin the exit AND its allowlist.
describe('createBrowserHistory - leaving the origin', () =>
{
    it('push sends an off-origin http target through location.assign, not history', () =>
    {
        const h = createBrowserHistory();
        const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
        const before = window.history.length;
        try
        {
            h.push('http://other.example:5400/page');
            expect(assign).toHaveBeenCalledWith('http://other.example:5400/page');
            expect(window.history.length).toBe(before);
        }
        finally
        {
            assign.mockRestore();
        }
    });

    it('replace sends an off-origin target through location.replace', () =>
    {
        const h = createBrowserHistory();
        const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => undefined);
        try
        {
            h.replace('https://other.example/page');
            expect(replace).toHaveBeenCalledWith('https://other.example/page');
        }
        finally
        {
            replace.mockRestore();
        }
    });

    // A document navigation EXECUTES a javascript: URL, where pushState merely threw. Widening
    // the commit step to location.assign must not open that sink: measured in a real browser,
    // removing this guard runs the script.
    it('REFUSES a javascript: target instead of navigating to it', () =>
    {
        const h = createBrowserHistory();
        const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
        const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => undefined);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try
        {
            h.push('javascript:window.__pwned = 1');
            expect(assign).not.toHaveBeenCalled();
            expect(replace).not.toHaveBeenCalled();
            expect(errors).toHaveBeenCalled();
        }
        finally
        {
            assign.mockRestore();
            replace.mockRestore();
            errors.mockRestore();
        }
    });

    // The arm that fails a syntactic external-URL test: an ABSOLUTE same-origin URL must stay
    // an ordinary SPA navigation rather than forcing a full page load.
    it('CONTROL: an absolute SAME-ORIGIN url still writes history', () =>
    {
        const h = createBrowserHistory();
        const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
        try
        {
            h.push(window.location.origin + '/deep/page');
            expect(assign).not.toHaveBeenCalled();
            expect(h.current()).toBe('/deep/page');
        }
        finally
        {
            assign.mockRestore();
        }
    });

    it('CONTROL: an ordinary in-app path still writes history', () =>
    {
        const h = createBrowserHistory();
        const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
        try
        {
            h.push('/plain/path');
            expect(assign).not.toHaveBeenCalled();
            expect(h.current()).toBe('/plain/path');
        }
        finally
        {
            assign.mockRestore();
        }
    });
});
