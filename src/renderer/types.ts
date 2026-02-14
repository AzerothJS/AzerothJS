// ============================================================================
// QUANTUM FRAMEWORK — Renderer Type Definitions
// ============================================================================
//
// These types support Quantum's DIRECT DOM rendering approach.
//
// IMPORTANT: Quantum does NOT use a Virtual DOM.
//
//   Virtual DOM (React, Vue):
//     1. Create a JavaScript object describing the element
//     2. Create another JavaScript object on next update
//     3. Diff the two objects to find what changed
//     4. Patch the real DOM based on the diff
//     → Wasteful! Extra objects, extra diffing, extra memory.
//
//   Direct DOM (Quantum):
//     1. Create the real DOM element immediately
//     2. Wire up reactive effects to update specific nodes
//     3. When a signal changes → effect updates that ONE node
//     → No intermediate objects. No diffing. Direct updates.
//
// The h() function in Quantum returns a REAL HTMLElement,
// not a virtual node description. This is the key difference.
//
// ============================================================================

/**
 * Properties/attributes that can be passed to an HTML element.
 *
 * Supports:
 *   - Static attributes: class, id, href, src, etc.
 *   - Event handlers: onClick, onInput, onSubmit, etc.
 *   - Reactive attributes: functions that return dynamic values
 *   - Boolean attributes: disabled, checked, required, etc.
 *
 * @example
 * ```ts
 * // Static props
 * h('div', { class: 'card', id: 'main' });
 *
 * // Event handlers — any prop starting with "on"
 * h('button', { onClick: () => setCount(prev => prev + 1) });
 *
 * // Reactive props — function values auto-update the attribute
 * h('div', { class: () => isActive() ? 'active' : 'inactive' });
 * ```
 *
 * @see {@link h} — The function that accepts Props
 */
export type Props = Record<string, unknown>;

/**
 * A child that can be passed to the h() function.
 *
 * Children can be:
 *   - `string`: static text ("Hello World")
 *   - `number`: numeric text (42 → rendered as "42")
 *   - `HTMLElement`: a nested DOM element (from another h() call)
 *   - `() => Child`: reactive child — re-evaluated when signals change.
 *     This is how fine-grained reactivity works: the function is wrapped
 *     in a createEffect(), so when any signal it reads changes, ONLY
 *     this specific text node or element updates.
 *   - `null | undefined | false`: renders nothing (enables conditionals)
 *
 * @example
 * ```ts
 * // Static text
 * h('p', {}, 'Hello World');
 *
 * // Nested element — h() returns HTMLElement, which is a valid child
 * h('div', {}, h('span', {}, 'Nested'));
 *
 * // Reactive child — updates ONLY this text when count() changes
 * h('p', {}, () => `Count: ${count()}`);
 *
 * // Conditional rendering
 * h('div', {}, isLoggedIn() ? h('p', {}, 'Welcome') : null);
 * ```
 *
 * @see {@link h} — The function that accepts children
 */
export type Child =
    | string
    | number
    | HTMLElement
    | (() => Child)
    | null
    | undefined
    | false;
