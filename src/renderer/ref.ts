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
//     - Integrate with third-party libraries
//     - Scroll to an element
//     - Draw on a canvas
//
// HOW IT WORKS:
//   1. createRef() returns a ref object: { current: null }
//   2. Pass ref.current = el after h() creates the element
//   3. After mount, ref.current points to the real DOM element
//
// ============================================================================

/**
 * A ref object that holds a reference to a DOM element.
 *
 * @typeParam T - The type of DOM element (defaults to HTMLElement)
 */
export interface Ref<T extends HTMLElement = HTMLElement>
{
    /** The referenced DOM element. null until the element is created. */
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
 * const inputRef = createRef<HTMLInputElement>();
 *
 * const el = h('div', {},
 *   h('input', { type: 'text' }),
 *   h('button', {
 *     onClick: () => inputRef.current?.focus(),
 *   }, 'Focus Input'),
 * );
 *
 * // Assign the ref to the input element
 * inputRef.current = el.querySelector('input');
 * ```
 *
 * @example
 * ```ts
 * // With defineComponent and onMount
 * const Canvas = defineComponent(() =>
 * {
 *     const canvasRef = createRef<HTMLCanvasElement>();
 *
 *     onMount(() =>
 *     {
 *         const ctx = canvasRef.current?.getContext('2d');
 *         if (ctx)
 *         {
 *             ctx.fillStyle = 'red';
 *             ctx.fillRect(0, 0, 100, 100);
 *         }
 *     });
 *
 *     const canvas = h('canvas', { width: '400', height: '300' });
 *     canvasRef.current = canvas as HTMLCanvasElement;
 *
 *     return canvas;
 * });
 * ```
 */
export function createRef<T extends HTMLElement = HTMLElement>(): Ref<T>
{
    return { current: null };
}
