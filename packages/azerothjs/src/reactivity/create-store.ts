/**
 * A store is a factory wrapped in lazy-singleton and reactive-ownership behaviour. There is
 * no reducer protocol, no Proxy deep reactivity and no this-binding: the factory returns a
 * plain object, usually of signal getters, memo getters and methods, so the return type IS
 * the public API and one store's factory can freely use another's.
 *
 * The instance is cached per store scope. On the client there is one stable scope, making a
 * store an app-wide singleton; the server runs each render in its own scope, so concurrent
 * requests get isolated state that is collected when the render ends.
 */

import { createRoot } from './create-root.ts';
import { getStoreScope } from './store-scope.ts';
import { dtEnterPrimitive, dtExitPrimitive } from './devtools.ts';

/** Options for {@link createStore}. */
export interface StoreOptions
{
    /** Debug name for devtools; groups the store's internal nodes under this label. */
    name?: string;
}

/**
 * Wraps `factory` into a `useStore()` that builds one instance per store scope, lazily, and
 * returns that same instance to every later caller in the scope.
 *
 * The factory runs inside a createRoot, so createSignal, createMemo, createEffect and
 * onRootDispose all behave normally within it. That root is never disposed, by design:
 * global state is meant to outlive any mount. The consequence is that createStore is the
 * wrong tool for per-component or per-route state, whose effects would then live as long as
 * the scope - call the factory directly, or use createRoot with a disposer you control.
 *
 * On the server each render runs in its own scope, so concurrent requests never share store
 * state and each instance is collected when its render ends.
 *
 * A factory returning null or undefined is still built exactly once; the cache records
 * presence, not truthiness.
 *
 * @typeParam T - The factory's return shape, and every `useStore()` result.
 * @param factory - Builds the store. Runs at most once per scope, on first use.
 * @param options - Optional settings.
 * @param options.name - Debug name for devtools.
 * @returns A `useStore()` returning the cached instance for the active scope.
 * @example
 * const useCounter = createStore(() =>
 * {
 *     const [count, setCount] = createSignal(0);
 *
 *     return {
 *         count,
 *         doubled: createMemo(() => count() * 2),
 *         increment: () => setCount(c => c + 1)
 *     };
 * });
 *
 * // Anywhere in the app, the same instance:
 * useCounter().increment();
 *
 * @see {@link createRoot} for state that must be disposable.
 */
export function createStore<T>(factory: () => T, options?: StoreOptions): () => T
{
    // WeakMap keying lets a per-render scope's instance be collected once that render ends.
    const instances = new WeakMap<object, T>();

    return function useStore(): T
    {
        const scope = getStoreScope();

        if (!instances.has(scope))
        {
            // The root's dispose is deliberately dropped: the instance lives as long as its
            // scope. `has` rather than a truthy check, so a factory returning null or undefined
            // still runs exactly once.
            const frame = dtEnterPrimitive('store', options?.name);
            createRoot(() =>
            {
                instances.set(scope, factory());
            });
            dtExitPrimitive(frame);
        }

        return instances.get(scope) as T;
    };
}
