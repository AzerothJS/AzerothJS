/**
 * MODULE: renderer/ref
 *
 * A ref is the imperative escape hatch out of the declarative model: direct access to a DOM element
 * after it is created, for the tasks that genuinely need the live node - focusing an input, measuring
 * dimensions, drawing on a canvas, or attaching a third-party library (charts, maps).
 *
 * There are two forms, and the callback is the PRIMARY one:
 *
 *   1. Callback (preferred): `<input ref={el => el.focus()} />`. The element is handed to your function
 *      at creation. No import, fully typed from the element, ideal for fire-once access.
 *   2. Box (when you must read the element LATER): `const input = createRef<HTMLInputElement>();`
 *      `<input ref={input} />`; then `input.current?.focus()` inside an effect / after mount.
 *
 * WHY ref IS A RUNTIME HELPER, NOT A KEYWORD:
 * AzerothJS keywords (state/derived/effect/resource/store/selector/...) all declare REACTIVE constructs:
 * the compiler rewrites their reads/initializers and binds their lifecycle to the component's reactive
 * root. A ref does none of that - `current` is a plain read, there is no reactive initializer, no
 * dependency tracking, and nothing to dispose; it is assigned imperatively by h(). The only compiler
 * involvement is routing the `ref` prop off the reactive-attribute path (handled at the markup-binding
 * layer, alongside class/style/spread). So ref stays an ordinary runtime primitive + a `ref` prop -
 * keeping "keyword = reactive construct" true and the language smaller.
 */

/**
 * A ref object holding a reference to a DOM element.
 *
 * @typeParam T - The element type (defaults to HTMLElement).
 */
export interface Ref<T extends HTMLElement = HTMLElement>
{
    /** The referenced element; null until assigned by h() at creation. */
    current: T | null;
}

/**
 * createRef
 *
 * PURPOSE:
 * Creates a `{ current: null }` box that h() populates with the element when the ref is
 * passed via the `ref` prop, giving imperative access to that node.
 *
 * WHY IT EXISTS:
 * A no-VDOM framework wires the DOM declaratively, but some tasks are inherently imperative
 * (focus, measurement, canvas drawing, third-party widget mounting) and need the live node.
 * createRef is the typed escape hatch that hands it back without breaking the declarative flow.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, renderer. The `ref` prop is consumed by h()/applyProps (see applyRef in h.ts);
 * createRef just allocates the box the element is written into.
 *
 * INPUT CONTRACT:
 * - None.
 *
 * OUTPUT CONTRACT:
 * - Returns a {@link Ref} whose `current` is null until the element it is attached to is
 *   created, then the element thereafter.
 *
 * WHY THIS DESIGN:
 * A mutable box (rather than only a callback) lets you read `.current` later, at the moment
 * you need it; h() also accepts the callback form for fire-once access. Both avoid querying
 * the DOM by id/selector.
 *
 * WHEN TO USE:
 * For imperative access to a specific element: el.focus(), getBoundingClientRect(), canvas
 * contexts, attaching a non-AzerothJS library to a node.
 *
 * WHEN NOT TO USE:
 * For reactive content or attributes - bind those with getters/signals instead of reading a
 * ref and mutating by hand.
 *
 * EDGE CASES:
 * - current is null before the element is created; it is NOT auto-nulled when the element is
 *   later removed, so do not assume a stale ref still points at a live node.
 *
 * PERFORMANCE NOTES:
 * O(1): allocates one object.
 *
 * DEVELOPER WARNING:
 * Reading current during component setup (before the element exists) returns null - read it
 * in an effect or after mount. A ref is never rendered as an attribute.
 *
 * @typeParam T - The element type.
 * @returns A {@link Ref} with `current: null`.
 * @example
 * const inputRef = createRef<HTMLInputElement>();
 * h('input', { type: 'text', ref: inputRef });
 * // later: inputRef.current?.focus();
 */
export function createRef<T extends HTMLElement = HTMLElement>(): Ref<T>
{
    return { current: null };
}
