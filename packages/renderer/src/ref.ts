// ============================================================================
// AZEROTHJS — Ref (Direct DOM Access)
// ============================================================================
//
// A ref provides direct access to a DOM element after it's created.
//
// WHY?
//   Sometimes you need the actual DOM element:
//     - Focus an input programmatically
//     - Measure element dimensions
//     - Integrate with third-party libraries (charts, maps)
//     - Scroll to an element
//     - Draw on a canvas
//
// HOW IT WORKS:
//   1. createRef() returns { current: null }
//   2. Pass it to an element via the `ref` prop: h('input', { ref })
//   3. h() assigns the element to ref.current as it's created
//
//   A `ref` can also be a callback — h('div', { ref: el => ... }) —
//   when you just want the element without holding a ref object.
//
// ============================================================================

/**
 * A ref object that holds a reference to a DOM element.
 *
 * @typeParam T - The type of DOM element (defaults to HTMLElement)
 */
export interface Ref<T extends HTMLElement = HTMLElement>
{
    /** The referenced DOM element. null until assigned. */
    current: T | null;
}

/**
 * Creates a ref object for direct DOM element access.
 *
 * The ref starts with `current: null` and gets populated
 * when you assign it to an element.
 *
 * @typeParam T - The type of DOM element
 *
 * @returns A Ref object with a `current` property
 *
 * @example
 * ```ts
 * // Focus an input — pass the ref via the `ref` prop.
 * const inputRef = createRef<HTMLInputElement>();
 *
 * h('input', { type: 'text', ref: inputRef });
 *
 * onMount(() =>
 * {
 *     inputRef.current?.focus();
 * });
 * ```
 *
 * @example
 * ```ts
 * // Draw on a canvas
 * const canvasRef = createRef<HTMLCanvasElement>();
 *
 * h('canvas', { width: '400', height: '300', ref: canvasRef });
 *
 * onMount(() =>
 * {
 *     const ctx = canvasRef.current?.getContext('2d');
 *     if (ctx)
 *     {
 *         ctx.fillStyle = 'red';
 *         ctx.fillRect(0, 0, 100, 100);
 *     }
 * });
 * ```
 *
 * @example
 * ```ts
 * // Measure element dimensions
 * const boxRef = createRef();
 *
 * h('div', { class: 'box', ref: boxRef }, 'Measure me');
 *
 * onMount(() =>
 * {
 *     const rect = boxRef.current?.getBoundingClientRect();
 *     console.log('Width:', rect?.width, 'Height:', rect?.height);
 * });
 * ```
 */
export function createRef<T extends HTMLElement = HTMLElement>(): Ref<T>
{
    return { current: null };
}
