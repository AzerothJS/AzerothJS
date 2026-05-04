// ============================================================================
// AZEROTHJS — createStore (Lazy Singleton Reactive Container)
// ============================================================================
//
// `createStore` wraps a factory function in lazy-singleton +
// reactive-ownership behaviour. The factory returns whatever
// shape you want — typically a bag of signals, memos, and
// methods — and `createStore` makes sure:
//
//   1. The factory is invoked AT MOST once, on first use
//   2. Internal `createEffect` / `createMemo` calls get a real
//      `createRoot` to live in (without one, `onRootDispose`
//      and the root-disposer machinery silently no-op)
//   3. Every `useStore()` call returns the same instance — true
//      cross-component shared state without prop drilling
//
// MINIMALIST BY DESIGN:
//
//   A store is just a function that returns an object. There is
//   no reducer protocol, no Proxy-based deep reactivity, no
//   `this`-binding magic for actions. The reactive model is the
//   one we already have — signals, memos, and effects — packaged
//   in a reusable surface.
//
//   This makes stores trivially type-safe (the return type IS
//   the public API), composable (a store can use other stores),
//   and obvious to debug (everything is just function calls).
//
// LIMITATIONS (documented; addressed later):
//
//   - NOT SSR-safe. Two concurrent requests share module scope,
//     so they would share store state. v1 is client-only. The
//     Phase 3 SSR work will add a per-request override layer.
//
//   - NOT lazy-disposable. The internal `createRoot` is owned
//     "forever" — its dispose function is intentionally
//     unreferenced, since global state's whole point is to
//     outlive any single mount. For per-component or per-route
//     state, just write a factory and call it directly without
//     `createStore` (or use `createRoot` + manual dispose).
//
// ============================================================================

import { createRoot } from '@azerothjs/reactivity';

/**
 * A sentinel that marks "factory has not run yet". A plain
 * `null`/`undefined` won't do — the user might legitimately want
 * a factory that returns null/undefined, and we need to tell
 * "uninitialized" from "intentionally nullish".
 *
 * @internal
 */
const UNINITIALIZED: unique symbol = Symbol('azeroth_store_uninitialized');

/**
 * Wraps a factory function in lazy-singleton + reactive-ownership
 * behaviour, returning a `useStore()` function.
 *
 * The factory is invoked the first time `useStore()` is called;
 * subsequent calls return the same instance. Inside the factory,
 * `createSignal`, `createMemo`, `createEffect`, and `onRootDispose`
 * all behave normally — they live inside a single internal
 * `createRoot` whose lifetime spans the whole JS context.
 *
 * @typeParam T - The shape returned by the factory; this is also
 *                the type of every `useStore()` call's result.
 *
 * @param factory - Builds the store. Typically returns an object
 *                  containing signal getters, memo getters, and
 *                  methods that mutate the signals.
 *
 * @returns A `useStore()` function that returns the (cached)
 *          store instance.
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
 * counter.count();           // → 0
 * counter.increment();
 * counter.count();           // → 1
 * counter.doubled();         // → 2
 * ```
 *
 * @example
 * ```ts
 * // A session store with a side-effect — every theme change is
 * // mirrored to the document body. The effect is registered
 * // inside the store's createRoot so it never disposes; that's
 * // the right behaviour for global state.
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
    // The cached instance, or the UNINITIALIZED sentinel before
    // first use. Captured in a closure shared by every call to
    // `useStore`, which is what gives us cross-call identity.
    let instance: T | typeof UNINITIALIZED = UNINITIALIZED;

    /**
     * Returns the cached store instance, building it on the first
     * call. Subsequent calls are a single closure read + a strict-
     * equality check against the sentinel — effectively free.
     */
    return function useStore(): T
    {
        if (instance === UNINITIALIZED)
        {
            // Run the factory inside a fresh createRoot so that
            // every effect / memo / onRootDispose registered
            // inside it has somewhere to attach. We deliberately
            // don't capture the dispose callback — global state's
            // contract is "lives until the JS context dies",
            // matching the lifetime of the module-level closure
            // that holds `instance`.
            createRoot(() =>
            {
                instance = factory();
            });
        }

        // The sentinel branch above always assigns `instance` to a
        // T value, so the cast here is sound. We can't narrow the
        // union without a runtime tag, hence the assertion.
        return instance as T;
    };
}
