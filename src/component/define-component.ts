// ============================================================================
// QUANTUM FRAMEWORK — defineComponent
// ============================================================================
//
// defineComponent wraps a setup function into a proper component
// with lifecycle management. It handles:
//   1. Setting up the lifecycle context (so onMount/onDestroy work)
//   2. Running the setup function to get the DOM element
//   3. Calling onMount hooks after creation
//   4. Storing onDestroy hooks for later cleanup
//
// USAGE:
//
//   const Counter = defineComponent<{ initial: number }>((props) =>
//   {
//       const [count, setCount] = createSignal(props.initial);
//       onMount(() => console.log('mounted!'));
//       return h('div', {}, () => `${count()}`);
//   });
//
//   const el = Counter({ initial: 0 });
//   document.body.appendChild(el);
//
// ============================================================================

import type { Component, ComponentSetup } from './types.ts';
import { setCurrentLifecycle } from './lifecycle.ts';

/**
 * Creates a reusable component with lifecycle management.
 *
 * Wraps a setup function that:
 *   1. Receives typed props
 *   2. Can register lifecycle hooks (onMount, onDestroy)
 *   3. Returns an HTMLElement
 *
 * The setup function runs ONCE per component instance. Reactive
 * state (signals, effects) created inside persists for the
 * lifetime of the component.
 *
 * @typeParam P - The props interface for this component.
 *               Defines what data the component accepts.
 *
 * @param setup - The component's setup function. Receives props,
 *                can register lifecycle hooks, and must return
 *                an HTMLElement (typically built with h()).
 *
 * @returns A {@link Component} function that accepts props and
 *          returns an HTMLElement with lifecycle hooks active.
 *
 * @example
 * ```ts
 * // Define a component with typed props
 * interface CardProps
 * {
 *     title: string;
 *     description: string;
 * }
 *
 * const Card = defineComponent<CardProps>((props) =>
 * {
 *     return h('div', { class: 'card' },
 *       h('h2', {}, props.title),
 *       h('p', {}, props.description),
 *     );
 * });
 *
 * // Use it
 * const el = Card({ title: 'Hello', description: 'World' });
 * ```
 *
 * @example
 * ```ts
 * // Component with state, lifecycle, and reactivity
 * const Timer = defineComponent(() =>
 * {
 *     const [seconds, setSeconds] = createSignal(0);
 *
 *     onMount(() =>
 *     {
 *         console.log('Timer started!');
 *         const id = setInterval(() =>
 *         {
 *             setSeconds(prev => prev + 1);
 *         }, 1000);
 *
 *         return () => clearInterval(id);  // cleanup on destroy
 *     });
 *
 *     onDestroy(() =>
 *     {
 *         console.log('Timer destroyed!');
 *     });
 *
 *     return h('p', {}, () => `${seconds()}s`);
 * });
 *
 * const el = Timer({});
 * ```
 *
 * @example
 * ```ts
 * // Component with no props
 * const Header = defineComponent(() =>
 * {
 *     return h('header', {},
 *       h('h1', {}, '⚛️ Quantum'),
 *     );
 * });
 *
 * const el = Header({});
 * ```
 */
export function defineComponent<P extends object = object>(setup: ComponentSetup<P>): Component<P>
{
    return (props: P): HTMLElement => {

        const lifecycle =
        {
            mount: [] as (() => void | (() => void))[],
            destroy: [] as (() => void)[],
        };

        setCurrentLifecycle(lifecycle);

        let el: HTMLElement;

        try
        {
            el = setup(props);
        }
        finally
        {
            setCurrentLifecycle(null);
        }

        for (const mountHook of lifecycle.mount)
        {
            const cleanup = mountHook();

            if (typeof cleanup === 'function')
            {
                lifecycle.destroy.push(cleanup);
            }
        }

        if (lifecycle.destroy.length > 0)
        {
            (el as unknown as { __quantum_destroy: (() => void)[] }).__quantum_destroy = lifecycle.destroy;
        }

        return el;
    };
}

/**
 * Destroys a component, running all its registered onDestroy hooks.
 *
 * Call this when removing a component's element from the DOM to
 * ensure proper cleanup of timers, subscriptions, event listeners, etc.
 *
 * @param el - The HTMLElement returned by a component function
 *
 * @example
 * ```ts
 * const el = Timer({});
 * container.appendChild(el);
 *
 * // Later, when removing:
 * destroyComponent(el);
 * container.removeChild(el);
 * ```
 */
export function destroyComponent(el: HTMLElement): void
{
    const destroyHooks = (el as unknown as { __quantum_destroy?: (() => void)[] }).__quantum_destroy;

    if (destroyHooks)
    {
        for (const hook of destroyHooks)
        {
            hook();
        }

        delete (el as unknown as { __quantum_destroy?: (() => void)[] }).__quantum_destroy;
    }
}
