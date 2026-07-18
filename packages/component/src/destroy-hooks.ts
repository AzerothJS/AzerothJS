/**
 * MODULE: component/destroy-hooks (internal)
 *
 * Internal storage for element teardown hooks - INTERNAL to @azerothjs/component, not
 * re-exported from the package index. A teardown hook is stashed directly on the rendered DOM
 * element under a unique Symbol key, so destroyComponent(el) can find and run it regardless of
 * where the element ends up in the tree; the Symbol key never collides with user props or other
 * packages' markers.
 */

import type { DestroyHook } from './types.ts';

/**
 * Storage key for an element's teardown hooks. Read by destroyComponent().
 *
 * @internal
 */
const DESTROY_HOOKS = Symbol('azeroth_destroy_hooks');

/**
 * The minimal shape needed to read/write a Symbol-keyed property on a DOM element. Centralising
 * the cast here keeps call sites free of `as any`.
 *
 * @internal
 */
interface SymbolStore { [key: symbol]: unknown }

/**
 * Reads a Symbol-keyed property, or undefined if never set. Returns unknown - the
 * caller owns the one cast to the stored shape (a generic here would only disguise it).
 *
 * @internal
 * @param el - The element to read from.
 * @param key - The symbol key.
 * @returns The stored value, or undefined.
 */
function readSymbol(el: HTMLElement, key: symbol): unknown
{
    return (el as unknown as SymbolStore)[key];
}

/**
 * Writes a Symbol-keyed property on an element.
 *
 * @internal
 * @param el - The element to write to.
 * @param key - The symbol key.
 * @param value - The value to store.
 */
function writeSymbol(el: HTMLElement, key: symbol, value: unknown): void
{
    (el as unknown as SymbolStore)[key] = value;
}

/**
 * Number of elements currently holding a NON-EMPTY hook array. Most apps never attach a destroy
 * hook, and even in apps that do, most teardown paths remove hook-free subtrees - so
 * destroyComponent consults this count to skip the whole subtree walk when it cannot possibly
 * find anything. The count can only over-estimate (an element GC'd with hooks still attached is
 * never decremented), which merely re-enables the walk - never skips a real hook.
 *
 * @internal
 */
let liveHookElements = 0;

/**
 * True when at least one element in the page holds undrained destroy hooks - the gate for
 * destroyComponent's subtree walk.
 *
 * @internal
 */
export function hasAnyDestroyHooks(): boolean
{
    return liveHookElements > 0;
}

/**
 * Returns the teardown hooks attached to an element, or undefined if none were registered (or
 * they were already drained to []).
 *
 * @internal
 * @param el - The element to inspect.
 * @returns The hook array, or undefined.
 */
export function getDestroyHooks(el: HTMLElement): DestroyHook[] | undefined
{
    return readSymbol(el, DESTROY_HOOKS) as DestroyHook[] | undefined;
}

/**
 * Attaches teardown hooks to an element, replacing any previously attached array.
 * destroyComponent() calls this with [] after running the hooks to mark the element drained.
 *
 * @internal
 * @param el - The element to annotate.
 * @param hooks - The hook array to store (or [] to drain).
 */
export function setDestroyHooks(el: HTMLElement, hooks: DestroyHook[]): void
{
    const had = (readSymbol(el, DESTROY_HOOKS) as DestroyHook[] | undefined)?.length ?? 0;
    if (had === 0 && hooks.length > 0)
    {
        liveHookElements++;
    }
    else if (had > 0 && hooks.length === 0)
    {
        liveHookElements--;
    }
    writeSymbol(el, DESTROY_HOOKS, hooks);
}
