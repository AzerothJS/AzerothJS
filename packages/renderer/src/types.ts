// Input types for h(), the function that creates real DOM elements.

/**
 * Props object for h() elements.
 *
 * Can contain:
 *   - HTML attributes: class, id, href, src, etc.
 *   - Event handlers: onClick, onInput, onSubmit, etc.
 *   - Reactive attributes: () => value (function getters)
 *   - DOM properties: value, checked, selected, etc.
 *   - Boolean attributes: disabled, required, etc.
 *
 * @example
 * ```ts
 * h('input', {
 *   type: 'text',                           // static attribute
 *   class: () => isActive() ? 'on' : 'off', // reactive attribute
 *   value: inputValue,                       // DOM property
 *   disabled: () => isLoading(),             // reactive boolean
 *   onInput: (e) => handleInput(e)           // event handler
 * });
 * ```
 */
export interface Props
{
    [key: string]: unknown;
}

/**
 * A child element for h().
 *
 * Can be:
 *   - string or number -> rendered as text node
 *   - HTMLElement -> appended directly (from nested h() calls)
 *   - function -> reactive child, wrapped in effect
 *   - null/undefined/false -> skipped (conditional rendering)
 *   - Child[] -> flattened and each item processed
 *
 * @example
 * ```ts
 * h('div', {},
 *   'Static text',                       // string
 *   42,                                   // number
 *   h('span', {}, 'Nested'),              // HTMLElement
 *   () => `Count: ${ count() }`,          // reactive
 *   isAdmin() ? h('button', {}, 'Edit') : null, // conditional
 *   items.map(i => h('p', {}, i.name))    // array
 * );
 * ```
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
