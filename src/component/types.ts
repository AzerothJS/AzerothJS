// ============================================================================
// QUANTUM FRAMEWORK — Component Type Definitions
// ============================================================================
//
// Components are reusable pieces of UI that accept props (input data)
// and return an HTMLElement. They can have lifecycle hooks for setup
// and teardown.
//
// ARCHITECTURE:
//
//   defineComponent((props) =>
//   {
//       // Reactive state (signals)
//       // Lifecycle hooks (onMount, onDestroy)
//       // Return DOM element (using h())
//   })
//
// HOW COMPONENTS DIFFER FROM PLAIN FUNCTIONS:
//
//   Plain function:
//     function Counter() { return h('div', {}, ...); }
//     Counter();  // Just calls the function
//     No lifecycle. No formal props. No cleanup tracking.
//
//   Component:
//     const Counter = defineComponent((props) =>
//     {
//         onMount(() => console.log('visible!'));
//         onDestroy(() => console.log('removed!'));
//         return h('div', {}, ...);
//     });

//     Counter({ initialCount: 0 });  // Type-safe props!
//
// ============================================================================

/**
 * A component setup function that receives props and returns a DOM element.
 *
 * This function is called ONCE when the component is created.
 * Inside it, you can:
 *   - Create reactive state (signals, memos)
 *   - Register lifecycle hooks (onMount, onDestroy)
 *   - Set up effects that track signals
 *   - Build and return the component's DOM tree
 *
 * @typeParam P - The type of props this component accepts.
 *               Use an interface or type to define the props shape.
 *
 * @example
 * ```ts
 * interface CounterProps
 * {
 *     initialCount: number;
 *     label?: string;
 * }
 *
 * const setup: ComponentSetup<CounterProps> = (props) =>
 * {
 *     const [count, setCount] = createSignal(props.initialCount);
 *     onMount(() => console.log('Counter mounted!'));
 *
 *     return h('div', {},
 *       h('span', {}, props.label ?? 'Count'),
 *       h('span', {}, () => `${count()}`),
 *     );
 * };
 * ```
 *
 * @see {@link defineComponent} — Wraps a setup function into a component
 */
export type ComponentSetup<P extends object = object> = (props: P) => HTMLElement;

/**
 * A component function that accepts props and returns a DOM element.
 *
 * This is what {@link defineComponent} returns. It looks like a regular
 * function but has lifecycle management built in.
 *
 * @typeParam P - The type of props this component accepts
 *
 * @example
 * ```ts
 * const Counter: Component<CounterProps> = defineComponent((props) =>
 * {
 *     // ...setup code...
 *     return h('div', {}, ...);
 * });
 *
 * // Use it:
 * const el = Counter({ initialCount: 0 });
 * document.body.appendChild(el);
 * ```
 *
 * @see {@link defineComponent} — Creates a Component from a setup function
 */
export type Component<P extends object = object> = (props: P) => HTMLElement;

/**
 * A lifecycle hook function.
 *
 * Called at specific points in a component's lifecycle:
 *   - onMount: called after the component's DOM is created
 *   - onDestroy: called when the component is being removed
 *
 * Can optionally return a cleanup function (for onMount only).
 *
 * @example
 * ```ts
 * // onMount with cleanup
 * onMount(() =>
 * {
 *     const id = setInterval(() => console.log('tick'), 1000);
 *     return () => clearInterval(id);  // cleanup when destroyed
 * });
 *
 * // onDestroy (no cleanup needed)
 * onDestroy(() =>
 * {
 *     console.log('Component removed from DOM');
 * });
 * ```
 *
 * @see {@link onMount} — Register a mount callback
 * @see {@link onDestroy} — Register a destroy callback
 */
export type LifecycleHook = () => void | (() => void);
