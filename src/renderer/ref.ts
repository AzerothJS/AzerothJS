// ============================================================================
// QUANTUM FRAMEWORK — Ref (Direct DOM Access)
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
//   2. Assign the DOM element after h() creates it
//   3. After that, ref.current points to the real DOM element
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
 * // Focus an input
 * const inputRef = createRef<HTMLInputElement>();
 *
 * const input = h('input', { type: 'text' });
 * inputRef.current = input as HTMLInputElement;
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
 * onMount(() =>
 * {
 *     const ctx = canvasRef.current?.getContext('2d');
 *     if (ctx)
 *     {
 *         ctx.fillStyle = 'red';
 *         ctx.fillRect(0, 0, 100, 100);
 *      }
 * });
 *
 * const canvas = h('canvas', { width: '400', height: '300' });
 * canvasRef.current = canvas as HTMLCanvasElement;
 * ```
 *
 * @example
 * ```ts
 * // Measure element dimensions
 * const boxRef = createRef();
 *
 * onMount(() =>
 * {
 *     const rect = boxRef.current?.getBoundingClientRect();
 *     console.log('Width:', rect?.width, 'Height:', rect?.height);
 * });
 *
 * const box = h('div', { class: 'box' }, 'Measure me');
 * boxRef.current = box;
 * ```
 */
export function createRef<T extends HTMLElement = HTMLElement>(): Ref<T>
{
    return { current: null };
}
