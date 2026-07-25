/**
 * MODULE: router/history
 *
 * HistoryAdapter implementations: createBrowserHistory wraps the HTML5 History API;
 * createMemoryHistory is an in-memory stack for SSR and tests. The router never imports
 * window.history directly - it goes through the adapter - which lets tests swap in a memory-only
 * adapter, SSR bind a request-scoped one, and a hash-mode adapter drop in later.
 *
 * Both fan out from a SINGLE source: a private subscriber Set, snapshotted before notifying so a
 * listener that (un)subscribes mid-callback does not corrupt the loop. The browser adapter installs
 * ONE popstate listener lazily on the first subscriber and detaches it when the last leaves; since
 * pushState/replaceState are silent (popstate fires only for user back/forward), it notifies
 * manually after each, reading the post-mutation URL from window.location so relative pushes resolve.
 */

import type { HistoryAdapter } from './types.ts';

/**
 * createBrowserHistory
 *
 * PURPOSE:
 * Builds a {@link HistoryAdapter} backed by the browser's window.history and popstate event.
 *
 * WHY IT EXISTS:
 * The router must stay oblivious to where URL changes originate. Wrapping the History API behind the
 * adapter interface is what lets the same router run against a real browser, an in-memory stack
 * (SSR/tests), or a future hash-mode adapter, without the router importing window.history.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, router; the default adapter createRouter uses when none is provided.
 *
 * INPUT CONTRACT:
 * - None. Requires a browser-like environment (window.history, window.location, popstate).
 *
 * OUTPUT CONTRACT:
 * - A HistoryAdapter: current()/push()/replace()/back()/forward()/subscribe(). Independent instances
 *   have their own subscriber Set but share the one underlying window.history.
 *
 * WHY THIS DESIGN:
 * One shared popstate listener (lazily attached on the first subscriber, detached when the last
 * leaves) avoids a listener per subscriber. push/replace notify manually with the post-mutation URL
 * read from window.location, so the router sees its own navigations and relative pushes come out
 * resolved; back/forward rely on the browser's popstate (no manual notify).
 *
 * WHEN TO USE:
 * Default client routing (createRouter picks it automatically in the browser).
 *
 * WHEN NOT TO USE:
 * On the server or in tests with no DOM - use {@link createMemoryHistory}.
 *
 * EDGE CASES:
 * - In a non-browser environment it fails at the first current()/push() (no window).
 * - Unsubscribing the last subscriber detaches the native popstate listener.
 *
 * PERFORMANCE NOTES:
 * One native popstate listener regardless of subscriber count; notification is O(subscribers).
 *
 * DEVELOPER WARNING:
 * Browser-only. Do not assume push/replace fire popstate (they are silent and notify manually);
 * back/forward DO fire popstate.
 *
 * @returns A {@link HistoryAdapter} for createRouter.
 * @see {@link createMemoryHistory}
 * @example
 * const history = createBrowserHistory();
 * history.push('/users/43');
 * const unsub = history.subscribe(path => console.log(path));
 * unsub();
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

/**
 * createMemoryHistory
 *
 * PURPOSE:
 * Builds an in-memory {@link HistoryAdapter} backed by a navigation stack rather than the browser.
 *
 * WHY IT EXISTS:
 * SSR must bind a router to the requested URL per request, and tests must drive navigation with no
 * DOM popstate. A window-free adapter provides identical history semantics in both, so the same
 * router code runs server-side and under test.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, router; passed via createRouter({ history }) for SSR (one per request) and tests.
 *
 * INPUT CONTRACT:
 * - initial: the starting fullPath (pathname + optional search + hash); defaults to '/'.
 *
 * OUTPUT CONTRACT:
 * - A HistoryAdapter over a stack + cursor: push truncates forward entries and appends; replace
 *   overwrites the current entry; back/forward move the cursor (clamped at the ends). Every move -
 *   including push/replace - notifies subscribers (the router must see its own navigations, the same
 *   contract the browser adapter upholds).
 *
 * WHY THIS DESIGN:
 * A plain stack + cursor mirrors browser back/forward semantics without any window dependency, and
 * notifying on push/replace (not just back/forward) keeps the contract identical to the browser
 * adapter so the router behaves the same in both environments.
 *
 * WHEN TO USE:
 * SSR (createMemoryHistory(req.url)) and tests.
 *
 * WHEN NOT TO USE:
 * In the browser for a real page - use {@link createBrowserHistory}, which syncs the actual URL bar.
 *
 * EDGE CASES:
 * - back/forward clamp at the ends (no underflow/overflow).
 * - A push invalidates any forward history past the cursor.
 *
 * PERFORMANCE NOTES:
 * O(1) per navigation; notification is O(subscribers).
 *
 * DEVELOPER WARNING:
 * This is an isolated stack, NOT synced to the browser URL bar - using it client-side will not
 * reflect or drive the real location.
 *
 * @param initial - The starting fullPath. Default '/'.
 * @returns A {@link HistoryAdapter} for createRouter.
 * @see {@link createBrowserHistory}
 * @example
 * const router = createRouter({ routes, history: createMemoryHistory(req.url) });
 */
export function createMemoryHistory(initial: string = '/'): HistoryAdapter
{
    const subscribers = new Set<(fullPath: string) => void>();

    // The navigation stack and the cursor into it. `back`/`forward` move the
    // cursor; `push` truncates everything after it before appending.
    const stack: string[] = [initial];
    let cursor = 0;

    // Snapshot before iterating so a listener that (un)subscribes during its own
    // callback doesn't corrupt the loop - same guard as the browser adapter.
    function notify(): void
    {
        const fullPath = stack[cursor] ?? initial;
        for (const listener of Array.from(subscribers))
        {
            listener(fullPath);
        }
    }

    return {
        current(): string
        {
            return stack[cursor] ?? initial;
        },

        push(fullPath: string): void
        {
            // A new push invalidates the forward history.
            stack.length = cursor + 1;
            stack.push(fullPath);
            cursor++;
            notify();
        },

        replace(fullPath: string): void
        {
            stack[cursor] = fullPath;
            notify();
        },

        back(): void
        {
            if (cursor > 0)
            {
                cursor--;
                notify();
            }
        },

        forward(): void
        {
            if (cursor < stack.length - 1)
            {
                cursor++;
                notify();
            }
        },

        subscribe(listener: (fullPath: string) => void): () => void
        {
            subscribers.add(listener);
            return (): void =>
            {
                subscribers.delete(listener);
            };
        }
    };
}
