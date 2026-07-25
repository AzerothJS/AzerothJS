/**
 * MODULE: reactivity/create-context
 *
 * Owner-tree dependency injection: a context is a typed key; {@link provideContext}
 * writes a value onto the ACTIVE owner, and {@link useContext} reads by walking the
 * owner chain upward - so a value provided in an outer scope is visible to everything
 * created inside it, an inner provide shadows an outer one, and sibling scopes are
 * isolated. This is the primitive that lets component libraries thread theming,
 * localization, or a router without module-level singletons (which leak across SSR
 * requests - the exact hazard scoped stores exist to patch for one package).
 *
 * Reads are CREATION-TIME: useContext resolves against the owner chain active when it
 * is called (component/root setup), not reactively. Provide a SIGNAL as the context
 * value when the consumers must react to changes.
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
 * Creates a context key.
 *
 * PURPOSE:
 * A typed identity that pairs {@link provideContext} writes with {@link useContext}
 * reads across the ownership tree.
 *
 * @typeParam T - The value type the context carries.
 * @param defaultValue - Returned by useContext when nothing provided the context.
 * @param name - Optional diagnostic name (appears in error messages).
 * @returns The context key.
 * @see {@link provideContext}
 * @see {@link useContext}
 * @example
 * const Theme = createContext<'light' | 'dark'>('light');
 * createRoot(() => {
 *     provideContext(Theme, 'dark');
 *     createRoot(() => useContext(Theme)); // 'dark' - read from the outer scope
 * });
 */
export function createContext<T>(defaultValue?: T, name?: string): Context<T>
{
    return { id: Symbol(name ?? 'context'), defaultValue, name };
}

/**
 * Provides `value` for `context` on the ACTIVE owner: visible to useContext calls in
 * this scope and every scope created inside it; shadowed by a nearer provide; freed
 * when the owner disposes. Requires an active owner - providing outside any root has
 * nowhere to scope the value to and throws.
 *
 * @typeParam T - The context's value type.
 * @param context - The key from {@link createContext}.
 * @param value - The value to provide.
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
 * Reads the nearest provided value for `context` by walking the active owner chain
 * upward; falls back to the context's default when no scope provided one. Resolution
 * happens at CALL time (setup), so capture the result - or provide a signal and read
 * that reactively.
 *
 * @typeParam T - The context's value type.
 * @param context - The key from {@link createContext}.
 * @returns The nearest provided value, else the default (undefined if none).
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
