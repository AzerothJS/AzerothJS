/**
 * MODULE: renderer/types
 *
 * Input types for {@link h}, the function that builds real DOM elements.
 */

/**
 * The props object for h() elements: HTML attributes, on* event handlers, DOM properties,
 * boolean attributes, and reactive attributes (function getters). A function value is treated as
 * a reactive attribute (re-applied in an effect); `ref` is handled specially (a callback or a
 * createRef object).
 *
 * @example
 * h('input', {
 *   type: 'text',                            // static attribute
 *   class: () => isActive() ? 'on' : 'off',  // reactive attribute
 *   value: inputValue,                        // DOM property
 *   disabled: () => isLoading(),              // reactive boolean
 *   onInput: (e) => handleInput(e)            // event handler
 * });
 */
export interface Props
{
    [key: string]: unknown;
}

/**
 * A child accepted by h(): a string/number (text node), an HTMLElement (nested h() output), a
 * function (reactive hole, wired to an effect), null/undefined/false (skipped, for conditional
 * rendering), or a (recursively) nested array of children.
 *
 * @example
 * h('div', {},
 *   'Static text', 42, h('span', {}, 'Nested'),
 *   () => `Count: ${ count() }`,                 // reactive
 *   isAdmin() ? h('button', {}, 'Edit') : null,  // conditional
 *   items.map(i => h('p', {}, i.name))           // array
 * );
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
