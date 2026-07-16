/**
 * MODULE: reactivity/store-scope
 *
 * A store scope isolates lazy-singleton store instances per render. createStore caches
 * its instance keyed by the ACTIVE scope. On the client there is one stable scope for
 * the whole JS context, so a store is a true app-wide singleton (the original
 * behaviour). The server runs each render in its OWN scope (runInStoreScope, called by
 * renderToString), so concurrent requests get isolated store state instead of sharing
 * a module-level closure. This is sound because an SSR render is synchronous: one
 * render's scope is set and restored before the event loop can start another.
 *
 * ASYNC EXECUTION (an HTTP request handler that awaits) breaks the synchronous
 * save/restore model: after the first await, the module variable has been restored and
 * another request may have replaced it. A host that needs isolation ACROSS awaits
 * installs a {@link setStoreScopeResolver | scope resolver} backed by its runtime's
 * async-context primitive (AsyncLocalStorage on Node); this module stays dependency-free
 * and browser-portable - the resolver is one nullable function pointer, and clients
 * never install one.
 *
 * The scope is just an opaque object used as a WeakMap key, so a per-render scope (and
 * the store instances cached under it) is garbage-collected once the render returns.
 */

/** Default scope; client stores are app-wide singletons cached under it for the JS context's life. @internal */
const DEFAULT_SCOPE: object = {};

/** The currently active store scope. @internal */
let currentScope: object = DEFAULT_SCOPE;

/** The installed async-context resolver, if any. @internal */
let scopeResolver: (() => object | undefined) | null = null;

/**
 * setStoreScopeResolver
 *
 * PURPOSE:
 * Installs (or, with null, removes) a resolver consulted by getStoreScope BEFORE the
 * synchronous module scope - the seam that makes store isolation survive `await`.
 *
 * WHY IT EXISTS:
 * runInStoreScope's save/restore is only sound for synchronous work (an SSR render). An
 * HTTP server's handlers are async: isolation there needs an async-context carrier, and
 * WHICH carrier is a host concern (AsyncLocalStorage on Node; TC39 AsyncContext one
 * day). This hook lets the host own the carrier while this module stays zero-dependency
 * and portable.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime; installed once at server startup by the HTTP layer's request root. Never
 * called on the client.
 *
 * INPUT CONTRACT:
 * - resolver: returns the active scope object, or undefined to fall through to the
 *   synchronous scope (so SSR renders nested inside a request still isolate correctly);
 *   null uninstalls.
 *
 * OUTPUT CONTRACT:
 * - None. Subsequent getStoreScope calls consult the resolver first.
 *
 * WHY THIS DESIGN:
 * A single nullable function pointer costs one null check on the read path and nothing
 * at all until a host opts in - the browser bundle carries no async_hooks import and no
 * behavioural change.
 *
 * WHEN TO USE:
 * From a server host that runs user code across awaits (the @azerothjs/http request
 * root does this).
 *
 * WHEN NOT TO USE:
 * Application code. Client code. Anywhere a fresh scope per synchronous render is
 * enough - that is runInStoreScope's job.
 *
 * EDGE CASES:
 * - Installing twice replaces the previous resolver (last write wins).
 * - A resolver returning undefined defers to runInStoreScope's scope, then the default.
 *
 * PERFORMANCE NOTES:
 * O(1); adds one null check to getStoreScope when installed.
 *
 * DEVELOPER WARNING:
 * The resolver runs on EVERY store access - it must be cheap and must never throw.
 *
 * @param resolver - The async-context scope resolver, or null to uninstall.
 * @see {@link getStoreScope}
 */
export function setStoreScopeResolver(resolver: (() => object | undefined) | null): void
{
    scopeResolver = resolver;
}

/**
 * getStoreScope
 *
 * PURPOSE:
 * Returns the currently active store scope - the key createStore uses to cache (and
 * look up) its singleton instance.
 *
 * WHY IT EXISTS:
 * createStore must resolve "the instance for the current execution context" without
 * knowing whether it runs on the client (one global scope) or the server (one scope
 * per request). A single accessor hides that difference behind one stable key.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime; the SSR-isolation seam. Read by @azerothjs/store when caching instances.
 *
 * INPUT CONTRACT:
 * - None.
 *
 * OUTPUT CONTRACT:
 * - The active scope object: a stable reference suitable as a WeakMap key. Equal across
 *   calls within the same scope; different across runInStoreScope boundaries.
 *
 * WHY THIS DESIGN:
 * Returning an opaque object (rather than an id) lets the store cache hold instances in
 * a WeakMap, so a per-request scope's instances are collected automatically when the
 * scope is dropped - no manual cleanup, no cross-request leak.
 *
 * WHEN TO USE:
 * Inside a store implementation that caches a per-scope singleton.
 *
 * WHEN NOT TO USE:
 * In application code - apps use createStore, which calls this internally.
 *
 * EDGE CASES:
 * - Outside any runInStoreScope call it returns the default (client) scope.
 *
 * PERFORMANCE NOTES:
 * O(1): returns a module variable.
 *
 * DEVELOPER WARNING:
 * Do not retain the returned object past the current synchronous scope - on the server
 * a stale reference would key into a request's state that should have been collected.
 *
 * @returns The active store scope (a WeakMap-key object).
 * @see {@link runInStoreScope}
 * @example
 * getStoreScope() === getStoreScope(); // true (stable within a scope)
 */
export function getStoreScope(): object
{
    // Precedence: an EXPLICIT synchronous scope (a runInStoreScope frame - e.g. an SSR
    // render nested inside a request handler) always wins; the async-context resolver
    // covers everything between such frames; the default scope is the client fallback.
    if (currentScope !== DEFAULT_SCOPE)
    {
        return currentScope;
    }
    if (scopeResolver !== null)
    {
        const resolved = scopeResolver();
        if (resolved !== undefined)
        {
            return resolved;
        }
    }
    return currentScope;
}

/**
 * runInStoreScope
 *
 * PURPOSE:
 * Runs `fn` under a fresh store scope and restores the previous scope afterwards, so
 * stores created inside fn are isolated from those outside it.
 *
 * WHY IT EXISTS:
 * Module-level singleton stores are correct on the client but a cross-request hazard on
 * the server, where one process serves many users. Wrapping each render in a fresh
 * scope gives every request its own store instances without changing the client model.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime; SSR isolation boundary. @azerothjs/server's renderToString wraps each render
 * in it.
 *
 * INPUT CONTRACT:
 * - fn: synchronous work (a render). Stores created during fn key under the fresh scope.
 *
 * OUTPUT CONTRACT:
 * - Returns fn's return value. The previous scope is restored in a finally (even on
 *   throw).
 *
 * WHY THIS DESIGN:
 * Save/restore around a synchronous fn is what makes per-request isolation safe without
 * locks: an SSR render never yields the event loop mid-render, so two requests' scopes
 * cannot interleave.
 *
 * WHEN TO USE:
 * At an SSR render entry point that must isolate per-request store state.
 *
 * WHEN NOT TO USE:
 * On the client, where app-wide singletons are intended; a fresh scope there would give
 * each call its own store and break sharing.
 *
 * EDGE CASES:
 * - Nesting is supported; the inner call restores to the outer scope.
 * - fn MUST be synchronous for isolation to hold - awaiting inside it can let another
 *   render observe this scope.
 *
 * PERFORMANCE NOTES:
 * O(1) overhead: one assignment in, one restore out. The fresh scope and its cached
 * stores are GC'd after the call.
 *
 * DEVELOPER WARNING:
 * Do not run asynchronous work inside fn and expect isolation - the guarantee relies on
 * synchronous render.
 *
 * @typeParam T - fn's return type.
 * @param fn - The synchronous work to run under a fresh scope.
 * @returns Whatever `fn` returns.
 * @see {@link getStoreScope}
 * @example
 * const a = runInStoreScope(() => useCounter());
 * const b = runInStoreScope(() => useCounter());
 * a !== b; // true - each scope built its own instance
 */
export function runInStoreScope<T>(fn: () => T): T
{
    const previous = currentScope;
    currentScope = {};
    try
    {
        return fn();
    }
    finally
    {
        currentScope = previous;
    }
}
