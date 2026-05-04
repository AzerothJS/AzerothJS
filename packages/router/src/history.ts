// ============================================================================
// AZEROTHJS — Browser History Adapter
// ============================================================================
//
// Wraps the browser's HTML5 History API behind the `HistoryAdapter`
// interface so the router can stay oblivious to the underlying
// source of URL changes.
//
// WHY AN ADAPTER?
//
//   The router never imports `window.history` directly. That gives
//   us three benefits:
//     1. Tests can swap in a memory-only adapter
//     2. SSR can swap in a request-bound adapter
//     3. Hash mode (or any other strategy) is a future drop-in
//
// FAN-OUT WITH A SINGLE NATIVE LISTENER:
//
//   Many subscribers can attach to one adapter. We keep them in
//   a private Set and install ONE `popstate` listener on the
//   window — never one per subscriber. The native listener is
//   detached when the last subscriber leaves, then re-attached
//   if a new subscriber arrives later.
//
// PUSH/REPLACE DON'T FIRE popstate — WE NOTIFY MANUALLY:
//
//   The browser fires `popstate` only for user-driven back/forward
//   (and `history.back()` / `forward()` calls). Programmatic
//   `pushState` and `replaceState` are silent. So after every
//   push/replace we explicitly invoke our subscribers with the
//   post-mutation URL — otherwise the router would be deaf to its
//   own programmatic navigations.
//
// CANONICAL URL FORM:
//
//   `current()` returns `pathname + search + hash`, with the
//   leading slash, exactly as the browser sees it. We read this
//   from `window.location` after every mutation rather than
//   trusting the input argument — that way relative pushes (e.g.
//   `'foo/bar'`) come out resolved, not as the raw input.
//
// ============================================================================

import type { HistoryAdapter } from './types.ts';

/**
 * Builds a `HistoryAdapter` backed by the browser's
 * `window.history` and `popstate` event.
 *
 * Multiple calls return independent adapter instances — they
 * each maintain their own subscriber Set, so attaching/detaching
 * subscribers on one does not affect the other. They DO share
 * the underlying `window.history`, of course; that's the whole
 * point.
 *
 * Must be called in a browser-like environment (anything that
 * provides `window.history`, `window.location`, and the
 * `popstate` event). Calling it under Node without a DOM polyfill
 * will fail at the first `current()`/`push()`.
 *
 * @returns A `HistoryAdapter` ready for use by `createRouter`
 *
 * @example
 * ```ts
 * const history = createBrowserHistory();
 *
 * history.current();              // → '/users/42'
 * history.push('/users/43');      // updates URL + notifies
 * history.replace('/login');      // replaces top entry + notifies
 * history.back();                 // goes back; popstate notifies
 *
 * const unsub = history.subscribe(path => console.log(path));
 * // …later
 * unsub();                        // detaches; if last subscriber,
 *                                 // popstate listener removed too
 * ```
 */
export function createBrowserHistory(): HistoryAdapter
{
    /**
     * The set of currently active subscribers. We snapshot this
     * to an array before iterating so a listener that subscribes
     * or unsubscribes during notification doesn't mutate the
     * collection mid-loop.
     */
    const subscribers = new Set<(fullPath: string) => void>();

    /**
     * Whether our shared `popstate` listener is installed on the
     * window. Tracked explicitly so we can detach it when the
     * last subscriber leaves.
     */
    let popstateAttached = false;

    /**
     * Reads the current URL straight from `window.location`. The
     * browser is the source of truth — we never cache.
     */
    function readCurrent(): string
    {
        const loc = window.location;
        return loc.pathname + loc.search + loc.hash;
    }

    /**
     * Iterates a snapshot of subscribers and delivers `fullPath`
     * to each. Snapshotting matters: a listener might unsubscribe
     * during its own callback, and we don't want to skip the
     * next listener as a result.
     */
    function notify(fullPath: string): void
    {
        for (const listener of Array.from(subscribers))
        {
            listener(fullPath);
        }
    }

    /** The single native popstate handler shared by all subscribers. */
    function onPopstate(): void
    {
        notify(readCurrent());
    }

    return {
        current(): string
        {
            return readCurrent();
        },

        push(fullPath: string, state?: unknown): void
        {
            window.history.pushState(state, '', fullPath);
            // pushState is silent — fan out manually so the router
            // sees its own navigations.
            notify(readCurrent());
        },

        replace(fullPath: string, state?: unknown): void
        {
            window.history.replaceState(state, '', fullPath);
            notify(readCurrent());
        },

        back(): void
        {
            // The browser will fire popstate, which invokes our
            // shared handler. No manual notify here.
            window.history.back();
        },

        forward(): void
        {
            window.history.forward();
        },

        subscribe(listener: (fullPath: string) => void): () => void
        {
            subscribers.add(listener);

            // Lazily install the native popstate listener on the
            // first subscriber. This avoids polluting the window
            // with a listener that has nothing to do.
            if (!popstateAttached)
            {
                window.addEventListener('popstate', onPopstate);
                popstateAttached = true;
            }

            // Return an unsubscribe that:
            //   1. removes this specific listener
            //   2. detaches the native popstate when the set
            //      empties, so a long-lived adapter doesn't hold
            //      a permanent listener for a no-longer-used router
            return (): void =>
            {
                subscribers.delete(listener);

                if (subscribers.size === 0 && popstateAttached)
                {
                    window.removeEventListener('popstate', onPopstate);
                    popstateAttached = false;
                }
            };
        }
    };
}
