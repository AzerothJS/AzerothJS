// createStore wraps a factory in lazy-singleton + reactive-ownership behaviour.
// The factory returns whatever shape you want (typically a bag of signals,
// memos, and methods) and createStore guarantees:
//
//   1. The factory runs at most once, on first use.
//   2. Internal createEffect/createMemo calls get a real createRoot to live in
//      (without one, onRootDispose and the root-disposer machinery silently
//      no-op).
//   3. Every useStore() call returns the same instance - shared state across
//      components without prop drilling.
//
// A store is just a function that returns an object: no reducer protocol, no
// Proxy-based deep reactivity, no this-binding magic for actions. The reactive
// model is the one we already have (signals, memos, effects), packaged in a
// reusable surface. That keeps stores type-safe (the return type is the public
// API), composable (a store can use other stores), and easy to debug.
//
// Two known limitations:
//
//   - Not SSR-safe. Concurrent requests share module scope, so they would share
//     store state. This is client-only; per-request isolation comes with the
//     Phase 3 SSR work.
//   - Not lazy-disposable. The internal createRoot is owned forever - its
//     dispose function is intentionally unreferenced, since global state is
//     meant to outlive any single mount. For per-component or per-route state,
//     call a factory directly without createStore, or use createRoot plus
//     manual dispose.

import { createRoot } from '@azerothjs/reactivity';

/**
 * A sentinel that marks "factory has not run yet". A plain null/undefined
 * won't do: a factory may legitimately return null/undefined, so we need to
 * distinguish "uninitialized" from "intentionally nullish".
 *
 * @internal
 */
const UNINITIALIZED: unique symbol = Symbol('azeroth_store_uninitialized');

/**
 * Wraps a factory in lazy-singleton + reactive-ownership behaviour, returning
 * a `useStore()` function.
 *
 * The factory runs the first time `useStore()` is called; subsequent calls
 * return the same instance. Inside the factory, `createSignal`, `createMemo`,
 * `createEffect`, and `onRootDispose` all behave normally - they live inside a
 * single internal `createRoot` whose lifetime spans the whole JS context.
 *
 * @typeParam T - The shape returned by the factory; also the type of every
 *                `useStore()` result.
 * @param factory - Builds the store. Typically returns an object of signal
 *                  getters, memo getters, and methods that mutate the signals.
 * @returns A `useStore()` function that returns the cached store instance.
 *
 * Why: a shared store needs lazy init, single-instance reuse, and a reactive
 * owner for its effects/memos.
 *
 * Without createStore: build the singleton by hand and remember the root, or the
 * reactive ownership machinery silently no-ops:
 *
 *     let instance;
 *     function useCounter()
 *     {
 *         if (!instance)
 *         {
 *             createRoot(() =>
 *             {
 *                 const [c, setC] = createSignal(0);
 *                 instance = { c, inc: () => setC(n => n + 1) };
 *             });
 *         }
 *         return instance; // miss the root and onRootDispose just no-ops
 *     }
 *
 * With createStore: the returned useStore() runs the factory lazily in an owned
 * root and hands back the same instance to every caller:
 *
 *     const useCounter = createStore(() =>
 *     {
 *         const [c, setC] = createSignal(0);
 *         return { c, inc: () => setC(n => n + 1) };
 *     });
 *     useCounter().inc(); // one shared instance, effects already owned
 *
 * @example
 * ```ts
 * // A simple counter store.
 * const useCounter = createStore(() =>
 * {
 *     const [count, setCount] = createSignal(0);
 *     const doubled = createMemo(() => count() * 2);
 *
 *     return {
 *         count,
 *         doubled,
 *         increment: () => setCount(c => c + 1),
 *         reset: () => setCount(0)
 *     };
 * });
 *
 * // Anywhere in the app:
 * const counter = useCounter();
 * counter.count();           // 0
 * counter.increment();
 * counter.count();           // 1
 * counter.doubled();         // 2
 * ```
 *
 * @example
 * ```ts
 * // A session store with a side effect: every theme change is mirrored to
 * // the document body. The effect lives inside the store's createRoot so it
 * // never disposes - the right behaviour for global state.
 * const useSession = createStore(() =>
 * {
 *     const [theme, setTheme] = createSignal<'light' | 'dark'>('dark');
 *
 *     createEffect(() =>
 *     {
 *         document.body.dataset.theme = theme();
 *     });
 *
 *     return {
 *         theme,
 *         toggleTheme: () => setTheme(t => t === 'light' ? 'dark' : 'light')
 *     };
 * });
 * ```
 *
 * @example
 * ```ts
 * // Stores can compose. The auth store uses the session store.
 * const useAuth = createStore(() =>
 * {
 *     const session = useSession();
 *     const [user, setUser] = createSignal<User | null>(null);
 *
 *     return {
 *         user,
 *         theme: session.theme,
 *         signIn: (u: User) => setUser(u),
 *         signOut: () => setUser(null)
 *     };
 * });
 * ```
 */
export function createStore<T>(factory: () => T): () => T
{
    // The cached instance, or the UNINITIALIZED sentinel before first use.
    // Captured in a closure shared by every useStore call, which is what gives
    // cross-call identity.
    let instance: T | typeof UNINITIALIZED = UNINITIALIZED;

    /**
     * Returns the cached store instance, building it on the first call.
     * Subsequent calls are a closure read plus a sentinel check - effectively
     * free.
     */
    return function useStore(): T
    {
        if (instance === UNINITIALIZED)
        {
            // Run the factory inside a fresh createRoot so every effect, memo,
            // and onRootDispose registered inside has somewhere to attach. The
            // dispose callback is deliberately dropped: global state lives
            // until the JS context dies, matching the module-level closure
            // that holds `instance`.
            createRoot(() =>
            {
                instance = factory();
            });
        }

        // The branch above always assigns a T, so the cast is sound; the union
        // can't be narrowed without a runtime tag, hence the assertion.
        return instance as T;
    };
}
