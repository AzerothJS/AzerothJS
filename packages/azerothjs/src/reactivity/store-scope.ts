/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Store scopes isolate lazy-singleton store instances. createStore caches each instance
 * under the ACTIVE scope: on the client there is one stable scope for the whole JS context,
 * so a store is an app-wide singleton, while the server runs each render in its own scope
 * and concurrent requests never share state.
 *
 * The save/restore in {@link runInStoreScope} is sound only because an SSR render is
 * synchronous - one render's scope is set and restored before the event loop can start
 * another. Async execution breaks that model: after the first `await` the module variable
 * has already been restored and another request may have replaced it. A host that needs
 * isolation ACROSS awaits installs a {@link setStoreScopeResolver | scope resolver} backed
 * by its runtime's async-context primitive, which keeps this module dependency-free and
 * browser-portable.
 *
 * A scope is an opaque object used as a WeakMap key, so a per-render scope and everything
 * cached under it is collected once the render returns.
 */

/** Client stores are app-wide singletons cached under this for the JS context's life. */
const DEFAULT_SCOPE: object = {};

let currentScope: object = DEFAULT_SCOPE;

let scopeResolver: (() => object | undefined) | null = null;

/**
 * Installs the resolver {@link getStoreScope} consults before the synchronous scope, which
 * is the seam that makes store isolation survive `await`.
 *
 * Which async-context carrier to use is a host concern - AsyncLocalStorage on Node today,
 * TC39 AsyncContext eventually - so the host owns it and this module stays portable. The
 * cost until a host opts in is one null check; a browser bundle carries nothing.
 *
 * The resolver runs on EVERY store access, so it must be cheap and must not throw.
 * Installing twice replaces the previous one.
 *
 * @param resolver - Returns the active scope, or `undefined` to fall through to the
 *                   synchronous scope, so an SSR render nested inside a request still
 *                   isolates correctly. Pass `null` to uninstall.
 * @see {@link getStoreScope}
 */
export function setStoreScopeResolver(resolver: (() => object | undefined) | null): void
{
    scopeResolver = resolver;
}

/**
 * The active store scope: the key createStore caches its instance under, and an opaque
 * object suitable as a WeakMap key rather than an id, so a per-request scope's instances
 * are collected automatically when the scope is dropped.
 *
 * Stable across calls within one scope, different across {@link runInStoreScope}
 * boundaries, and the default client scope outside every such call. Do not retain the
 * returned object past the current synchronous scope - on the server a stale reference
 * keys into request state that should have been collected.
 *
 * @returns The active scope object.
 * @see {@link runInStoreScope}
 */
export function getStoreScope(): object
{
    // Precedence: an explicit synchronous scope - a runInStoreScope frame, such as an SSR
    // render nested inside a request handler - always wins; the async-context resolver covers
    // everything between such frames; the default scope is the client fallback.
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
 * Runs `fn` under a fresh store scope, restoring the previous one afterwards even if `fn`
 * throws, so stores built inside are isolated from those outside. This is the SSR boundary:
 * renderToString wraps every render in it, giving each request its own instances without
 * changing the client's singleton model.
 *
 * `fn` MUST be synchronous. The isolation guarantee rests entirely on a render never
 * yielding the event loop, so two requests' scopes cannot interleave; awaiting inside `fn`
 * lets another render observe this scope. Use {@link setStoreScopeResolver} when isolation
 * has to survive `await`.
 *
 * Nesting is supported - the inner call restores to the outer scope. The fresh scope and
 * its cached stores are collected after the call.
 *
 * @typeParam T - `fn`'s return type.
 * @param fn - Synchronous work, typically a render.
 * @returns Whatever `fn` returns.
 * @example
 * const a = runInStoreScope(() => useCounter());
 * const b = runInStoreScope(() => useCounter());
 * a !== b; // each scope built its own instance
 *
 * @see {@link getStoreScope}
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

/**
 * Runs `fn` under a specific existing scope: the streaming-continuation seam. A boundary
 * continuation must see the same store instances its main pass created, and an explicit
 * synchronous scope outranks the async-context resolver by getStoreScope's precedence.
 *
 * @internal
 * @param scope - Captured by the render's main pass.
 */
export function runInExistingStoreScope<T>(scope: object, fn: () => T): T
{
    const previous = currentScope;
    currentScope = scope;
    try
    {
        return fn();
    }
    finally
    {
        currentScope = previous;
    }
}
