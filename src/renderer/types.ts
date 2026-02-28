// ============================================================================
// QUANTUM FRAMEWORK — Renderer Type Definitions
// ============================================================================

/**
 * Props object for h() elements.
 *
 * Can contain:
 *   - HTML attributes: class, id, href, src, etc.
 *   - Event handlers: onClick, onInput, onSubmit, etc.
 *   - Reactive attributes: () => value (functions that return values)
 *   - DOM properties: value, checked, selected, etc.
 */
export interface Props
{
    [key: string]: unknown;
}

/**
 * A single child element for h().
 *
 * Can be:
 *   - string or number → rendered as text node
 *   - HTMLElement → appended directly (from nested h() calls)
 *   - function → reactive child, wrapped in effect
 *   - null/undefined/false → skipped (conditional rendering)
 *   - Child[] → flattened and each item processed
 */
export type Child =
    | string
    | number
    | HTMLElement
    | (() => unknown)
    | null
    | undefined
    | false
    | Child[];
