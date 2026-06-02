// Wraps the browser's HTML5 History API behind the HistoryAdapter interface so
// the router stays oblivious to where URL changes come from. The router never
// imports window.history directly, which lets tests swap in a memory-only
// adapter, SSR swap in a request-bound one, and hash mode drop in later.
//
// Fan-out from a single native listener: many subscribers can attach, but we
// keep them in a private Set and install one popstate listener on the window,
// never one per subscriber. It's detached when the last subscriber leaves and
// re-attached if a new one arrives.
//
// push/replace do not fire popstate, so we notify manually. The browser fires
// popstate only for user-driven back/forward (and history.back()/forward());
// programmatic pushState/replaceState are silent. After every push/replace we
// invoke our subscribers with the post-mutation URL, otherwise the router would
// be deaf to its own navigations.
//
// current() returns pathname + search + hash exactly as the browser sees it. We
// read it from window.location after every mutation rather than trusting the
// input argument, so relative pushes (e.g. 'foo/bar') come out resolved.

import type { HistoryAdapter } from './types.ts';

/**
 * Builds a `HistoryAdapter` backed by the browser's `window.history` and
 * `popstate` event.
 *
 * Multiple calls return independent adapter instances, each with its own
 * subscriber Set, so attaching/detaching subscribers on one does not affect the
 * other. They do share the underlying `window.history`, which is the point.
 *
 * Must be called in a browser-like environment (one that provides
 * `window.history`, `window.location`, and the `popstate` event). Under Node
 * without a DOM polyfill it will fail at the first `current()`/`push()`.
 *
 * @returns A `HistoryAdapter` ready for use by `createRouter`
 *
 * @example
 * ```ts
 * const history = createBrowserHistory();
 *
 * history.current();              // -> '/users/42'
 * history.push('/users/43');      // updates URL + notifies
 * history.replace('/login');      // replaces top entry + notifies
 * history.back();                 // goes back; popstate notifies
 *
 * const unsub = history.subscribe(path => console.log(path));
 * unsub();                        // detaches; removes popstate listener if last
 * ```
 */
export function createBrowserHistory(): HistoryAdapter
{
    // Active subscribers. Snapshotted to an array before iterating so a
    // listener that subscribes or unsubscribes during notification doesn't
    // mutate the collection mid-loop.
    const subscribers = new Set<(fullPath: string) => void>();

    // Whether the shared popstate listener is installed. Tracked explicitly so
    // we can detach it when the last subscriber leaves.
    let popstateAttached = false;

    // The browser is the source of truth; we never cache the URL.
    function readCurrent(): string
    {
        const loc = window.location;
        return loc.pathname + loc.search + loc.hash;
    }

    // Delivers fullPath to a snapshot of subscribers. Snapshotting matters: a
    // listener might unsubscribe during its own callback, and we don't want to
    // skip the next listener as a result.
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
            // pushState is silent, so fan out manually so the router sees its
            // own navigations.
            notify(readCurrent());
        },

        replace(fullPath: string, state?: unknown): void
        {
            window.history.replaceState(state, '', fullPath);
            notify(readCurrent());
        },

        back(): void
        {
            // The browser fires popstate, which invokes the shared handler. No
            // manual notify here.
            window.history.back();
        },

        forward(): void
        {
            window.history.forward();
        },

        subscribe(listener: (fullPath: string) => void): () => void
        {
            subscribers.add(listener);

            // Install the native popstate listener lazily on the first
            // subscriber, so we don't add a listener that has nothing to do.
            if (!popstateAttached)
            {
                window.addEventListener('popstate', onPopstate);
                popstateAttached = true;
            }

            // Unsubscribe removes this listener and detaches the native
            // popstate when the set empties, so a long-lived adapter doesn't
            // hold a permanent listener for a no-longer-used router.
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
