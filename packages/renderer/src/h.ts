/**
 * MODULE: renderer/h
 *
 * h() is the hyperscript core: it builds REAL DOM directly - no virtual DOM, no
 * intermediate VNodes, no diffing. Where React's createElement returns a VNode a
 * reconciler later diffs and patches, h() returns a live HTMLElement and wires reactive
 * effects immediately; when a signal changes, the effect mutates that node in place. This
 * file also hosts the shared child/attribute machinery and the compiler-emitted runtime
 * (setProp / bindProps / bindHole / bindSlot) plus the hydration adopters - all three
 * render modes (dom build, SSR serialize, hydrate adopt) funnel through here.
 *
 * DOM PROPERTIES vs ATTRIBUTES: some props must be set as DOM properties (el.value = x)
 * rather than attributes (setAttribute) - attributes seed initial state, properties carry
 * live state (an <input>'s el.value vs its initial value attribute). See DOM_PROPERTIES.
 */

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

/** SVG / MathML namespace URIs. @internal */
const SVG_NS = 'http://www.w3.org/2000/svg';
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

/**
 * SVG element tag names. A `<circle>`/`<path>`/`<svg>` built with the HTML
 * `createElement` lands in the XHTML namespace and the browser refuses to paint it
 * (no geometry, no styling), so these must be created with createElementNS(SVG_NS).
 * The four tags SVG shares with HTML (`a`, `script`, `style`, `title`) are deliberately
 * NOT listed: they are far more common as HTML, and an SVG `<a>`/`<title>` is rare.
 *
 * @internal
 */
const SVG_TAGS = new Set
([
    'svg', 'g', 'defs', 'symbol', 'use', 'switch', 'foreignObject', 'marker', 'mask',
    'pattern', 'clipPath', 'filter', 'view', 'desc', 'metadata',
    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
    'textPath', 'image', 'animate', 'animateMotion', 'animateTransform', 'mpath', 'set',
    'linearGradient', 'radialGradient', 'stop', 'feBlend', 'feColorMatrix',
    'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
    'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA',
    'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge',
    'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting',
    'feSpotLight', 'feTile', 'feTurbulence'
]);

/** MathML element tag names; created with createElementNS(MATHML_NS) for the same reason. @internal */
const MATHML_TAGS = new Set
([
    'math', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'mfrac', 'msqrt',
    'mroot', 'mstyle', 'merror', 'mpadded', 'mphantom', 'mfenced', 'menclose', 'msub',
    'msup', 'msubsup', 'munder', 'mover', 'munderover', 'mmultiscripts', 'mtable',
    'mtr', 'mtd', 'maction', 'annotation', 'semantics'
]);

/**
 * Creates a DOM element in the correct namespace for its tag. Plain `createElement`
 * always uses the XHTML namespace, which silently breaks SVG and MathML; foreign-content
 * tags are routed to createElementNS so a `<svg>`/`<math>` subtree built through h()
 * renders and styles exactly like one cloned from a template.
 *
 * Because h() builds children before their parent, the namespace is inferred from each
 * tag name rather than a parent context - the known SVG/MathML tag sets give every
 * element in such a subtree the right namespace independently.
 *
 * @internal
 * @param tag - The element tag name.
 * @returns The created element, namespaced when the tag is SVG/MathML.
 */
function createElementByTag(tag: string): HTMLElement
{
    if (SVG_TAGS.has(tag))
    {
        return document.createElementNS(SVG_NS, tag) as unknown as HTMLElement;
    }
    if (MATHML_TAGS.has(tag))
    {
        return document.createElementNS(MATHML_NS, tag) as unknown as HTMLElement;
    }
    return document.createElement(tag);
}

/**
 * h
 *
 * PURPOSE:
 * Creates a real DOM element with the given attributes/events/DOM-properties and children,
 * wiring any reactive (function) prop or child to an effect that updates the node in place.
 *
 * WHY IT EXISTS:
 * It is the runtime target the compiler lowers markup to, and the manual rendering API. A
 * no-VDOM design needs a primitive that both builds a node AND establishes its fine-grained
 * bindings at creation, so an update touches exactly the changed attribute/text rather than
 * re-rendering and diffing a subtree.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, renderer core. Mode-dispatched at the top of every call: 'string' mode
 * serializes to HTML (no document); 'hydrate' mode returns a descriptor that adopts the
 * matching server node; otherwise it builds DOM. Compiled `.azeroth` output calls h() (and,
 * on the template-clone path, setProp/bindProps/bindHole/bindSlot) for element-rooted regions.
 *
 * INPUT CONTRACT:
 * - tag: an HTML tag name.
 * - props: attributes, on* event handlers, DOM properties, and `ref`. A FUNCTION value is a
 *   reactive attribute (re-applied in an effect); `ref` is a callback or a createRef object.
 * - children: elements, strings/numbers, arrays, null/undefined/false (skipped), or
 *   functions (reactive holes).
 *
 * OUTPUT CONTRACT:
 * - Returns an HTMLElement with all bindings active. (In string/hydrate modes an
 *   SSRNode/hydration descriptor is cast to HTMLElement so it composes identically.)
 *
 * WHY THIS DESIGN:
 * Building the node and its effects together is what makes updates fine-grained and
 * VDOM-free: a reactive child patches one text node in place (fast path) and rebuilds only
 * on a type change; a reactive attribute re-applies just that attribute. Each reactive child
 * runs in a per-run root so its nested effects are owned and torn down on swap (no leaks).
 *
 * WHEN TO USE:
 * As the manual element API, or wherever you build DOM imperatively. In `.azeroth` files you
 * write markup and the compiler emits h() for you.
 *
 * WHEN NOT TO USE:
 * For control flow - use {@link Show}/{@link Switch}/{@link For}/{@link Dynamic}, which
 * manage mounting/disposal and SSR/hydration markers.
 *
 * EDGE CASES:
 * - A function prop is always a reactive attribute; a function child is always a reactive
 *   hole. false/null/undefined children render nothing.
 * - A DocumentFragment child (a <For>) is moved in directly, so its rows become this
 *   element's own children (no wrapper).
 *
 * PERFORMANCE NOTES:
 * Direct DOM, no diff. The reactive-child fast path mutates a text node's `.data` instead of
 * swapping nodes; props are applied in a single for-in pass per element.
 *
 * DEVELOPER WARNING:
 * A reactive attribute/child MUST be passed as a function (`() => expr`); passing the value
 * eagerly binds it once. h() attaches per-element event listeners, whereas the compiled
 * template path (bindProps) delegates bubbling events to one document listener per type.
 *
 * @param tag - The HTML tag name ('div', 'p', 'span', ...).
 * @param props - Attributes, on* handlers, DOM properties, and `ref`.
 * @param children - Zero or more children to append.
 * @returns A real HTMLElement with all bindings active.
 * @see {@link Show}
 * @see {@link For}
 * @example
 * h('div', { class: () => isActive() ? 'on' : 'off' },
 *   h('span', {}, () => `Count: ${ count() }`),
 *   h('button', { onClick: () => setCount(n => n + 1) }, 'Inc')
 * );
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

    const el = createElementByTag(tag);

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
export function resolveReactive(value: unknown): unknown
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

    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- last-resort attribute coercion: primitives stringify correctly; an object here is caller error surfaced visibly rather than thrown mid-render
    el.setAttribute(key, String(value));
}

/**
 * Sets one prop on an element the way the compiled `dom` target does: resolve
 * any getter-chain to a concrete value, then apply it with the same
 * property-vs-attribute semantics as {@link applyProps} (`false`/`null` removes,
 * `true` sets `''`). This is the trimmed counterpart to a pass through
 * applyProps - the compiler knows the dependencies, so it emits one `setProp`
 * per binding with no props object and no dispatch loop. Wrap reactive bindings
 * in createEffect; call it once for static ones.
 *
 * @example
 * ```ts
 * createEffect(() => setProp(el, 'href', url())); // reactive attribute
 * setProp(el, 'class', 'card');                    // static, set once
 * ```
 *
 * @internal Compiler-emitted runtime; not part of the application API.
 */
export function setProp(el: HTMLElement, name: string, value: unknown): void
{
    setProperty(el, name, resolveReactive(value));
}

/**
 * Appends multiple children to a parent, flattening arrays.
 *
 * @param parent - The DOM element to append to
 * @param children - The children to append (may contain arrays)
 *
 * @internal
 */
function appendChildren(parent: HTMLElement | DocumentFragment, children: Child[]): void
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
function appendChild(parent: HTMLElement | DocumentFragment, child: Child): void
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
        driveReactiveChild(parent, textNode, child);
        return;
    }

    // Any DOM node is appended directly. This covers HTMLElement, SVG/MathML elements
    // (which are SVGElement/Element, NOT HTMLElement - checking only HTMLElement would
    // stringify them to "[object SVG...Element]"), Text/Comment nodes, and a
    // DocumentFragment (how <For> mounts its rows with no wrapper: appending the
    // fragment moves its markers + rows directly into `parent`). <For> reaches here via
    // its `as unknown as HTMLElement` return, so `child` isn't statically a Node.
    if ((child as unknown) instanceof Node)
    {
        parent.appendChild(child as unknown as Node);
        return;
    }

    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- last-resort child coercion: primitives stringify correctly; a plain object is caller error surfaced visibly rather than thrown mid-render
    parent.appendChild(document.createTextNode(String(child)));
}

/**
 * Renders an array-valued reactive child as DIRECT siblings in front of `anchor` - never inside a
 * wrapper element. A `display:contents` wrapper would be ignored by `<select>`'s option model and break
 * `<table>` row parsing, so a reactive list (`{ items().map(...) }`) must be direct children of the real
 * parent. The items are built into the live parent first (so any reactive binding inside an item anchors
 * to that real parent, not a throwaway fragment), then moved into place. Returns the inserted nodes in
 * order. The single implementation shared by both reactive-child drivers.
 *
 * @internal
 */
function insertArrayChildren(parent: Node, value: unknown, anchor: ChildNode): ChildNode[]
{
    const start = parent.childNodes.length;
    appendChildren(parent as HTMLElement, value as Child[]);
    const nodes = Array.prototype.slice.call(parent.childNodes, start) as ChildNode[];
    for (const node of nodes)
    {
        parent.insertBefore(node, anchor);
    }
    return nodes;
}

/** Runs component destroy hooks on each element in `nodes` (control-flow / array teardown). @internal */
function destroyNodes(nodes: readonly ChildNode[]): void
{
    for (const node of nodes)
    {
        if (node instanceof HTMLElement)
        {
            destroyComponent(node);
        }
    }
}

/**
 * Wires the reactive-child effect onto an existing node: evaluates `child`
 * per run inside a per-run root and patches `initialNode` (or its
 * replacement) in place. Shared by appendChild's function-child branch and
 * the template path's bindHole().
 *
 * @internal
 */
function driveReactiveChild(parent: HTMLElement | DocumentFragment, initialNode: ChildNode, child: () => unknown): void
{
    let currentNode: ChildNode = initialNode;
    // Extra nodes when the value is an array: rendered as DIRECT siblings of `currentNode` (no wrapper),
    // tracked so the next update removes them all. `currentNode` is always a real node (an empty array
    // holds its slot with an empty text node), preserving this binding's single-anchor invariant.
    let extras: ChildNode[] = [];

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
        if (currentNode.nodeType === 3 /* Node.TEXT_NODE */ && isPrimitiveValue(value) && extras.length === 0)
        {
            localDispose();
            (currentNode as Text).data = primitiveToText(value);
            return;
        }

        // Drop any extra nodes a previous array render left as siblings.
        for (const extra of extras)
        {
            if (extra.parentNode === parent)
            {
                parent.removeChild(extra);
            }
        }
        extras = [];

        // Array value: render items as DIRECT siblings of currentNode (no `display:contents` wrapper),
        // so a reactive list is valid inside `<select>`/`<table>`/`<ul>`. An empty array still holds the
        // slot with an empty text node so `currentNode` stays a real node.
        if (Array.isArray(value))
        {
            // Render the items as direct siblings in this binding's slot. An empty array keeps the slot
            // with an empty text node so `currentNode` stays a real node (this binding's invariant).
            let nodes = insertArrayChildren(parent, value, currentNode);
            let head = nodes[0];
            if (head === undefined)
            {
                const placeholder = document.createTextNode('');
                parent.insertBefore(placeholder, currentNode);
                nodes = [placeholder];
                head = placeholder;
            }
            if (currentNode instanceof HTMLElement)
            {
                destroyComponent(currentNode);
            }
            parent.removeChild(currentNode);
            currentNode = head;
            extras = nodes.slice(1);
            return () =>
            {
                localDispose();
                destroyNodes(nodes);
            };
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
function isPrimitiveValue(value: unknown): value is string | number | null | undefined | false
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
function primitiveToText(value: string | number | null | undefined | false): string
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

    // A reactive child that returns a <For> (e.g. `() => For({...})`) yields a
    // DocumentFragment. The reactive-child path swaps a SINGLE node in place,
    // which a multi-node range can't satisfy, so wrap the fragment's nodes in a
    // contents span here. (Used <For> directly as an element child needs no
    // wrapper - see appendChild's DocumentFragment branch.)
    if (value instanceof DocumentFragment)
    {
        const container = document.createElement('span');
        container.style.display = 'contents';
        container.appendChild(value);
        return container;
    }

    if (Array.isArray(value))
    {
        const container = document.createElement('span');
        container.style.display = 'contents';
        // Route each item through the full child pipeline, not a flat
        // instanceof/String check: an array element can itself be a getter
        // (`[() => icon, () => t('x')]`, exactly what tag-style multi-child
        // markup compiles to), a nested array, or a non-HTML node. appendChild
        // resolves getters into reactive bindings and recurses; a bare
        // `String(item)` here would render a getter as its literal source text.
        // We are already inside buildNode's caller createRoot, so the reactive
        // bindings these items create are owned and torn down with this subtree.
        appendChildren(container, value as Child[]);
        return container;
    }

    // Any other DOM node (SVG/MathML element, Text, Comment) is inserted as-is -
    // only a NON-node value falls through to being rendered as text. Without this
    // a returned SVG element or text node would be stringified to "[object ...]".
    if (value instanceof Node)
    {
        return value as ChildNode;
    }

    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- last-resort text coercion: primitives stringify correctly; a plain object is caller error surfaced visibly rather than thrown mid-render
    return document.createTextNode(String(value));
}

/**
 * Coerces a control-flow branch result (the value a `Show`/`Switch`/`Dynamic` branch thunk returns)
 * into something insertable into the branch's co-range, or null to insert nothing.
 *
 * A multi-child branch (`<Show when={x}><A/><B/></Show>`) or a list branch
 * (`<Show when={x}>{items().map(...)}</Show>`) produces an ARRAY; an array (and a
 * `<For>`-style DocumentFragment) is returned as a DocumentFragment whose items are
 * DIRECT children - never a `display:contents` span. The caller inserts it with
 * `insertBefore(fragment, endMarker)`, which moves those items straight into the real
 * parent between the co-range markers, so a branch list is valid inside `<select>`,
 * `<table>`, `<ul>` (a wrapper element is not). This is the same guarantee a reactive
 * array hole already gets; it now holds for control-flow branches too.
 *
 * `null`/`undefined`/`false` render nothing (no stray empty text node, matching SSR,
 * which skips them - so client and server agree and hydration does not mismatch). Any
 * other value becomes a single text/DOM node via buildNode.
 *
 * @internal Compiler/runtime helper; not part of the application API.
 */
export function materializeChild(value: unknown): Node | null
{
    if (value === null || value === undefined || value === false)
    {
        return null;
    }

    if (Array.isArray(value))
    {
        const fragment = document.createDocumentFragment();
        // appendChildren resolves getters/nested arrays/nodes through the full pipeline;
        // items become the fragment's direct children, then move into the co-range as a
        // group when the fragment is inserted before the end marker.
        appendChildren(fragment, value as Child[]);
        return fragment;
    }

    // A <For> (and any branch returning a DocumentFragment) is moved in directly so its
    // rows become the co-range's own children - no wrapper element.
    if (value instanceof DocumentFragment)
    {
        return value;
    }

    return buildNode(value);
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
 *
 * @internal Compiler-emitted runtime; not part of the application API.
 */
export function bindProps(el: HTMLElement, props: Props): void
{
    applyProps(el, props, true);
}

/**
 * Materialises an expression hole at a template `<!--[--><!--]-->` anchor pair.
 * The template clone carries an empty anchor range (the same scheme SSR emits
 * and hydration adopts); `openAnchor` is the `<!--[-->` comment and
 * its `nextSibling` is the matching `<!--]-->`. A function child becomes the
 * standard reactive child binding driven between the anchors (only that range
 * updates on change); any other value is placed once and the now-unneeded
 * anchors are removed so static holes leave clean DOM.
 *
 * @param openAnchor - The hole's open-anchor comment inside a template clone
 * @param child - The hole's compiled value
 *
 * @internal Compiler-emitted runtime; not part of the application API.
 */
export function bindHole(openAnchor: ChildNode, child: Child): void
{
    const parent = openAnchor.parentNode as HTMLElement;
    const closeAnchor = openAnchor.nextSibling as ChildNode;

    if (typeof child === 'function')
    {
        driveHoleRange(parent, closeAnchor, [], child);
        return;
    }

    parent.insertBefore(buildNode(child), closeAnchor);
    parent.removeChild(openAnchor);
    parent.removeChild(closeAnchor);
}

/**
 * Drives a hole that is its element's ONLY child (`<td>{ expr }</td>`): the
 * element itself bounds the content, so no anchor pair exists in the clone.
 * The dominant case - a scalar value - keeps ONE text node and updates its
 * `data` in place; a non-scalar (element/fragment/array) value replaces the
 * element's content through the ordinary child pipeline. A static (non-function)
 * child is placed once with no effect at all.
 *
 * @param el - The element whose entire content the hole owns
 * @param child - The hole's value: a getter for a reactive hole, or the value itself
 *
 * @internal Compiler-emitted runtime; not part of the application API.
 */
export function bindContent(el: HTMLElement, child: Child): void
{
    if (typeof child !== 'function')
    {
        placeContent(el, null, child);
        return;
    }

    // The current scalar text node, reused across runs; null after a non-scalar
    // value (or an empty string, which leaves no node behind).
    let text: Text | null = null;
    createEffect(() =>
    {
        text = placeContent(el, text, (child)());
    });
}

/**
 * Writes one bindContent value into `el`. Returns the scalar text node to reuse
 * on the next run, or null when the value was non-scalar or rendered empty.
 *
 * @internal
 */
function placeContent(el: HTMLElement, text: Text | null, value: unknown): Text | null
{
    if (value === null || value === undefined || typeof value !== 'object')
    {
        // Scalar path - matches buildNode's text coercion (null/undefined/false
        // render as nothing).
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- scalar by the guard above
        const s = value === null || value === undefined || value === false ? '' : String(value);
        if (text !== null)
        {
            text.data = s;
            return text;
        }
        el.textContent = s;
        return el.firstChild as Text | null;
    }
    el.textContent = '';
    el.appendChild(buildNode(value));
    return null;
}

/**
 * Wires one event handler the way the template path does everywhere else:
 * bubbling event types are DELEGATED to one document-level listener (a property
 * write per element instead of an addEventListener per element per row); types
 * that do not reliably bubble keep a per-element listener.
 *
 * @param el - The element the handler belongs to
 * @param type - The lowercase event type (`'click'`)
 * @param handler - The handler to invoke
 *
 * @internal Compiler-emitted runtime; not part of the application API.
 */
export function bindEvent(el: HTMLElement, type: string, handler: EventListener): void
{
    if (isDelegatedEvent(type))
    {
        delegateEvent(el, type, handler);
        return;
    }
    el.addEventListener(type, handler);
}

/**
 * Drives a control-flow / component SLOT in a template clone: inserts the
 * component's already-built output (`result` - a co-range fragment for built-ins,
 * an element/fragment for user components, or `null` when it renders nothing) at
 * the slot's marker position, then removes the marker. The component manages its
 * own reactivity and co-range internally, so the slot is a one-time placement -
 * the analog of {@link bindHole} for a `slot` node rather than a `hole`.
 * A fragment is moved in directly (no display:contents
 * wrapper), keeping control-flow output valid inside `<table>`/`<select>`/`<ul>`.
 *
 * @param marker - The slot's placeholder comment inside a template clone
 * @param result - The component invocation's return value
 *
 * @internal Compiler-emitted runtime; not part of the application API.
 */
export function bindSlot(marker: ChildNode, result: Node | null | undefined): void
{
    const parent = marker.parentNode as Node;
    if (result !== null && result !== undefined)
    {
        parent.insertBefore(result, marker);
    }
    parent.removeChild(marker);
}

/**
 * Drives a reactive hole bounded by a `<!--[-->...<!--]-->` anchor range: runs
 * `child` as an effect and patches the nodes between the (already-consumed) open
 * anchor and `closeAnchor` in place. Shared by {@link bindHole} (fresh template
 * clone - the range starts empty) and {@link adoptReactiveHole} (hydration - the
 * range starts filled with server content). On the first run it keeps matching
 * server text (no flash, node identity preserved); later runs swap or patch in
 * place exactly like the DOM reactive-child path.
 *
 * @internal
 */
function driveHoleRange(parent: Node, closeAnchor: ChildNode, content: ChildNode[], child: () => unknown): void
{
    // The hole's live anchor node: the single primitive text node in the common
    // case. Extra nodes (an array-valued hole) are removed the first time the
    // value is materialised as a real node.
    let currentNode: ChildNode | null = content[0] ?? null;
    let extras: ChildNode[] = content.slice(1);

    createEffect(() =>
    {
        let localDispose: DisposeFn | undefined;
        try
        {
            const value = createRoot((d) =>
            {
                localDispose = d;
                return resolveReactive(child);
            });

            // Primitive into the existing text node. The dominant case: a
            // `() => `Count: ${ n() }`` hole. Keep the node and only touch `.data`
            // when it differs, so an adopted run that already matches is a no-op.
            if (currentNode !== null && currentNode.nodeType === 3 && isPrimitiveValue(value))
            {
                const text = primitiveToText(value);
                if ((currentNode as Text).data !== text)
                {
                    (currentNode as Text).data = text;
                }
                localDispose?.();
                return;
            }

            // Materialise and swap: element/array values, an initially-empty hole,
            // or a text/element transition. Drop any extra adopted siblings first,
            // then replace (or insert before the close anchor when the range is
            // empty).
            for (const extra of extras)
            {
                if (extra.parentNode === parent)
                {
                    parent.removeChild(extra);
                }
            }
            extras = [];

            // An array value renders its items as DIRECT children before the close anchor (see
            // insertArrayChildren) - the range can hold any number of nodes, so unlike the single-node
            // binding above no placeholder is needed for an empty array.
            if (Array.isArray(value))
            {
                const nodes = insertArrayChildren(parent, value, currentNode ?? closeAnchor);
                if (currentNode !== null)
                {
                    if (currentNode instanceof HTMLElement)
                    {
                        destroyComponent(currentNode);
                    }
                    parent.removeChild(currentNode);
                }
                currentNode = nodes[0] ?? null;
                extras = nodes.slice(1);
                return () =>
                {
                    localDispose?.();
                    destroyNodes(nodes);
                };
            }

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
                localDispose?.();
                if (nextNode instanceof HTMLElement)
                {
                    destroyComponent(nextNode);
                }
            };
        }
        catch (error)
        {
            // resolveReactive()/buildNode() threw: dispose THIS run's root so its
            // effects don't orphan, then let the error reach the boundary.
            localDispose?.();
            throw error;
        }
    });
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

        // Move any symbol-keyed teardown hooks the descriptor carried onto the
        // real element, so destroyComponent() finds them on the live node after
        // hydration.
        transferCarriedSymbols(node, el);

        const childCursor = new HydrationCursor(el);
        for (const child of children)
        {
            hydrateChild(child, childCursor);
        }

        // Every server child must be accounted for; a leftover means the server
        // rendered more than this element's tree expects (a mismatch take* can't
        // see). hydrate() turns this into its dev-warn + client-render fallback.
        childCursor.assertExhausted(`<${ tag }>`);
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
 *
 * @internal Framework plumbing (used by the control-flow components and the
 * router); not part of the application API.
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
        adoptReactiveHole(child, cursor);
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
    driveHoleRange(cursor.parent, closeAnchor, content, child);
}
