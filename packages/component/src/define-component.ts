// ============================================================================
// AZEROTHJS — defineComponent (Function Components)
// ============================================================================
//
// defineComponent() creates reusable function components with
// props and lifecycle hooks.
//
// HOW IT WORKS:
//
//   1. defineComponent(setup) returns a factory function
//   2. Calling factory(props) runs the setup function
//   3. During setup, onMount/onDestroy hooks are collected
//   4. Setup returns an HTMLElement
//   5. Mount hooks run immediately after setup
//   6. Destroy hooks run when destroyComponent(element) is called
//
// HOOK COLLECTION:
//
//   onMount() and onDestroy() use module-level variables to
//   collect hooks. This is the same pattern React, Solid, and
//   Vue use internally.
//
// DESTROY INTEGRATION:
//
//   destroyComponent() works with BOTH function and class
//   components by dispatching through the typed helpers in
//   destroy-hooks.ts:
//     getFunctionDestroyHooks() → function component hooks
//     getClassDestroyHooks()    → class component hooks
//
// ============================================================================

import type { Component, ComponentSetup, LifecycleHook } from './types.ts';
import {
    getFunctionDestroyHooks,
    setFunctionDestroyHooks,
    getClassDestroyHooks,
    setClassDestroyHooks
} from './destroy-hooks.ts';

/**
 * Stack of mount hooks for the currently constructing component.
 *
 * Set to an array before setup runs, cleared after.
 * onMount() pushes to this array during setup.
 *
 * @internal
 */
let currentMountHooks: LifecycleHook[] | null = null;

/**
 * Stack of destroy hooks for the currently constructing component.
 *
 * Set to an array before setup runs, cleared after.
 * onDestroy() pushes to this array during setup.
 *
 * @internal
 */
let currentDestroyHooks: LifecycleHook[] | null = null;

/**
 * Registers a callback to run after the component mounts.
 *
 * Must be called inside a defineComponent() setup function.
 * Runs immediately after setup completes.
 *
 * Can return a cleanup function that will be added to the
 * destroy hooks automatically.
 *
 * @param hook - Function to run on mount. Can return cleanup.
 *
 * @example
 * ```ts
 * const Timer = defineComponent(() =>
 * {
 *     const [seconds, setSeconds] = createSignal(0);
 *
 *     onMount(() =>
 *     {
 *         const id = setInterval(() => setSeconds(s => s + 1), 1000);
 *         return () => clearInterval(id);  // cleanup on destroy
 *     });
 *
 *     return h('p', {}, () => `${ seconds() }s`);
 * });
 * ```
 */
export function onMount(hook: LifecycleHook): void
{
    if (currentMountHooks)
    {
        currentMountHooks.push(hook);
    }
}

/**
 * Registers a callback to run when the component is destroyed.
 *
 * Must be called inside a defineComponent() setup function.
 * Runs when destroyComponent(element) is called.
 *
 * @param hook - Function to run on destroy
 *
 * @example
 * ```ts
 * const Listener = defineComponent(() =>
 * {
 *     const handler = () => console.log('resized');
 *
 *     onMount(() => window.addEventListener('resize', handler));
 *     onDestroy(() => window.removeEventListener('resize', handler));
 *
 *     return h('div', {}, 'Listening...');
 * });
 * ```
 */
export function onDestroy(hook: LifecycleHook): void
{
    if (currentDestroyHooks)
    {
        currentDestroyHooks.push(hook);
    }
}

/**
 * Creates a reusable function component with props and lifecycle.
 *
 * @typeParam P - The type of props this component accepts
 * @param setup - Setup function that builds the component
 *
 * @returns A component factory function: (props) => HTMLElement
 *
 * @example
 * ```ts
 * // Basic component
 * const Hello = defineComponent<{ name: string }>((props) =>
 * {
 *     return h('p', {}, `Hello, ${ props.name }!`);
 * });
 *
 * const el = Hello({ name: 'World' });
 * ```
 *
 * @example
 * ```ts
 * // Component with interface props
 * interface CounterProps
 * {
 *     initial: number;
 * }
 *
 * const Counter = defineComponent<CounterProps>((props) =>
 * {
 *     const [count, setCount] = createSignal(props.initial);
 *
 *     onMount(() => console.log('Mounted!'));
 *     onDestroy(() => console.log('Destroyed!'));
 *
 *     return h('div', {},
 *       h('span', {}, () => `${ count() }`),
 *       h('button', { onClick: () => setCount(p => p + 1) }, '+')
 *     );
 * });
 *
 * const el = Counter({ initial: 0 });
 * destroyComponent(el);  // Logs: "Destroyed!"
 * ```
 */
export function defineComponent<P extends object = Record<string, unknown>>(setup: ComponentSetup<P>): Component<P>
{
    return (props: P): HTMLElement =>
    {
        const mountHooks: LifecycleHook[] = [];
        const destroyHooks: LifecycleHook[] = [];

        // Set module-level variables so onMount/onDestroy
        // know where to push their callbacks
        currentMountHooks = mountHooks;
        currentDestroyHooks = destroyHooks;

        // Run setup — creates state, registers hooks, returns element
        const element = setup(props);

        // Clear hook collection context
        currentMountHooks = null;
        currentDestroyHooks = null;

        // Store destroy hooks on the element so destroyComponent()
        // can find them later, regardless of where the element ends
        // up in the tree.
        setFunctionDestroyHooks(element, destroyHooks);

        // Run mount hooks
        // If a mount hook returns cleanup, add to destroy hooks
        for (const hook of mountHooks)
        {
            const cleanup = hook();
            if (typeof cleanup === 'function')
            {
                destroyHooks.push(cleanup);
            }
        }

        return element;
    };
}

/**
 * Destroys a component, running all its destroy hooks.
 *
 * Works with BOTH component styles:
 *   - Function components (defineComponent)
 *   - Class components (AzerothComponent)
 *
 * Safe to call on non-component elements (does nothing).
 * Safe to call multiple times (hooks cleared after first run).
 *
 * @param element - The component's root DOM element
 *
 * @example
 * ```ts
 * // Function component
 * const el = Counter({ initial: 0 });
 * destroyComponent(el);
 *
 * // Class component
 * const counter = new Counter({ initial: 0 });
 * destroyComponent(counter.element);
 * ```
 */
export function destroyComponent(element: HTMLElement): void
{
    // Function-component hooks (registered via onMount/onDestroy).
    // We drain in-place by reading once and overwriting with [] so a
    // second destroyComponent() call on the same element is a no-op.
    const fnHooks = getFunctionDestroyHooks(element);
    if (fnHooks && fnHooks.length > 0)
    {
        setFunctionDestroyHooks(element, []);

        for (const hook of fnHooks)
        {
            hook();
        }
    }

    // Class-component hooks (registered by AzerothComponent._init).
    // Same drain-then-run pattern so a class component's onDestroy
    // can safely call destroyComponent() on its own element without
    // recursing.
    const classHooks = getClassDestroyHooks(element);
    if (classHooks && classHooks.length > 0)
    {
        setClassDestroyHooks(element, []);

        for (const hook of classHooks)
        {
            hook();
        }
    }
}
