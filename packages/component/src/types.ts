// Types describing function components created with defineComponent().

/**
 * A component factory function.
 *
 * Created by defineComponent(). Call it with props to create a new instance
 * and get back the root HTMLElement.
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
 * Receives props, creates reactive state, registers lifecycle hooks, and
 * returns a DOM element.
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
 * A lifecycle hook function. May optionally return a cleanup function.
 * For onMount the returned cleanup runs on destroy; onDestroy ignores any
 * return value.
 *
 * @example
 * ```ts
 * onMount(() =>
 * {
 *     const id = setInterval(() => tick(), 1000);
 *     return () => clearInterval(id); // runs on destroy
 * });
 *
 * onDestroy(() => console.log('Component destroyed'));
 * ```
 */
export type LifecycleHook = () => void | (() => void);
