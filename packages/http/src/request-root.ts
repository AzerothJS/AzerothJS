/**
 * MODULE: http/request-root - a request is a reactive root
 *
 * Runs each request inside an AsyncLocalStorage context carrying two things:
 *
 *   - a fresh STORE SCOPE. `createStore` singletons key on the active scope, so two
 *     concurrent requests get isolated instances - the exact isolation SSR renders already
 *     have, extended across `await` (reactivity's synchronous runInStoreScope cannot survive
 *     one; this module installs the async-context resolver reactivity exposes for hosts).
 *   - a CLEANUP REGISTRY. `onRequestCleanup(fn)` registers teardown that ALWAYS runs when
 *     the request settles - success, throw, or client abort - in LIFO order, mirroring the
 *     component world's onCleanup. (Reactivity's own onCleanup is a silent no-op outside a
 *     synchronous root, which an async handler is not; this registry is the request-scoped
 *     equivalent that survives awaits.)
 *
 * The resolver returns undefined outside a request, falling through to the synchronous
 * scope - so an SSR render nested INSIDE a request still isolates via its own
 * runInStoreScope, and non-request code (startup, tests without the root) behaves exactly
 * as before.
 *
 * AsyncLocalStorage is Node's async-context primitive; Bun, Deno, and workerd implement it
 * too, so this module - the one non-fetch-standard dependency of the app model - runs on
 * every mainstream server runtime. When TC39 AsyncContext lands, only this file changes.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { setStoreScopeResolver } from '@azerothjs/reactivity';

/** What the async context carries for one request. @internal */
interface RequestScope
{
    storeScope: object;
    /** Lazily allocated on the first onRequestCleanup - most requests register none. */
    cleanups: Array<() => void | Promise<void>> | null;
}

const storage = new AsyncLocalStorage<RequestScope>();

let resolverInstalled = false;

/** @internal Idempotent: reactivity consults the async context once a server exists. */
function installResolver(): void
{
    if (!resolverInstalled)
    {
        resolverInstalled = true;
        setStoreScopeResolver(() => storage.getStore()?.storeScope);
    }
}

/**
 * Registers teardown for the CURRENT request: closing a transaction, releasing a lock,
 * returning a connection. Runs when the request settles - success, error, or disconnect -
 * in LIFO order (later acquisitions release first). Throws outside a request: teardown
 * registered nowhere is a leak wearing a seatbelt, and loud beats leaking.
 */
export function onRequestCleanup(fn: () => void | Promise<void>): void
{
    const scope = storage.getStore();
    if (scope === undefined)
    {
        throw new Error('onRequestCleanup was called outside a request. It registers teardown '
            + 'for the current request root, so it only makes sense inside a handler or middleware.');
    }
    (scope.cleanups ??= []).push(fn);
}

/**
 * Runs `fn` inside a fresh request root. The App wraps every dispatch in this; adapters and
 * user code never call it directly. Cleanups run in a finally - each one awaited, each one
 * isolated (a throwing cleanup is reported and the rest still run; teardown must never
 * clobber the response or a sibling's release).
 */
export async function runInRequestRoot<T, A>(
    fn: (arg: A) => T | Promise<T>,
    arg: A,
    options: { onCleanupError?: ((error: unknown) => void) | undefined } = {}
): Promise<T>
{
    installResolver();
    // `arg` rides through storage.run instead of a per-request closure over `fn`;
    // the caller passes ONE stable function for the app's lifetime.
    const scope: RequestScope = { storeScope: {}, cleanups: null };
    try
    {
        return await storage.run(scope, fn, arg);
    }
    finally
    {
        if (scope.cleanups !== null)
        {
            for (let i = scope.cleanups.length - 1; i >= 0; i--)
            {
                try
                {
                    await scope.cleanups[i]?.();
                }
                catch (error)
                {
                    options.onCleanupError?.(error);
                }
            }
        }
    }
}
