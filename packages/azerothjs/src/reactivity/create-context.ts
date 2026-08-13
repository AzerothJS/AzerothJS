/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Dependency injection over the owner tree. {@link provideContext} writes a value onto the
 * ACTIVE owner and {@link useContext} reads by walking the owner chain upward, so a value
 * provided in an outer scope reaches everything created inside it, an inner provide shadows
 * an outer one, and sibling scopes stay isolated. It is how theming, localization or a
 * router thread through a tree without module-level singletons, which leak across SSR
 * requests.
 *
 * Reads resolve at CALL time, against the owner chain active during setup, and are not
 * reactive. Provide a signal as the value when consumers must react to changes.
 */

import { getOwner, type Owner } from './create-root.ts';

/**
 * A typed context key created by {@link createContext}. Treat as opaque: pass it to
 * provideContext/useContext, nothing else.
 *
 * @typeParam T - The type of the value the context carries.
 */
export interface Context<T>
{
    /** @internal The owner-map key. */
    id: symbol;

    /** @internal Returned by useContext when no owner in the chain provided a value. */
    defaultValue: T | undefined;

    /** @internal The name given at creation (diagnostics only). */
    name: string | undefined;
}

/**
 * Creates a typed key that pairs {@link provideContext} writes with {@link useContext}
 * reads across the ownership tree. The key carries no value itself and can be shared
 * freely, including at module scope.
 *
 * @typeParam T - The value type this context carries.
 * @param defaultValue - Returned by useContext when no scope in the chain provided one.
 * @param name - Diagnostic name; appears in error messages.
 * @returns The context key.
 * @example
 * const Theme = createContext<'light' | 'dark'>('light', 'Theme');
 *
 * createRoot(() =>
 * {
 *     provideContext(Theme, 'dark');
 *     createRoot(() => useContext(Theme)); // 'dark', read from the outer scope
 * });
 *
 * @see {@link provideContext}
 * @see {@link useContext}
 */
export function createContext<T>(defaultValue?: T, name?: string): Context<T>
{
    return { id: Symbol(name ?? 'context'), defaultValue, name };
}

/**
 * Provides `value` for `context` on the ACTIVE owner. It is visible to useContext calls in
 * this scope and every scope created inside it, shadowed by a nearer provide, and freed
 * when the owner disposes.
 *
 * Only scopes created AFTER this call see the value, since resolution walks the owner chain
 * at read time.
 *
 * @typeParam T - The context's value type.
 * @param context - The key from {@link createContext}.
 * @param value - Stored as given, not copied.
 * @throws {Error} If called outside every ownership scope, where there is nothing to scope
 *                 the value to.
 * @see {@link useContext}
 */
export function provideContext<T>(context: Context<T>, value: T): void
{
    const owner = getOwner();
    if (owner === null)
    {
        throw new Error(
            `provideContext(${ context.name ?? 'context' }) called outside any ownership scope: ` +
            'there is nothing to scope the value to. Provide inside a component or createRoot().'
        );
    }
    (owner.context ??= new Map<symbol, unknown>()).set(context.id, value);
}

/**
 * Reads the nearest provided value for `context`, walking the active owner chain upward and
 * falling back to the context's default when no scope provided one.
 *
 * Resolution happens at CALL time, so call it during setup and capture the result. Calling
 * it later, from an async callback or a detached handler, resolves against whatever owner
 * is active then - usually none.
 *
 * @typeParam T - The context's value type.
 * @param context - The key from {@link createContext}.
 * @returns The nearest provided value, otherwise the default, which is `undefined` when the
 *          context was created without one.
 * @see {@link provideContext}
 */
export function useContext<T>(context: Context<T>): T | undefined
{
    let owner: Owner | null = getOwner();
    while (owner !== null)
    {
        const map = owner.context;
        if (map !== null && map.has(context.id))
        {
            return map.get(context.id) as T;
        }
        owner = owner.parent;
    }
    return context.defaultValue;
}
