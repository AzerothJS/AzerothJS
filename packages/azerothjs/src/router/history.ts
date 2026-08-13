/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The HistoryAdapter implementations: createBrowserHistory over the HTML5 History API, and
 * createMemoryHistory as an in-memory stack for SSR and tests.
 *
 * The router never touches window.history directly. Going through an adapter is what lets a
 * test swap in a memory-only one, SSR bind a request-scoped one, and a hash-mode adapter
 * arrive later without touching the router.
 *
 * Both fan out from a single subscriber set, snapshotted before notifying so a listener that
 * subscribes or unsubscribes mid-callback cannot corrupt the loop. The browser adapter
 * installs ONE popstate listener lazily on the first subscriber and detaches it when the last
 * leaves. Since pushState and replaceState are silent - popstate fires only for user
 * navigation - it notifies manually after each, reading the post-mutation URL from
 * window.location so a relative push resolves correctly.
 */

import type { HistoryAdapter } from './types.ts';

/**
 * A {@link HistoryAdapter} over `window.history` and the popstate event, and the default
 * createRouter uses in a browser.
 *
 * Browser-only: with no `window` it fails at the first `current()` or `push()`. Use
 * {@link createMemoryHistory} on the server and in tests.
 *
 * push and replace are SILENT as far as the platform is concerned - popstate fires only for
 * user back and forward - so this adapter notifies manually after each, reading the
 * post-mutation URL from `window.location` so a relative push comes out resolved. back and
 * forward rely on the real popstate and do not notify twice.
 *
 * Separate instances keep their own subscriber sets but share the one underlying history.
 * Unsubscribing the last subscriber detaches the native listener.
 *
 * @returns The adapter.
 * @example
 * const history = createBrowserHistory();
 * const unsubscribe = history.subscribe(path => log(path));
 * history.push('/users/43');
 * unsubscribe();
 *
 * @see {@link createMemoryHistory}
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

        state(): unknown
        {
            return window.history.state;
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
 * An in-memory {@link HistoryAdapter} over a navigation stack, for SSR - one per request,
 * bound to the requested URL - and for tests, which have no popstate to drive.
 *
 * push truncates any forward entries and appends, replace overwrites the current entry, and
 * back and forward move a cursor that clamps at both ends. Every move notifies subscribers,
 * push and replace included: the router must see its own navigations, which is the same
 * contract the browser adapter upholds, so the router behaves identically in both.
 *
 * This is an isolated stack, NOT synced to the browser URL bar. Used client-side it will
 * neither reflect nor drive the real location.
 *
 * @param initial - Starting full path: pathname plus optional search and hash. Defaults to `/`.
 * @returns The adapter.
 * @example
 * const router = createRouter({ routes, history: createMemoryHistory(request.url) });
 *
 * @see {@link createBrowserHistory}
 */
export function createMemoryHistory(initial: string = '/'): HistoryAdapter
{
    const subscribers = new Set<(fullPath: string) => void>();

    // The navigation stack and the cursor into it. `back`/`forward` move the
    // cursor; `push` truncates everything after it before appending. Entries
    // carry their state so the router's stamping (delta, scroll keys) works in
    // tests and SSR exactly as in the browser.
    const stack: Array<{ path: string; state: unknown }> = [{ path: initial, state: undefined }];
    let cursor = 0;

    // Snapshot before iterating so a listener that (un)subscribes during its own
    // callback doesn't corrupt the loop - same guard as the browser adapter.
    function notify(): void
    {
        const fullPath = stack[cursor]?.path ?? initial;
        for (const listener of Array.from(subscribers))
        {
            listener(fullPath);
        }
    }

    return {
        current(): string
        {
            return stack[cursor]?.path ?? initial;
        },

        push(fullPath: string, state?: unknown): void
        {
            // A new push invalidates the forward history.
            stack.length = cursor + 1;
            stack.push({ path: fullPath, state });
            cursor++;
            notify();
        },

        replace(fullPath: string, state?: unknown): void
        {
            stack[cursor] = { path: fullPath, state };
            notify();
        },

        state(): unknown
        {
            return stack[cursor]?.state;
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
