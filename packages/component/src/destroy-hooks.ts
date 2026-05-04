// ============================================================================
// AZEROTHJS — Destroy Hooks (Internal Lifecycle Storage)
// ============================================================================
//
// AzerothJS supports two component styles — function components
// (defineComponent) and class components (AzerothComponent). Both
// stash their destroy callbacks directly on the rendered DOM
// element so that `destroyComponent(el)` can find and run them
// regardless of which style created the element.
//
// We use unique Symbols as the storage keys so they never collide
// with user-supplied props or framework-internal markers from
// other packages.
//
// WHY TWO SEPARATE KEYS?
//
//   The two component styles have slightly different hook
//   contracts (function hooks may return cleanups, class hooks
//   are plain `() => void`). Keeping the storage separate means
//   neither style needs to know how the other works — they just
//   register their own hooks on a known key.
//
// WHY THIS FILE EXISTS?
//
//   Without it, every read/write goes through `(el as any)[KEY]`
//   and the symbol declarations are scattered across the package.
//   This module is the single source of truth for both keys and
//   provides typed helpers so call sites stay free of `any`.
//
// SCOPE:
//
//   Everything in this file is INTERNAL to @azerothjs/component.
//   It is NOT re-exported from the package index.
//
// ============================================================================

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
 * A class destroy hook — always plain `() => void`.
 *
 * Class components track effect disposers and `onDestroy`
 * separately, so the only thing stored on the element is a list
 * of bound destroy callbacks.
 */
type ClassDestroyHook = () => void;

/**
 * The minimal shape we need to read or write a Symbol-keyed
 * property on a DOM element. Centralising the cast in one
 * helper keeps every call site free of `as any`.
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
 * Returns the function-component destroy hooks attached to an
 * element, or `undefined` if none have been registered.
 *
 * @param el - The component's root DOM element
 *
 * @returns The hooks array, or `undefined` when the element is
 *          not a function component (or has already been torn
 *          down and reset to `[]`).
 *
 * @example
 * ```ts
 * const hooks = getFunctionDestroyHooks(el);
 * if (hooks)
 * {
 *     for (const hook of hooks) hook();
 * }
 * ```
 *
 * @internal
 */
export function getFunctionDestroyHooks(el: HTMLElement): LifecycleHook[] | undefined
{
    return readSymbol<LifecycleHook[]>(el, FUNCTION_DESTROY);
}

/**
 * Attaches function-component destroy hooks to an element.
 *
 * Replaces any previously attached array. `defineComponent()`
 * calls this exactly once after running its setup function;
 * `destroyComponent()` calls it with `[]` after running the
 * hooks to mark the element as drained.
 *
 * @param el - The component's root DOM element
 * @param hooks - The hooks array to attach
 *
 * @example
 * ```ts
 * setFunctionDestroyHooks(el, [() => clearInterval(id)]);
 * ```
 *
 * @internal
 */
export function setFunctionDestroyHooks(el: HTMLElement, hooks: LifecycleHook[]): void
{
    writeSymbol(el, FUNCTION_DESTROY, hooks);
}

/**
 * Returns the class-component destroy hooks attached to an
 * element, or `undefined` if none have been registered.
 *
 * @param el - The component's root DOM element
 *
 * @returns The hooks array, or `undefined` when the element is
 *          not a class component (or has already been torn down
 *          and reset to `[]`).
 *
 * @example
 * ```ts
 * const hooks = getClassDestroyHooks(el);
 * if (hooks)
 * {
 *     for (const hook of hooks) hook();
 * }
 * ```
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
 * `AzerothComponent` appends a single bound `destroy()`
 * callback during initialisation, but the storage is an array
 * so future extensions (e.g., wrapper components that need
 * their own cleanup on the same element) can append to it.
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
