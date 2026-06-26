/**
 * MODULE: store/create-store
 *
 * createStore wraps a factory in lazy-singleton + reactive-ownership behaviour. The factory returns
 * whatever shape you want (typically a bag of signals, memos, and methods); createStore guarantees:
 *   1. it runs at most once per store scope, on first use;
 *   2. internal createEffect/createMemo/onRootDispose calls get a real createRoot to live in
 *      (without one, the root-disposer machinery silently no-ops);
 *   3. every useStore() call within a scope returns the SAME instance - shared state across
 *      components without prop drilling.
 *
 * A store is just a function returning an object: no reducer protocol, no Proxy deep reactivity, no
 * this-binding magic. The reactive model is the existing one (signals/memos/effects) packaged in a
 * reusable surface, keeping stores type-safe (the return type IS the public API), composable (a
 * store can use other stores), and easy to debug.
 *
 * SSR ISOLATION: the cached instance is keyed by the active store scope (getStoreScope). On the
 * client there is one stable scope (a true app-wide singleton); the server runs each render in its
 * own scope (runInStoreScope), so concurrent requests get ISOLATED store state, GC'd when the
 * render scope ends. NOT lazy-disposable: the internal createRoot is owned for the scope's lifetime
 * (global state is meant to outlive any mount); for per-component/route state, call a factory
 * directly or use createRoot + manual dispose.
 */

import { createRoot, getStoreScope } from '@azerothjs/reactivity';

/**
 * createStore
 *
 * PURPOSE:
 * Wraps a factory into a useStore() that lazily builds and caches ONE instance per store scope,
 * inside an owned reactive root - giving shared, type-safe global state.
 *
 * WHY IT EXISTS:
 * Shared state needs lazy init, single-instance reuse, AND a reactive owner for its effects/memos -
 * without a createRoot, onRootDispose and the disposer machinery silently no-op. Hand-rolling the
 * singleton-plus-root is repetitive and easy to get wrong; createStore packages it.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, store; built on createRoot + getStoreScope. The instance is keyed per scope, which is
 * what makes the same code a client singleton AND per-request-isolated on the server.
 *
 * INPUT CONTRACT:
 * - factory: () => T; typically returns an object of signal getters, memo getters, and methods.
 *   Inside it, createSignal/createMemo/createEffect/onRootDispose all behave normally (it runs in a root).
 *
 * OUTPUT CONTRACT:
 * - A useStore() function returning the cached instance for the active scope (built on first call
 *   within that scope, the same object thereafter).
 *
 * WHY THIS DESIGN:
 * The instance is cached in a WeakMap keyed by the store scope, so the client (one stable scope)
 * gets an app-wide singleton while the server (a fresh scope per render) gets isolated instances
 * that are GC'd when the render ends. The factory runs in createRoot so its reactive nodes have an
 * owner; that root's dispose is intentionally dropped (global state outlives any mount). The `has`
 * check (not a truthy check) caches even a factory that returns null/undefined exactly once.
 *
 * WHEN TO USE:
 * For app-wide shared state (auth, theme, cart). Stores compose - one store's factory may call
 * another store's useStore().
 *
 * WHEN NOT TO USE:
 * For per-component or per-route state - the store's root is never disposed, so its effects would
 * live for the scope's whole lifetime. Call a factory directly, or use createRoot + manual dispose.
 *
 * EDGE CASES:
 * - A factory returning null/undefined is still cached exactly once.
 * - Under SSR, each runInStoreScope render gets its own instance (no cross-request leakage).
 *
 * PERFORMANCE NOTES:
 * The factory runs once per scope; every later useStore() is a WeakMap lookup.
 *
 * DEVELOPER WARNING:
 * The internal root is never disposed (by design, for globals) - do NOT use createStore for
 * ephemeral state, or its effects leak for the scope's lifetime.
 *
 * @typeParam T - The factory's return shape; also every useStore() result.
 * @param factory - Builds the store (typically signal/memo getters + methods).
 * @returns A useStore() returning the cached per-scope instance.
 * @see {@link createSignal}
 * @see {@link createRoot}
 * @example
 * const useCounter = createStore(() => {
 *   const [count, setCount] = createSignal(0);
 *   return { count, doubled: createMemo(() => count() * 2), inc: () => setCount(c => c + 1) };
 * });
 * useCounter().inc(); // shared instance, effects already owned
 */
export function createStore<T>(factory: () => T): () => T
{
    // Cached instance PER store scope. On the client there is one stable scope,
    // so this behaves as the original app-wide singleton; the server runs each
    // render in its own scope (runInStoreScope), so concurrent requests get
    // isolated instances. WeakMap keying lets a per-render scope's instance be
    // garbage-collected once that render ends.
    const instances = new WeakMap<object, T>();

    /**
     * Returns the cached store instance for the active scope, building it on the
     * first call within that scope.
     */
    return function useStore(): T
    {
        const scope = getStoreScope();

        if (!instances.has(scope))
        {
            // Run the factory inside a fresh createRoot so every effect, memo,
            // and onRootDispose registered inside has somewhere to attach. The
            // dispose is deliberately dropped: the instance lives as long as its
            // scope (the whole JS context on the client; until the render ends on
            // the server). `has` - not a truthy check - so a factory that returns
            // null/undefined still caches exactly once.
            createRoot(() =>
            {
                instances.set(scope, factory());
            });
        }

        return instances.get(scope) as T;
    };
}
