/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The imperative escape hatch: direct access to an element for the tasks that genuinely need
 * the live node - focusing an input, measuring dimensions, drawing on a canvas, attaching a
 * chart or map library.
 *
 * The callback form is primary: `<input ref={el => el.focus()} />` hands the element straight
 * to the function, needs no import and is typed from the element. The box form,
 * {@link createRef}, exists for when the element must be read LATER, from an effect or after
 * mount.
 *
 * ref is a runtime helper and not a keyword because keywords declare REACTIVE constructs -
 * the compiler rewrites their reads and binds their lifetime to the component's root. A ref
 * does none of that: `current` is a plain read with no tracking and nothing to dispose. The
 * only compiler involvement is routing the `ref` prop off the reactive-attribute path, which
 * keeps "keyword means reactive construct" true and the language smaller.
 */

/**
 * A box holding a reference to a DOM element.
 *
 * @typeParam T - The element type. Defaults to HTMLElement; SVG elements box equally well.
 */
export interface Ref<T extends Element = HTMLElement>
{
    /** The referenced element, null until h() assigns it at creation. */
    current: T | null;
}

/**
 * Creates a `{ current: null }` box that h() fills with the element when the box is passed
 * as the `ref` prop.
 *
 * `current` is null until that element is created, so reading it during component setup
 * gives null - read it from an effect or after mount. It is NOT nulled again when the
 * element is later removed, so a stale ref can outlive the node it points at.
 *
 * @typeParam T - The element type.
 * @returns A {@link Ref} with `current: null`.
 * @example
 * const input = createRef<HTMLInputElement>();
 * h('input', { type: 'text', ref: input });
 *
 * onMount(() => input.current?.focus());
 *
 * @see {@link Ref} for the callback form, which needs no box at all.
 */
export function createRef<T extends Element = HTMLElement>(): Ref<T>
{
    return { current: null };
}
