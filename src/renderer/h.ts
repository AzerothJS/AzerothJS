// ============================================================================
// QUANTUM FRAMEWORK — h() Direct DOM Creation
// ============================================================================
//
// The h() function creates REAL DOM elements directly.
// There is no virtual DOM, no intermediate objects, no diffing.
//
// COMPARISON WITH OTHER FRAMEWORKS:
//
//   React h() / createElement():
//     Returns a virtual node → { type: 'div', props: {...}, children: [...] }
//     Later, React's reconciler diffs VNodes and patches the DOM.
//
//   Quantum h():
//     Returns a REAL HTMLElement → <div class="box">Hello</div>
//     Reactive effects are wired up IMMEDIATELY during creation.
//     When signals change, effects update the DOM node DIRECTLY.
//
// WHY "h"?
//   "h" stands for "hyperscript" — a convention used by Preact, Vue,
//   Mithril, and others. It means "create an HTML element".
//   Short name because it's called frequently in UI code.
//
// ============================================================================

import type { Props, Child } from './types.ts';
import { createEffect } from '../reactivity/effect.ts';

// ============================================================================
// DOM PROPERTIES vs HTML ATTRIBUTES
// ============================================================================
//
// Some props must be set as DOM PROPERTIES (el.value = x) instead of
// HTML ATTRIBUTES (el.setAttribute('value', x)).
//
// Why? Because attributes only set the INITIAL state, while properties
// control the LIVE state of the element.
//
//   el.setAttribute('value', 'hello')  → Sets initial value only
//   el.value = 'hello'                 → Updates what the user sees!
//
//   el.setAttribute('checked', '')     → Sets initial checked only
//   el.checked = true                  → Updates the actual checkbox!
//
// This Set contains all prop names that must be set as DOM properties.
// ============================================================================

const DOM_PROPERTIES = new Set
([
    'value',
    'checked',
    'selected',
    'disabled',
    'innerHTML',
    'textContent',
]);

/**
 * Creates a real DOM element with attributes, event handlers,
 * and children — wiring up reactive signals immediately.
 *
 * Unlike React's createElement which returns a virtual node,
 * Quantum's h() returns an actual HTMLElement. Reactive children
 * and attributes are connected via effects at creation time,
 * so updates go DIRECTLY to the DOM node — no diffing needed.
 *
 * @param tag - The HTML tag name ('div', 'p', 'span', 'button', etc.)
 * @param props - Attributes and event handlers for the element.
 *                Pass an empty object {} if no attributes are needed.
 * @param children - Zero or more children: strings, numbers,
 *                   other h() elements, reactive functions, or null.
 *
 * @returns A real HTMLElement with all attributes, events, and
 *          children already attached and reactive bindings active.
 *
 * @example
 * ```ts
 * // Simple text element — creates a real <p> immediately
 * h('p', {}, 'Hello World');
 * // Returns: <p>Hello World</p>  (real DOM node!)
 *
 * // Element with attributes
 * h('a', { href: '/about', class: 'link' }, 'About Us');
 * // Returns: <a href="/about" class="link">About Us</a>
 *
 * // Element with event handler
 * h('button', { onClick: () => setCount(prev => prev + 1) }, 'Click me');
 * // Returns: <button>Click me</button>  (with click handler attached)
 *
 * // Nested elements — inner h() calls return real elements too
 * h('div', { class: 'card' },
 *   h('h2', {}, 'Card Title'),
 *   h('p', {}, 'Description'),
 * );
 * // Returns: <div class="card"><h2>Card Title</h2><p>Description</p></div>
 *
 * // Reactive text — updates ONLY this text node when signal changes
 * h('p', {}, () => `Count: ${count()}`);
 * // Returns: <p>Count: 0</p>
 * // After setCount(5): <p>Count: 5</p>  (direct update, no diffing!)
 *
 * // Two-way input binding — signal updates the input, input updates the signal
 * h('input', {
 *   value: () => inputText(),
 *   onInput: (e) => setInputText(e.target.value),
 * });
 * ```
 */
export function h(tag: string, props: Props, ...children: Child[]): HTMLElement
{
    const el = document.createElement(tag);

    applyProps(el, props);

    for (const child of children)
    {
        appendChild(el, child);
    }

    return el;
}

/**
 * Applies properties, attributes, and event handlers to a DOM element.
 *
 * Handles three categories:
 *   1. Event handlers — props starting with "on" (onClick → click event)
 *   2. Reactive attributes — function values wrapped in effects
 *   3. Static attributes — set once with setAttribute() or as DOM property
 *
 * @param el - The real DOM element to apply props to
 * @param props - The props object passed to h()
 */
function applyProps(el: HTMLElement, props: Props): void
{
    for (const [key, value] of Object.entries(props))
    {
        if (key.startsWith('on') && typeof value === 'function')
        {
            const eventName = key.slice(2).toLowerCase();
            el.addEventListener(eventName, value as EventListener);

            continue;
        }

        if (typeof value === 'function')
        {
            createEffect(() =>
            {
                const resolved = (value as () => unknown)();
                setProperty(el, key, resolved);
            });

            continue;
        }

        setProperty(el, key, value);
    }
}

/**
 * Sets a single property or attribute on a DOM element.
 *
 * Some properties (value, checked, selected, etc.) must be set as
 * DOM properties rather than HTML attributes, because attributes only
 * set the initial state while properties control the live state.
 *
 * @param el - The DOM element
 * @param key - The property/attribute name
 * @param value - The value to set
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
 * Appends a child to a parent DOM element.
 *
 * Handles all child types:
 *   - null/undefined/false → skip (enables conditional rendering)
 *   - HTMLElement → append directly (from nested h() calls)
 *   - string/number → create and append a Text node
 *   - function → reactive child, wrapped in effect for auto-updates
 *
 * @param parent - The DOM element to append to
 * @param child - The child to render
 */
function appendChild(parent: HTMLElement, child: Child): void
{
    if (child === null || child === undefined || child === false)
    {
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
