// Internal storage for component destroy callbacks. INTERNAL to
// @azerothjs/component; not re-exported from the package index.
//
// Both component styles - function components (defineComponent) and class
// components (AzerothComponent) - stash their destroy callbacks directly on
// the rendered DOM element, so destroyComponent(el) can find and run them
// regardless of which style created the element. The keys are unique Symbols
// so they never collide with user-supplied props or markers from other
// packages.
//
// The two styles get separate keys because their hook contracts differ
// (function hooks may return cleanups; class hooks are plain () => void).
// Separate storage means neither style needs to know how the other works.
// This module is the single source of truth for both keys and provides typed
// helpers so call sites stay free of `any`.

import type { LifecycleHook } from './types.ts';

/**
 * Storage key for function-component destroy hooks.
 *
 * Set by `defineComponent()` after running its setup. Read by
 * `destroyComponent()` when tearing down a function component.
 *
 * @internal
 */
const FUNCTION_DESTROY = Symbol('azeroth_function_destroy');

/**
 * Storage key for class-component destroy hooks.
 *
 * Appended to by `AzerothComponent._init()` so that
 * `destroyComponent()` can call `instance.destroy()` when the
 * element is torn down.
 *
 * @internal
 */
const CLASS_DESTROY = Symbol('azeroth_class_destroy');

/**
 * A class destroy hook - always plain `() => void`. Class components track
 * effect disposers and `onDestroy` separately, so the only thing stored on
 * the element is a list of bound destroy callbacks.
 */
type ClassDestroyHook = () => void;

/**
 * The minimal shape needed to read or write a Symbol-keyed property on a DOM
 * element. Centralising the cast here keeps every call site free of `as any`.
 *
 * @internal
 */
interface SymbolStore { [key: symbol]: unknown }

/**
 * Reads a Symbol-keyed property from an element, returning
 * `undefined` if the key has never been set.
 *
 * @internal
 */
function readSymbol<T>(el: HTMLElement, key: symbol): T | undefined
{
    return (el as unknown as SymbolStore)[key] as T | undefined;
}

/**
 * Writes a Symbol-keyed property on an element.
 *
 * @internal
 */
function writeSymbol(el: HTMLElement, key: symbol, value: unknown): void
{
    (el as unknown as SymbolStore)[key] = value;
}

/**
 * Returns the function-component destroy hooks attached to an element, or
 * `undefined` if none have been registered.
 *
 * @param el - The component's root DOM element
 * @returns The hooks array, or `undefined` when the element is not a function
 *          component (or has already been torn down and reset to `[]`).
 *
 * @internal
 */
export function getFunctionDestroyHooks(el: HTMLElement): LifecycleHook[] | undefined
{
    return readSymbol<LifecycleHook[]>(el, FUNCTION_DESTROY);
}

/**
 * Attaches function-component destroy hooks to an element, replacing any
 * previously attached array. `defineComponent()` calls this once after its
 * setup runs; `destroyComponent()` calls it with `[]` after running the hooks
 * to mark the element as drained.
 *
 * @param el - The component's root DOM element
 * @param hooks - The hooks array to attach
 *
 * @internal
 */
export function setFunctionDestroyHooks(el: HTMLElement, hooks: LifecycleHook[]): void
{
    writeSymbol(el, FUNCTION_DESTROY, hooks);
}

/**
 * Returns the class-component destroy hooks attached to an element, or
 * `undefined` if none have been registered.
 *
 * @param el - The component's root DOM element
 * @returns The hooks array, or `undefined` when the element is not a class
 *          component (or has already been torn down and reset to `[]`).
 *
 * @internal
 */
export function getClassDestroyHooks(el: HTMLElement): ClassDestroyHook[] | undefined
{
    return readSymbol<ClassDestroyHook[]>(el, CLASS_DESTROY);
}

/**
 * Attaches class-component destroy hooks to an element.
 *
 * `AzerothComponent` appends a single bound `destroy()` callback during init,
 * but the storage is an array so future extensions (e.g. wrapper components
 * needing their own cleanup on the same element) can append to it.
 *
 * @param el - The component's root DOM element
 * @param hooks - The hooks array to attach
 *
 * @example
 * ```ts
 * const existing = getClassDestroyHooks(el) ?? [];
 * existing.push(() => instance.destroy());
 * setClassDestroyHooks(el, existing);
 * ```
 *
 * @internal
 */
export function setClassDestroyHooks(el: HTMLElement, hooks: ClassDestroyHook[]): void
{
    writeSymbol(el, CLASS_DESTROY, hooks);
}
