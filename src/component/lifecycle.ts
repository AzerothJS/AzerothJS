// ============================================================================
// QUANTUM FRAMEWORK — Component Lifecycle
// ============================================================================
//
// Lifecycle hooks let components run code at specific moments:
//   - onMount: after the component's DOM element is created
//   - onDestroy: when the component is being removed/cleaned up
//
// HOW IT WORKS:
//
//   Components register lifecycle hooks during their setup function.
//   We use a module-level variable (similar to currentEffect in signals)
//   to track which component is currently being set up.
//
//   1. defineComponent starts setting up a component
//   2. Sets currentLifecycle = this component's hook lists
//   3. Setup function runs — calls to onMount/onDestroy push to the lists
//   4. defineComponent clears currentLifecycle
//   5. After setup, defineComponent calls all onMount hooks
//
// VISUAL FLOW:
//
//   defineComponent((props) =>
//   {
//       // currentLifecycle is SET by defineComponent
//
//       onMount(() => { ... });    // pushes to currentLifecycle.mount
//       onDestroy(() => { ... });  // pushes to currentLifecycle.destroy
//
//       return h('div', {}, ...);
//       // currentLifecycle is CLEARED by defineComponent
//   });
//   // defineComponent calls all mount hooks
//
// ============================================================================

import type { LifecycleHook } from './types.ts';

/**
 * Internal storage for the lifecycle hooks of the component
 * currently being set up.
 *
 * - `null` when no component is being created
 * - Set to an object with mount/destroy arrays during setup
 *
 * @internal Managed by defineComponent, read by onMount/onDestroy
 */
let currentLifecycle: { mount: LifecycleHook[]; destroy: (() => void)[]; } | null = null;

/**
 * Gets the current lifecycle context.
 *
 * Used by defineComponent to access the collected hooks
 * after the setup function finishes.
 *
 * @internal
 * @returns The current lifecycle context, or null if no component is being set up
 */
export function getCurrentLifecycle()
{
    return currentLifecycle;
}

/**
 * Sets the current lifecycle context.
 *
 * Called by defineComponent before running the setup function
 * to establish the context, and after to clear it.
 *
 * @internal
 * @param lifecycle - The lifecycle context to set, or null to clear
 */
export function setCurrentLifecycle(lifecycle: typeof currentLifecycle): void
{
    currentLifecycle = lifecycle;
}

/**
 * Registers a callback to run after the component is created.
 *
 * The callback runs synchronously after the setup function returns
 * and the component's DOM element is fully constructed.
 *
 * If the callback returns a function, that function will be called
 * when the component is destroyed — this is a convenient way to
 * set up and tear down resources in one place.
 *
 * Must be called inside a component's setup function (inside defineComponent).
 * Calling it outside will throw an error.
 *
 * @param hook - The function to run on mount. Can optionally return
 *               a cleanup function that runs on destroy.
 *
 * @throws Error if called outside of a component setup function
 *
 * @example
 * ```ts
 * const Timer = defineComponent(() =>
 * {
 *     const [seconds, setSeconds] = createSignal(0);
 *
 *     // Start a timer when component mounts
 *     // Stop it when component is destroyed
 *     onMount(() =>
 *     {
 *         const id = setInterval(() =>
 *         {
 *             setSeconds(prev => prev + 1);
 *         }, 1000);
 *
 *         return () => clearInterval(id);  // cleanup on destroy
 *     });
 *
 *   return h('p', {}, () => `${seconds()} seconds`);
 * });
 * ```
 *
 * @example
 * ```ts
 * // Simple mount without cleanup
 * onMount(() =>
 * {
 *     console.log('Component is now visible on screen!');
 * });
 * ```
 */
export function onMount(hook: LifecycleHook): void
{
    if (!currentLifecycle)
    {
        throw new Error('onMount() can only be called inside a component setup function (defineComponent).');
    }

    currentLifecycle.mount.push(hook);
}

/**
 * Registers a callback to run when the component is destroyed.
 *
 * Use this for cleanup that isn't tied to a specific onMount:
 * closing connections, removing global listeners, logging, etc.
 *
 * Must be called inside a component's setup function (inside defineComponent).
 * Calling it outside will throw an error.
 *
 * @param hook - The function to run on destroy
 *
 * @throws Error if called outside of a component setup function
 *
 * @example
 * ```ts
 * const ChatRoom = defineComponent((props) =>
 * {
 *     const connection = connectToRoom(props.roomId);
 *
 *     onDestroy(() =>
 *     {
 *       connection.close();
 *       console.log('Disconnected from chat room');
 *     });
 *
 *     return h('div', {}, 'Chat room');
 * });
 * ```
 */
export function onDestroy(hook: () => void): void
{
    if (!currentLifecycle)
    {
        throw new Error('onDestroy() can only be called inside a component setup function (defineComponent).');
    }

    currentLifecycle.destroy.push(hook);
}
