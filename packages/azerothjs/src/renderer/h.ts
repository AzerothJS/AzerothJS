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
import type { DisposeFn } from '../reactivity/index.ts';
import type { HydrationNode, HydrationCursor as HydrationCursorType } from '../reactivity/internal.ts';
import { createEffect, createRoot, isStringMode, isHydrating } from '../reactivity/index.ts';
import { hydrationNode, isHydrationNode, HydrationCursor, transferCarriedSymbols, resolveThunks } from '../reactivity/internal.ts';
import { destroyComponent } from '../component/index.ts';
import { serializeElement, assertSafeAttribute, assertSafeTag } from './ssr.ts';
import { attachEvent } from './delegate.ts';
import {
    hostEventType,
    isReservedHostAttribute,
    isEventNamespace,
    refValueMessage,
    reservedHostAttributeMessage,
    contentChildrenMessage,
    voidChildrenMessage,
    CONTENT_PROPERTIES,
    DOM_PROPERTIES,
    VOID_ELEMENTS
} from '../semantics.ts';

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
 * - props: attributes, handler-form event handlers (`onClick`; the reserved lowercase
 *   spellings of the on* namespace are refused), DOM properties, and `ref`. A FUNCTION value
 *   on a non-event key is a reactive attribute (re-applied in an effect); `ref` is a callback
 *   or a createRef object.
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
 * eagerly binds it once. Event handlers follow the language's single attachment model
 * (see semantics DELEGATED_EVENTS): bubbling types share one document listener per type,
 * identical for h(), compiled markup, and hydration.
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
export function h(tag: string, props: Props | null, ...children: Child[]): HTMLElement
{
    // null is the conventional "no props" spelling (createElement muscle memory, and the natural
    // shape for element-only nodes). Normalized ONCE here so every path below - including
    // string-mode serialization, which iterates entries - sees an object.
    const properties = props ?? {};

    // Ahead of the mode dispatch, so an executable tag is refused identically whether it would
    // be serialized, adopted, or built. Returns the concrete name (an unsafeTag() marker is not
    // a string), which is what every mode below builds with.
    const tagName = assertSafeTag(tag, properties);

    // Structural rules, also ahead of the dispatch so all three modes accept the same calls:
    // a void element owns no content, and a content property owns ALL of it.
    if (VOID_ELEMENTS.has(tagName) && hasRenderableChildren(children))
    {
        throw new TypeError(voidChildrenMessage(tagName));
    }
    for (const contentProp of CONTENT_PROPERTIES)
    {
        if (Object.hasOwn(properties, contentProp) && hasRenderableChildren(children))
        {
            throw new TypeError(contentChildrenMessage(contentProp));
        }
    }

    // Server-side rendering: in string mode there is no document, so emit HTML
    // directly. The SSRNode is cast to HTMLElement so it flows through
    // composition (parent h() calls, control-flow children) exactly like a real
    // element would in the DOM path.
    if (isStringMode())
    {
        return serializeElement(tagName, properties, children) as unknown as HTMLElement;
    }

    // Hydration: don't build DOM. Return a descriptor that, when walked by
    // hydrate(), adopts the matching server-rendered element in place.
    if (isHydrating())
    {
        return createHydrationNode(tagName, properties, children) as unknown as HTMLElement;
    }

    // DOM-build path (not the compiled hot path - that clones tmpl()). A missing `document` here
    // means the tree is being built OUTSIDE string mode on the server - almost always
    // `renderToString(App())` where the `() =>` thunk was forgotten, so App() ran and reached h()
    // before string mode was active. Name that instead of the raw "document is not defined".
    if (typeof document === 'undefined')
    {
        throw new ReferenceError(`h(<${ tagName }>) needs a DOM, but \`document\` is undefined. On the server, `
            + 'render with a THUNK - renderToString(() => App(props)) - so the tree builds in string mode; '
            + 'building it eagerly (renderToString(App())) runs h() against a missing DOM.');
    }

    const el = createElementByTag(tagName);

    applyProps(el, properties);

    appendChildren(el, children);

    return el;
}

/**
 * Applies properties, attributes, and event handlers to a DOM element.
 * Dispatches each prop by the language's name-domain rules: ref, handler-form
 * event (via the shared attachment model), reactive attribute (function value),
 * or static attribute. Reserved on* names are refused - the same rule the
 * compiler and the serializer enforce, so no entry path accepts them.
 *
 * @param el - The real DOM element to apply props to
 * @param props - The props object passed to h()
 *
 * @internal
 */
function applyProps(el: HTMLElement, props: Props): void
{
    // for...in over Object.entries: this runs once per element created, and
    // entries() allocates an array of [key, value] tuples each call.
    for (const key in props)
    {
        // for...in also walks INHERITED enumerable keys, so a single prototype-pollution
        // gadget (`Object.prototype.onclick = '...'`) would inject its attribute onto every
        // element ever created. Own properties only, matching the serializer's Object.entries.
        if (!Object.hasOwn(props, key))
        {
            continue;
        }

        const value = props[key];
        // `ref` is never a DOM attribute: it hands the freshly-created element
        // back to the caller. Must run before the reactive-function branch
        // below, or a ref callback would be mistaken for a reactive attribute.
        if (key === 'ref')
        {
            applyRef(el, value);
            continue;
        }

        const eventType = hostEventType(key);
        if (eventType !== null)
        {
            attachEvent(el, eventType, value);
            continue;
        }
        if (isReservedHostAttribute(key))
        {
            throw new TypeError(reservedHostAttributeMessage(key));
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
export const resolveReactive: (value: unknown) => unknown = resolveThunks;

/**
 * Wires up a `ref` prop, handing the created element back to the caller.
 * Supports two forms:
 *
 *   - A ref object from `createRef()` -> sets its `.current`.
 *   - A callback `(el) => void` -> invoked with the element.
 *
 * Anything else is ignored; a ref is never rendered as an attribute.
 *
 * TIMING: the ref fires at CONSTRUCTION, before the element is inserted into the
 * document - layout reads here return zeros and connection-dependent widgets fail.
 * Capture the element in the ref, do connected-time work in `onMount` (reactivity),
 * which runs once the synchronous render has finished inserting.
 *
 * @param el - The freshly-created DOM element
 * @param ref - The value passed as the `ref` prop
 *
 * @internal
 */
function applyRef(el: HTMLElement, ref: unknown): void
{
    // The handler-value convention holds for refs too: null/undefined/false are "no ref",
    // so a conditional ref (`ref={ open && cb }`) needs no ternary - and anything else
    // throws the same rule text the serializer uses, so no mode accepts a program another
    // refuses. attachEvent is the pattern being mirrored.
    if (ref === null || ref === undefined || ref === false)
    {
        return;
    }
    if (typeof ref === 'function')
    {
        (ref as (element: HTMLElement) => void)(el);
        return;
    }
    if (typeof ref === 'object' && 'current' in ref)
    {
        (ref as { current: HTMLElement | null }).current = el;
        return;
    }
    throw new TypeError(refValueMessage(typeof ref));
}

/**
 * Sets a single property or attribute on a DOM element, routing by name:
 *   - DOM properties -> set directly (el.value = x)
 *   - false/null/undefined -> remove attribute
 *   - true -> set empty attribute (disabled="")
 *   - everything else -> setAttribute(key, String(value))
 *
 * Every attribute write is gated by the same {@link assertSafeAttribute} policy the SSR
 * serializer enforces: an invalid NAME throws the framework's error instead of letting
 * setAttribute abort the render with a bare InvalidCharacterError, and a non-function
 * `on*` VALUE throws instead of being written as a live inline handler. The throw is
 * deliberate (not a drop-and-warn): the serializer already fails loud for the identical
 * input, and a divergence between the two paths would let the same props render on one
 * side and vanish on the other.
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

    assertSafeAttribute(key, value, el.tagName);

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
 * Whether a children list contains anything that would render: nullish and `false`
 * entries are skip markers in every mode, so a list of only those is "no children"
 * for the structural rules h() enforces before dispatch.
 *
 * @internal
 */
function hasRenderableChildren(children: readonly Child[]): boolean
{
    for (const child of children)
    {
        if (child === null || child === undefined || child === false)
        {
            continue;
        }
        if (Array.isArray(child))
        {
            if (hasRenderableChildren(child))
            {
                return true;
            }
            continue;
        }
        return true;
    }
    return false;
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
 * Materialises a MULTI-NODE reactive value - an array (`{ items().map(...) }`) or a DocumentFragment
 * (a `<For>`, or a branch's node group) - as DIRECT siblings in front of `anchor`, never inside a
 * wrapper element. A `display:contents` wrapper would be ignored by `<select>`'s option model, break
 * `<table>` row parsing, and be invalid inside `<ul>`/`<svg>`, so the value's nodes must be direct
 * children of the real parent. The items are built into the live parent first (so any reactive binding
 * inside an item anchors to that real parent, not a throwaway fragment), then moved into place. A `null`
 * anchor appends (the anchor-free only-child case, where the element itself bounds the range). Returns
 * the inserted nodes in order - the ONE multi-node materialiser every reactive-hole driver shares.
 *
 * @internal
 */
function spliceMultiNode(parent: Node, value: unknown, anchor: ChildNode | null): ChildNode[]
{
    const start = parent.childNodes.length;
    if (value instanceof DocumentFragment)
    {
        // A fragment empties into the parent on append, so its children become direct children with
        // no wrapper - the same guarantee the array branch gives, for a `<For>`/branch node group.
        parent.appendChild(value);
    }
    else
    {
        appendChildren(parent as HTMLElement, value as Child[]);
    }
    const nodes = Array.prototype.slice.call(parent.childNodes, start) as ChildNode[];
    // Anchor-free (append) case: appendChildren already left the nodes in order at the parent's tail,
    // which IS where an anchor-free hole wants them - so skip the reposition loop, which would otherwise
    // re-append each node (N redundant insertBefore calls) for no change in order. A real anchor needs
    // the nodes moved into the range before it.
    if (anchor !== null)
    {
        for (const node of nodes)
        {
            parent.insertBefore(node, anchor);
        }
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

        // Multi-node value (array OR fragment): render its nodes as DIRECT siblings of currentNode (no
        // `display:contents` wrapper), so a reactive list or a reactively-returned `<For>` is valid
        // inside `<select>`/`<table>`/`<ul>`/`<svg>`. An empty value still holds the slot with an empty
        // text node so `currentNode` stays a real node.
        if (Array.isArray(value) || value instanceof DocumentFragment)
        {
            // Render the nodes as direct siblings in this binding's slot. An empty value keeps the slot
            // with an empty text node so `currentNode` stays a real node (this binding's invariant).
            let nodes = spliceMultiNode(parent, value, currentNode);
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
 * Coerces a SINGLE-node reactive value (a scalar, an element, or any other DOM node) into one
 * ChildNode, for the reactive-child path to swap in place. MULTI-node values - arrays and
 * DocumentFragments - are NOT this function's job: every caller special-cases them through
 * {@link spliceMultiNode} first (direct children, no wrapper), so an array/fragment never reaches
 * here. This keeps a single honest contract - one value in, one node out - with no `display:contents`
 * wrapper smuggling N nodes past a single-node interface.
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
 * does at creation. Compiled `dom`-target code calls this on cloned nodes;
 * the dispatch (and the event-attachment model) is byte-identical to h()'s.
 *
 * @param el - The element inside a template clone
 * @param props - The dynamic props the compiler collected for it
 *
 * @internal Compiler-emitted runtime; not part of the application API.
 */
export function bindProps(el: HTMLElement, props: Props): void
{
    applyProps(el, props);
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

    // Static (non-function) child, placed once. A MULTI-node value (array or fragment) must go in as
    // DIRECT children before the close anchor - the same treatment the reactive path gives - because
    // buildNode coerces a SINGLE node only; passing it an array would stringify it (`[object ...]`).
    if (Array.isArray(child) || child instanceof DocumentFragment)
    {
        spliceMultiNode(parent, child, closeAnchor);
    }
    else
    {
        parent.insertBefore(buildNode(child), closeAnchor);
    }
    parent.removeChild(openAnchor);
    parent.removeChild(closeAnchor);
}

/**
 * Drives a hole that is its element's ONLY child (`<td>{ expr }</td>`): the element itself bounds the
 * content, so no anchor pair exists in the clone. A reactive child is driven by the shared
 * {@link driveHoleRange} with a `null` close anchor - the element IS the range (insert = append, clear =
 * the whole element) - so an only-child hole gets the exact same scalar fast-path, multi-node
 * direct-children rendering (arrays and `<For>` fragments, NO `display:contents` wrapper), swap
 * teardown, and component-destroy hooks as an anchored hole. A static (non-function) child is placed
 * once with no effect at all.
 *
 * @param el - The element whose entire content the hole owns
 * @param child - The hole's value: a getter for a reactive hole, or the value itself
 *
 * @internal Compiler-emitted runtime; not part of the application API.
 */
export function bindContent(el: HTMLElement, child: Child): void
{
    if (typeof child === 'function')
    {
        driveHoleRange(el, null, [], child);
        return;
    }

    placeStatic(el, child);
}

/**
 * Places a STATIC only-child value into `el` once, with no effect: a multi-node value (array or
 * fragment) as direct children (no wrapper), anything else as one coerced node.
 *
 * @internal
 */
function placeStatic(el: HTMLElement, value: unknown): void
{
    if (Array.isArray(value) || value instanceof DocumentFragment)
    {
        spliceMultiNode(el, value, null);
        return;
    }

    el.appendChild(buildNode(value));
}

/**
 * Wires one event handler through the language's single attachment model - the
 * same {@link attachEvent} h(), spreads, and hydration use, including its
 * handler-value rule (nullish is a no-op, any other non-function throws).
 *
 * @param el - The element the handler belongs to
 * @param type - The lowercase event type (`'click'`)
 * @param handler - The handler to invoke
 *
 * @internal Compiler-emitted runtime; not part of the application API.
 */
export function bindEvent(el: HTMLElement, type: string, handler: unknown): void
{
    attachEvent(el, type, handler);
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
 * Whether a reactive value carries hydration descriptors: a {@link HydrationNode}, or an
 * array containing one (holes may return `[<a/>, 'text', count()]`). During a hydration
 * first run these must be ADOPTED against the server content, not coerced by buildNode -
 * which would stringify the descriptor to `[object Object]`.
 *
 * @internal
 */
function containsHydrationNode(value: unknown): boolean
{
    if (isHydrationNode(value))
    {
        return true;
    }

    return Array.isArray(value) && value.some(containsHydrationNode);
}

/**
 * Drives a reactive hole and patches its content in place as `child` re-runs. The range is bounded
 * by `closeAnchor`: a `<!--]-->` comment for an anchored hole, or `null` for the anchor-free only-child
 * case, where the ELEMENT itself bounds the content (insert = append, so the whole element is the
 * range). This is the ONE reactive-hole driver, shared by {@link bindHole} (fresh template clone -
 * range starts empty), {@link bindContent} (anchor-free, `closeAnchor` null), and
 * {@link adoptReactiveHole} (hydration - range starts filled with server content). Scalars patch the
 * existing text node in place (no flash, node identity preserved); multi-node values (arrays and
 * fragments) render as direct children via {@link spliceMultiNode}; single element/node values swap.
 *
 * When `hydrating`, the FIRST effect run adopts the server content: a hole that returns element/list
 * markup evaluates to hydration descriptors (h() runs in hydrate mode), which are claimed against the
 * server nodes via {@link hydrateChild} instead of being rebuilt. A primitive hole skips adoption and
 * reuses the server text node through the scalar fast-path. Later runs behave like the DOM path.
 *
 * @internal
 */
function driveHoleRange(parent: Node, closeAnchor: ChildNode | null, content: ChildNode[], child: () => unknown, hydrating = false): void
{
    // The hole's live anchor node: the single primitive text node in the common
    // case. Extra nodes (an array-valued hole) are removed the first time the
    // value is materialised as a real node.
    let currentNode: ChildNode | null = content[0] ?? null;
    let extras: ChildNode[] = content.slice(1);
    let firstRun = hydrating;

    createEffect(() =>
    {
        let localDispose: DisposeFn | undefined;
        try
        {
            const value = createRoot((d) =>
            {
                localDispose = d;
                const resolved = resolveReactive(child);
                // Hydration first run: an element/list hole built HydrationNode descriptors in
                // hydrate mode. Adopt the server content between the anchors here (inside this run's
                // root, so the listeners/effects the descriptors wire are owned and torn down on
                // swap) rather than letting buildNode stringify the descriptor to `[object Object]`.
                if (firstRun && containsHydrationNode(resolved))
                {
                    const cursor = new HydrationCursor(parent, content);
                    hydrateChild(resolved as Child, cursor);
                    cursor.assertExhausted('reactive hole');
                }
                return resolved;
            });

            if (firstRun)
            {
                firstRun = false;
                if (containsHydrationNode(value))
                {
                    // The adopted server nodes ARE this binding's live range; later runs swap/patch
                    // them. Teardown disposes the run's effects and fires destroy hooks; the next
                    // run removes the nodes via the currentNode/extras logic (as the DOM path does).
                    currentNode = content[0] ?? null;
                    extras = content.slice(1);
                    return () =>
                    {
                        localDispose?.();
                        destroyNodes(content);
                    };
                }
            }

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

            // A multi-node value (array OR fragment) renders its nodes as DIRECT children before the
            // close anchor (or appended, when closeAnchor is null - see spliceMultiNode) - the range
            // holds any number of nodes, so unlike the single-node binding above no placeholder is
            // needed for an empty value.
            if (Array.isArray(value) || value instanceof DocumentFragment)
            {
                const nodes = spliceMultiNode(parent, value, currentNode ?? closeAnchor);
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

            // A nullish value (null/undefined/false) renders NOTHING. Keep the range genuinely empty
            // rather than inserting a stray empty text node: the element then matches its SSR/hydrated
            // form (an empty marker range) and an anchor-free only-child stays `:empty`. Drop any current
            // node; the next real value re-inserts. (The primitive fast-path above already handles the
            // string->nullish case by reusing the existing text node, so this only fires when the current
            // slot is empty or holds a non-text node.)
            if (value === null || value === undefined || value === false)
            {
                if (currentNode !== null)
                {
                    if (currentNode instanceof HTMLElement)
                    {
                        destroyComponent(currentNode);
                    }
                    parent.removeChild(currentNode);
                    currentNode = null;
                }
                localDispose?.();
                return;
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
 * Removes every `on*` ATTRIBUTE from an element adopted from server markup. Adoption writes
 * the client's props over the server's node and keeps everything else, so an attribute the
 * server HTML carried and the client does not re-write survives onto the live page - and an
 * `on*` attribute is a live handler. The client never legitimately sets one (a function handler
 * goes through addEventListener; a string one is refused by {@link assertSafeAttribute}), so an
 * `on*` attribute on a server node was injected into the markup, never rendered by this
 * framework. Hydration only: a freshly created element cannot carry an attribute nobody set.
 *
 * @internal
 */
function stripEventAttributes(el: HTMLElement): void
{
    // getAttributeNames() returns a snapshot array, so removing during the walk is safe.
    for (const name of el.getAttributeNames())
    {
        if (isEventNamespace(name))
        {
            el.removeAttribute(name);
        }
    }
}

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

        stripEventAttributes(el);

        applyProps(el, props);

        // Move any symbol-keyed teardown hooks the descriptor carried onto the
        // real element, so destroyComponent() finds them on the live node after
        // hydration.
        transferCarriedSymbols(node, el);

        // `innerHTML`/`textContent` OWN the element's content: the server rendered it from the
        // prop (raw HTML, or an escaped text node), not from child descriptors. applyProps above
        // already re-applied the prop onto the live element, so its content is correct - walking
        // the children (there are none) would (correctly) find the server-rendered content
        // unclaimed and trip the whole-page fallback. Skip the child walk.
        if ('innerHTML' in props || 'textContent' in props)
        {
            return;
        }

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
    driveHoleRange(cursor.parent, closeAnchor, content, child, true);
}
