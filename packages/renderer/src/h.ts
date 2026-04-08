// ============================================================================
// AZEROTHJS — h() Direct DOM Creation
// ============================================================================
//
// The h() function creates REAL DOM elements directly.
// There is no virtual DOM, no intermediate objects, no diffing.
//
// COMPARISON WITH OTHER FRAMEWORKS:
//
//   React h() / createElement():
//     Returns virtual node → { type, props, children }
//     Later, reconciler diffs VNodes and patches the DOM.
//
//   AzerothJS h():
//     Returns REAL HTMLElement → <div class="box">Hello</div>
//     Reactive effects are wired up IMMEDIATELY during creation.
//     When signals change, effects update the DOM node DIRECTLY.
//     No diffing. No reconciliation. Just direct DOM mutations.
//
// DOM PROPERTIES vs HTML ATTRIBUTES:
//
//   Some props must be set as DOM PROPERTIES (el.value = x)
//   instead of HTML ATTRIBUTES (el.setAttribute('value', x)).
//
//   Why? Attributes set the INITIAL state. Properties control
//   the LIVE state. For inputs, el.value is the current value,
//   while getAttribute('value') is the initial value.
//
// ============================================================================

import type { Props, Child } from './types.ts';
import { createEffect } from '@azerothjs/reactivity';

/**
 * Set of props that must be set as DOM properties, not attributes.
 *
 * @internal
 */
const DOM_PROPERTIES = new Set
([
    'value',
    'checked',
    'selected',
    'disabled',
    'innerHTML',
    'textContent'
]);

/**
 * Creates a real DOM element with attributes, event handlers,
 * and children — wiring up reactive signals immediately.
 *
 * @param tag - The HTML tag name ('div', 'p', 'span', etc.)
 * @param props - Attributes, event handlers, DOM properties
 * @param children - Zero or more children to append
 *
 * @returns A real HTMLElement with all bindings active
 *
 * @example
 * ```ts
 * // Basic element with attributes
 * h('div', { class: 'card', id: 'main' }, 'Hello');
 * ```
 *
 * @example
 * ```ts
 * // Reactive text
 * const [count, setCount] = createSignal(0);
 * h('span', {}, () => `Count: ${ count() }`);
 * ```
 *
 * @example
 * ```ts
 * // Event handlers
 * h('button', {
 *   onClick: () => setCount(prev => prev + 1)
 * }, 'Click me');
 * ```
 *
 * @example
 * ```ts
 * // Reactive attributes
 * h('div', {
 *   class: () => isActive() ? 'active' : 'inactive',
 *   disabled: () => isLoading()
 * });
 * ```
 *
 * @example
 * ```ts
 * // Array children
 * const items = ['Apple', 'Banana', 'Cherry'];
 * h('ul', {},
 *   items.map(item => h('li', {}, item))
 * );
 * ```
 *
 * @example
 * ```ts
 * // Nested elements
 * h('div', { class: 'card' },
 *   h('h1', {}, 'Title'),
 *   h('p', {}, 'Description'),
 *   h('button', { onClick: handleClick }, 'Action')
 * );
 * ```
 */
export function h(tag: string, props: Props, ...children: Child[]): HTMLElement
{
    const el = document.createElement(tag);

    applyProps(el, props);

    appendChildren(el, children);

    return el;
}

/**
 * Applies properties, attributes, and event handlers
 * to a DOM element.
 *
 * Handles three categories:
 *   1. Event handlers (onClick, onInput, etc.)
 *   2. Reactive attributes (functions that return values)
 *   3. Static attributes (strings, numbers, booleans)
 *
 * @param el - The real DOM element to apply props to
 * @param props - The props object passed to h()
 *
 * @internal
 */
function applyProps(el: HTMLElement, props: Props): void
{
    for (const [key, value] of Object.entries(props))
    {
        // ── Event handlers ───────────────────────────────────
        if (key.startsWith('on') && typeof value === 'function')
        {
            const eventName = key.slice(2).toLowerCase();
            el.addEventListener(eventName, value as EventListener);
            continue;
        }

        // ── Reactive attributes ───────────────────────────────────
        if (typeof value === 'function')
        {
            createEffect(() =>
            {
                const resolved = (value as () => unknown)();
                setProperty(el, key, resolved);
            });
            continue;
        }

        // ── Static attributes ───────────────────────────────────
        setProperty(el, key, value);
    }
}

/**
 * Sets a single property or attribute on a DOM element.
 *
 * Routes to the correct method based on the property name:
 *   - DOM properties → set directly (el.value = x)
 *   - false/null/undefined → remove attribute
 *   - true → set empty attribute (disabled="")
 *   - everything else → setAttribute(key, String(value))
 *
 * @param el - The DOM element
 * @param key - The property/attribute name
 * @param value - The value to set
 *
 * @internal
 */
function setProperty(el: HTMLElement, key: string, value: unknown): void
{
    if (DOM_PROPERTIES.has(key))
    {
        (el as unknown as Record<string, unknown>)[key] = value;
        return;
    }

    if (value === false || value === null || value === undefined)
    {
        el.removeAttribute(key);
        return;
    }

    if (value === true)
    {
        el.setAttribute(key, '');
        return;
    }

    el.setAttribute(key, String(value));
}

/**
 * Appends multiple children to a parent, flattening arrays.
 *
 * @param parent - The DOM element to append to
 * @param children - The children to append (may contain arrays)
 *
 * @internal
 */
function appendChildren(parent: HTMLElement, children: Child[]): void
{
    for (const child of children)
    {
        appendChild(parent, child);
    }
}

/**
 * Appends a single child to a parent DOM element.
 *
 * Handles all child types:
 *   - null/undefined/false → skip (conditional rendering)
 *   - Child[] → flatten and process each item
 *   - HTMLElement → append directly
 *   - string/number → create Text node
 *   - function → reactive child, wrapped in effect
 *
 * @param parent - The DOM element to append to
 * @param child - The child to render
 *
 * @internal
 */
function appendChild(parent: HTMLElement, child: Child): void
{
    if (child === null || child === undefined || child === false)
    {
        return;
    }

    if (Array.isArray(child))
    {
        appendChildren(parent, child);
        return;
    }

    if (typeof child === 'function')
    {
        const textNode = document.createTextNode('');
        parent.appendChild(textNode);

        let currentNode: ChildNode = textNode;

        createEffect(() =>
        {
            const value = child();

            if (value === null || value === undefined || value === false)
            {
                const empty = document.createTextNode('');
                parent.replaceChild(empty, currentNode);
                currentNode = empty;
            }
            else if (value instanceof HTMLElement)
            {
                parent.replaceChild(value, currentNode);
                currentNode = value;
            }
            else if (Array.isArray(value))
            {
                // Reactive function returned an array
                const container = document.createElement('span');
                container.style.display = 'contents';

                for (const item of value as Child[])
                {
                    if (item instanceof HTMLElement)
                    {
                        container.appendChild(item);
                    }
                    else if (item !== null && item !== undefined && item !== false)
                    {
                        container.appendChild(document.createTextNode(String(item)));
                    }
                }

                parent.replaceChild(container, currentNode);
                currentNode = container;
            }
            else
            {
                const newText = document.createTextNode(String(value));
                parent.replaceChild(newText, currentNode);
                currentNode = newText;
            }
        });

        return;
    }

    if (child instanceof HTMLElement)
    {
        parent.appendChild(child);
        return;
    }

    parent.appendChild(document.createTextNode(String(child)));
}
