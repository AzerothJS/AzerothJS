// h() creates real DOM elements directly: no virtual DOM, no intermediate
// objects, no diffing. Where React's createElement returns a VNode that a
// reconciler later diffs and patches, h() returns a live HTMLElement and wires
// up reactive effects immediately. When signals change, those effects mutate
// the DOM node in place.
//
// Without h: build and wire each node by hand, repeating the create/effect
// dance for every element in the tree.
//
//     const el = document.createElement('span');
//     createEffect(() =>
//     {
//         el.textContent = `Count: ${ count() }`; // wire every node yourself
//     });
//
// With h: declare the tree; a function child becomes a reactive binding.
//
//     h('span', {},
//         () => `Count: ${ count() }` // wires itself up, updates on change
//     );
//
// DOM properties vs HTML attributes: some props must be set as DOM properties
// (el.value = x) rather than attributes (el.setAttribute('value', x)).
// Attributes set the initial state; properties control the live state. For an
// input, el.value is the current value while getAttribute('value') is only the
// initial value - see DOM_PROPERTIES below.

import type { Props, Child } from './types.ts';
import type { DisposeFn, HydrationNode, HydrationCursor as HydrationCursorType } from '@azerothjs/reactivity';
import {
    createEffect,
    createRoot,
    isStringMode,
    isHydrating,
    hydrationNode,
    isHydrationNode,
    HydrationCursor,
    transferCarriedSymbols
} from '@azerothjs/reactivity';
import { destroyComponent } from '@azerothjs/component';
import { serializeElement } from './ssr.ts';
import { delegateEvent, isDelegatedEvent } from './delegate.ts';

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
 * Creates a real DOM element with attributes, event handlers, and children,
 * wiring up reactive signals immediately.
 *
 * @param tag - The HTML tag name ('div', 'p', 'span', etc.)
 * @param props - Attributes, event handlers, DOM properties
 * @param children - Zero or more children to append
 * @returns A real HTMLElement with all bindings active
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0);
 * h('div', { class: 'card' },
 *   h('span', {}, () => `Count: ${ count() }`),
 *   h('button', { onClick: () => setCount(prev => prev + 1) }, 'Click me')
 * );
 * ```
 *
 * @example
 * ```ts
 * // Reactive attributes re-evaluate when the signals they read change.
 * h('div', {
 *   class: () => isActive() ? 'active' : 'inactive',
 *   disabled: () => isLoading()
 * });
 * ```
 */
export function h(tag: string, props: Props, ...children: Child[]): HTMLElement
{
    // Server-side rendering: in string mode there is no document, so emit HTML
    // directly. The SSRNode is cast to HTMLElement so it flows through
    // composition (parent h() calls, control-flow children) exactly like a real
    // element would in the DOM path.
    if (isStringMode())
    {
        return serializeElement(tag, props, children) as unknown as HTMLElement;
    }

    // Hydration: don't build DOM. Return a descriptor that, when walked by
    // hydrate(), adopts the matching server-rendered element in place.
    if (isHydrating())
    {
        return createHydrationNode(tag, props, children) as unknown as HTMLElement;
    }

    const el = document.createElement(tag);

    applyProps(el, props);

    appendChildren(el, children);

    return el;
}

/**
 * Applies properties, attributes, and event handlers to a DOM element.
 * Dispatches each prop to one of: ref, event handler (on*), reactive attribute
 * (function value), or static attribute.
 *
 * @param el - The real DOM element to apply props to
 * @param props - The props object passed to h()
 *
 * @internal
 */
function applyProps(el: HTMLElement, props: Props, delegate = false): void
{
    // for...in over Object.entries: this runs once per element created, and
    // entries() allocates an array of [key, value] tuples each call.
    for (const key in props)
    {
        const value = props[key];
        // `ref` is never a DOM attribute: it hands the freshly-created element
        // back to the caller. Must run before the reactive-function branch
        // below, or a ref callback would be mistaken for a reactive attribute.
        if (key === 'ref')
        {
            applyRef(el, value);
            continue;
        }

        if (key.startsWith('on') && typeof value === 'function')
        {
            const eventName = key.slice(2).toLowerCase();
            // Template path (bindProps) delegates bubbling events to one
            // document listener per type; h() keeps per-element listeners
            // (its long-standing contract covers detached elements and
            // non-bubbling dispatches).
            if (delegate && isDelegatedEvent(eventName))
            {
                delegateEvent(el, eventName, value as EventListener);
            }
            else
            {
                el.addEventListener(eventName, value as EventListener);
            }
            continue;
        }

        // Reactive attribute: re-apply whenever the signals it reads change.
        if (typeof value === 'function')
        {
            createEffect(() =>
            {
                const resolved = resolveReactive(value);
                setProperty(el, key, resolved);
            });
            continue;
        }

        setProperty(el, key, value);
    }
}

/**
 * Resolves a reactive value to its final, concrete form by calling it while it
 * is still a function. The common case is a single `() =>` wrapper, but the
 * compiler wraps every compound/call attribute or child expression that way,
 * and some of those expressions ALREADY evaluate to a getter:
 * `classList()` / `styleMap()` return `() => string`, and a hole like
 * `{ p.title }` (where `p.title` is itself a getter) compiles to `() => (p.title)`.
 * Calling only once would hand the inner function to setProperty / buildNode,
 * which stringify it - rendering `() => t("...")` source text into the DOM.
 * Calling through to a non-function value fixes that.
 *
 * Reads happen inside the caller's effect, so every signal touched on the way
 * down is tracked and the binding stays fine-grained. The bound is a guard
 * against a pathological getter that returns a function forever; real chains
 * are one or two deep.
 *
 * @internal
 */
function resolveReactive(value: unknown): unknown
{
    let resolved = value;
    let depth = 0;
    while (typeof resolved === 'function' && depth < 16)
    {
        resolved = (resolved as () => unknown)();
        depth++;
    }
    return resolved;
}

/**
 * Wires up a `ref` prop, handing the created element back to the caller.
 * Supports two forms:
 *
 *   - A ref object from `createRef()` -> sets its `.current`.
 *   - A callback `(el) => void` -> invoked with the element.
 *
 * Anything else is ignored; a ref is never rendered as an attribute.
 *
 * @param el - The freshly-created DOM element
 * @param ref - The value passed as the `ref` prop
 *
 * @internal
 */
function applyRef(el: HTMLElement, ref: unknown): void
{
    if (typeof ref === 'function')
    {
        (ref as (element: HTMLElement) => void)(el);
        return;
    }

    if (ref !== null && typeof ref === 'object' && 'current' in ref)
    {
        (ref as { current: HTMLElement | null }).current = el;
    }
}

/**
 * Sets a single property or attribute on a DOM element, routing by name:
 *   - DOM properties -> set directly (el.value = x)
 *   - false/null/undefined -> remove attribute
 *   - true -> set empty attribute (disabled="")
 *   - everything else -> setAttribute(key, String(value))
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
 * Appends a single child to a parent DOM element, handling all child types:
 *   - null/undefined/false -> skip (conditional rendering)
 *   - Child[] -> flatten and process each item
 *   - HTMLElement -> append directly
 *   - string/number -> create Text node
 *   - function -> reactive child, wrapped in effect
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
        driveReactiveChild(parent, textNode, child as () => unknown);
        return;
    }

    if (child instanceof HTMLElement)
    {
        parent.appendChild(child);
        return;
    }

    parent.appendChild(document.createTextNode(String(child)));
}

/**
 * Wires the reactive-child effect onto an existing node: evaluates `child`
 * per run inside a per-run root and patches `initialNode` (or its
 * replacement) in place. Shared by appendChild's function-child branch and
 * the template path's bindHole().
 *
 * @internal
 */
function driveReactiveChild(parent: HTMLElement, initialNode: ChildNode, child: () => unknown): void
{
    let currentNode: ChildNode = initialNode;

    createEffect(() =>
    {
        // Evaluate the child inside a per-run root. This is critical:
        // building an element here (e.g. `h('span', {}, () => count())`)
        // creates nested effects, and they must be owned by THIS root so
        // they die when we swap. Evaluating outside the root leaks them -
        // exactly what the leak-regression suite guards against.
        let localDispose!: DisposeFn;
        const value = createRoot((d) =>
        {
            localDispose = d;
            return resolveReactive(child);
        });

        // Fast path: primitive into the existing text node. The common
        // reactive child is a string or number (`() => `Count: ${ count() }``).
        // Update the live text node in place rather than building a
        // replacement and swapping it - no DOM node churn per tick, matching
        // fine-grained renderers like Solid. A primitive owns nothing, so
        // dispose this run's (empty) root now and register no cleanup.
        //
        // Only taken when the current node is already a text node, so
        // element/text transitions still take the full rebuild path below
        // (which tears down the old subtree).
        if (currentNode.nodeType === 3 /* Node.TEXT_NODE */ && isPrimitiveValue(value))
        {
            localDispose();
            (currentNode as Text).data = primitiveToText(value);
            return;
        }

        // Full path: materialise the value and swap it in. The root stays
        // alive - it owns the new subtree's effects until the next run or
        // dispose, when the returned cleanup tears it (and the node's
        // components) down.
        const nextNode = buildNode(value);
        parent.replaceChild(nextNode, currentNode);
        currentNode = nextNode;

        return () =>
        {
            localDispose();
            if (nextNode instanceof HTMLElement)
            {
                destroyComponent(nextNode);
            }
        };
    });
}

/**
 * Whether a reactive value can be rendered as plain text in a single text
 * node: strings and numbers, plus the "render nothing" values that become an
 * empty string. Elements and arrays are not primitives; they need the full
 * build/swap path. Kept in sync with buildNode's primitive handling.
 *
 * @internal
 */
function isPrimitiveValue(value: unknown): boolean
{
    return (
        typeof value === 'string' ||
        typeof value === 'number' ||
        value === null ||
        value === undefined ||
        value === false
    );
}

/**
 * Converts a primitive reactive value to the text it should show.
 * `null` / `undefined` / `false` render as empty (the same "nothing here"
 * convention buildNode uses); strings and numbers stringify.
 *
 * @internal
 */
function primitiveToText(value: unknown): string
{
    if (value === null || value === undefined || value === false)
    {
        return '';
    }

    return String(value);
}

/**
 * Builds a single ChildNode from a reactive value. Used by the
 * reactive-child path to materialise the new node inside a
 * createRoot before swapping it in.
 *
 * @internal
 */
function buildNode(value: unknown): ChildNode
{
    if (value === null || value === undefined || value === false)
    {
        return document.createTextNode('');
    }

    if (value instanceof HTMLElement)
    {
        return value;
    }

    if (Array.isArray(value))
    {
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

        return container;
    }

    return document.createTextNode(String(value));
}

// Template-clone bindings. The compiler's `dom` target hoists a region's
// static structure into a tmpl() and emits these two calls for the dynamic
// parts of each clone - the same machinery h() wires per element, applied
// to existing nodes.

/**
 * Applies props (events, reactive attributes, refs, DOM properties) to an
 * existing element - the template path's equivalent of the prop wiring h()
 * does at creation. Compiled `dom`-target code calls this on cloned nodes.
 *
 * Bubbling events are DELEGATED to one document-level listener per type
 * (see delegate.ts): handlers fire only for events that actually bubble to
 * the document, so the element must be connected - the normal state for
 * compiled application markup.
 *
 * @param el - The element inside a template clone
 * @param props - The dynamic props the compiler collected for it
 */
export function bindProps(el: HTMLElement, props: Props): void
{
    applyProps(el, props, true);
}

/**
 * Appends an expression hole into an element with no other children - the
 * marker-free fast path the compiler emits when a hole is its parent's sole
 * child (`<span>{x()}</span>`). Same dispatch as h()'s child handling.
 *
 * @param el - The hole's parent element inside a template clone
 * @param child - The hole's compiled value
 */
export function bindChild(el: HTMLElement, child: Child): void
{
    appendChild(el, child);
}

/**
 * Materialises an expression hole at a template marker node. A function
 * child becomes the standard reactive child binding (only that node updates
 * on change); any other value is placed once. The marker (a `<!--$-->`
 * comment in the template HTML) is replaced by the live node.
 *
 * @param marker - The placeholder node inside a template clone
 * @param child - The hole's compiled value
 */
export function bindHole(marker: ChildNode, child: Child): void
{
    const parent = marker.parentNode as HTMLElement;

    if (typeof child === 'function')
    {
        const textNode = document.createTextNode('');
        parent.replaceChild(textNode, marker);
        driveReactiveChild(parent, textNode, child as () => unknown);
        return;
    }

    parent.replaceChild(buildNode(child), marker);
}

// Hydration: adopt server-rendered DOM instead of creating it.

/**
 * Builds the hydration descriptor for an element. When walked by hydrate(),
 * it claims the matching server element, attaches its props (event listeners,
 * reactive-attribute effects, refs - via the same {@link applyProps} the DOM
 * path uses, which is idempotent against already-rendered attributes),
 * transfers any carried component destroy hooks onto the live element, and
 * recurses into its children.
 *
 * @internal
 */
function createHydrationNode(tag: string, props: Props, children: Child[]): HydrationNode
{
    const node = hydrationNode((cursor: HydrationCursorType): void =>
    {
        const el = cursor.takeElement(tag);

        applyProps(el, props);

        // Component packages store destroy hooks on the value setup() returns -
        // which, in hydrate mode, is THIS descriptor. Move them onto the real
        // element so destroyComponent() finds them after hydration.
        transferCarriedSymbols(node, el);

        const childCursor = new HydrationCursor(el);
        for (const child of children)
        {
            hydrateChild(child, childCursor);
        }
    });

    return node;
}

/**
 * Adopts a single child from `cursor`, mirroring {@link appendChild}'s dispatch
 * but against existing server DOM:
 *
 *   - `null` / `undefined` / `false` -> nothing was rendered, skip
 *   - array -> adopt each item in order
 *   - {@link HydrationNode} -> delegate to its `hydrate`
 *   - function (reactive hole) -> {@link adoptReactiveHole}
 *   - string / number -> consume the existing text node
 *
 * @param child - The child to adopt
 * @param cursor - The cursor over the parent's children
 *
 * @example
 * ```ts
 * // Adopt the children of a server-rendered element instead of rebuilding.
 * const cursor = new HydrationCursor(serverEl);
 * hydrateChild('Hello', cursor);            // consumes the existing text node
 * hydrateChild(() => count(), cursor);      // attaches the patch effect
 * ```
 */
export function hydrateChild(child: Child, cursor: HydrationCursorType): void
{
    if (child === null || child === undefined || child === false)
    {
        return;
    }

    if (Array.isArray(child))
    {
        for (const item of child)
        {
            hydrateChild(item, cursor);
        }
        return;
    }

    if (isHydrationNode(child))
    {
        child.hydrate(cursor);
        return;
    }

    if (typeof child === 'function')
    {
        adoptReactiveHole(child as () => unknown, cursor);
        return;
    }

    // Static text: the server already rendered it; just consume the node.
    cursor.takeText();
}

/**
 * Adopts a reactive child hole. The server wrapped the hole's output in
 * comment anchors (`<!--[-->...<!--]-->`); this finds them, attaches the SAME
 * patching effect the DOM path uses, and - crucially - does NOT mutate on the
 * first run when the value already matches the server text (no flash, node
 * identity preserved). Subsequent runs behave exactly like the DOM path.
 *
 * @internal
 */
function adoptReactiveHole(child: () => unknown, cursor: HydrationCursorType): void
{
    cursor.takeOpenAnchor();
    const { content, closeAnchor } = cursor.takeUntilCloseAnchor();
    const parent = cursor.parent;

    // The hole's live anchor node: the single primitive text node in the
    // common case. Extra nodes (an array-valued hole) are removed the first
    // time the value is materialised as a real node.
    let currentNode: ChildNode | null = content.length > 0 ? content[0] : null;
    let extras: ChildNode[] = content.slice(1);

    createEffect(() =>
    {
        let localDispose!: DisposeFn;
        const value = createRoot((d) =>
        {
            localDispose = d;
            return resolveReactive(child);
        });

        // Primitive into the adopted text node. The dominant case: a
        // `() => `Count: ${ n() }`` hole. Keep the server's text node and only
        // touch `.data` when it actually differs, so the initial run (where it
        // matches) is a no-op.
        if (currentNode !== null && currentNode.nodeType === 3 && isPrimitiveValue(value))
        {
            const text = primitiveToText(value);
            if ((currentNode as Text).data !== text)
            {
                (currentNode as Text).data = text;
            }
            localDispose();
            return;
        }

        // Materialise and swap: element/array values, an initially-empty hole,
        // or a text/element transition. Drop any extra adopted siblings first,
        // then replace (or insert before the close anchor when the hole was
        // empty).
        for (const extra of extras)
        {
            if (extra.parentNode === parent)
            {
                parent.removeChild(extra);
            }
        }
        extras = [];

        const nextNode = buildNode(value);

        if (currentNode !== null)
        {
            parent.replaceChild(nextNode, currentNode);
            if (currentNode instanceof HTMLElement)
            {
                destroyComponent(currentNode);
            }
        }
        else
        {
            parent.insertBefore(nextNode, closeAnchor);
        }

        currentNode = nextNode;

        return () =>
        {
            localDispose();
            if (nextNode instanceof HTMLElement)
            {
                destroyComponent(nextNode);
            }
        };
    });
}
