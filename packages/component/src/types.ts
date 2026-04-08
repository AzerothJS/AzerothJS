// ============================================================================
// AZEROTHJS — Component Type Definitions
// ============================================================================
//
// These types define the structure of function components
// created with defineComponent().
//
// ============================================================================

/**
 * A component factory function.
 *
 * Created by defineComponent(). Call it with props to create
 * a new instance and get back the root HTMLElement.
 *
 * @typeParam P - The type of props this component accepts
 *
 * @example
 * ```ts
 * const Button: Component<{ label: string }> = defineComponent((props) =>
 * {
 *     return h('button', {}, props.label);
 * });
 *
 * const el = Button({ label: 'Click me' });
 * ```
 */
export type Component<P extends object = Record<string, unknown>> = (props: P) => HTMLElement;

/**
 * The setup function passed to defineComponent().
 *
 * Receives props, creates reactive state, registers lifecycle
 * hooks, and returns a DOM element.
 *
 * @typeParam P - The type of props this component accepts
 *
 * @example
 * ```ts
 * const setup: ComponentSetup<{ name: string }> = (props) =>
 * {
 *     const [count, setCount] = createSignal(0);
 *     onMount(() => console.log('mounted'));
 *     return h('div', {}, `Hello ${ props.name }`);
 * };
 * ```
 */
export type ComponentSetup<P extends object = Record<string, unknown>> = (props: P) => HTMLElement;

/**
 * A lifecycle hook function.
 *
 * Can optionally return a cleanup function.
 * For onMount: the cleanup runs on destroy.
 * For onDestroy: no cleanup return is used.
 *
 * @example
 * ```ts
 * // onMount with cleanup
 * onMount(() =>
 * {
 *     const id = setInterval(() => tick(), 1000);
 *     return () => clearInterval(id);  // cleanup
 * });
 *
 * // onDestroy (no cleanup return)
 * onDestroy(() =>
 * {
 *     console.log('Component destroyed');
 * });
 * ```
 */
export type LifecycleHook = () => void | (() => void);
