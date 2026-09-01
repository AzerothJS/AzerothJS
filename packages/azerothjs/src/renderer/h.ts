/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The hyperscript core. h() builds real DOM directly: no virtual DOM, no intermediate
 * nodes, no diffing. It returns a live element and wires reactive effects immediately, so a
 * signal change mutates that node in place rather than re-rendering a subtree.
 *
 * This module also hosts the shared child and attribute machinery, the compiler-emitted
 * runtime (setProp, bindProps, bindHole, bindSlot) and the hydration adopters. All three
 * render modes - build, serialize, adopt - funnel through here.
 *
 * Attributes seed initial state; DOM properties carry live state. An `<input>`'s
 * `el.value` and its `value` attribute are different things, so some props must be assigned
 * as properties rather than set as attributes. See DOM_PROPERTIES.
 */

import type { Props, Child } from './types.ts';
import type { DisposeFn } from '../reactivity/index.ts';
import type { HydrationNode, HydrationCursor as HydrationCursorType } from '../reactivity/internal.ts';
import { createEffect, createRoot, isStringMode, isHydrating, onRootDispose, untrack } from '../reactivity/index.ts';
import { hydrationNode, isHydrationNode, HydrationCursor, HydrationMismatchError, transferCarriedSymbols, resolveThunks } from '../reactivity/internal.ts';
import { destroyComponent } from '../component/index.ts';
import { isSlotHandle, slotDriverOf, refuseSlotHandle } from '../reactivity/slot-handle.ts';
import { serializeElement, assertSafeAttribute, assertSafeTag, isAriaBoolean } from './ssr.ts';
import type { PeerAttr } from './ssr.ts';
import { writeSelectValue, settleSelectValue } from './select-value.ts';
import { attachEvent } from './delegate.ts';
import { isChildResolvedProperty } from '../semantics.ts';
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
import { createElementByTag } from './namespace.ts';

/**
 * Creates a real DOM element with the given props and children, wiring every reactive prop
 * and child to an effect that updates the node in place. This is both the manual element
 * API and the runtime target the compiler lowers markup to.
 *
 * REACTIVITY IS BY FUNCTION. A function value on a non-event prop is a reactive attribute,
 * and a function child is a reactive hole; passing a value eagerly binds it once and it
 * never updates again. A reactive child patches a text node's data in place where it can
 * and rebuilds only when the value's shape changes, and each one runs in its own root, so
 * nested effects are owned and torn down on swap.
 *
 * Children may be elements, strings, numbers, arrays, or functions. `null`, `undefined` and
 * `false` render nothing, which is what makes `cond && <x/>` work. A DocumentFragment child
 * - how `<For>` returns its rows - is moved in directly, so the rows become this element's
 * own children with no wrapper.
 *
 * Event handlers use the language's single attachment model: bubbling types share one
 * document listener per type, identically for h(), compiled markup and hydration.
 *
 * The call is mode-dispatched. In string mode it serializes to HTML with no document; in
 * hydrate mode it returns a descriptor that adopts the matching server node. Both are cast
 * to HTMLElement so they compose exactly like a built element.
 *
 * @param tag - An HTML tag name.
 * @param props - Attributes, `on*` handlers, DOM properties, and `ref`, which takes a
 *                callback or a ref object. Pass null for none.
 * @param children - Zero or more children to append.
 * @returns The element, with every binding already active.
 * @throws {Error} If the tag or an attribute is refused by the safety rules - an executable
 *                 tag, a reserved lowercase `on*` spelling, children on a void element, or
 *                 children alongside a content property.
 * @example
 * h('div', { class: () => isActive() ? 'on' : 'off' },
 *     h('span', {}, () => `Count: ${ count() }`),
 *     h('button', { onClick: () => setCount(n => n + 1) }, 'Inc')
 * );
 *
 * @see {@link Show} and {@link For} for control flow, which manage mounting, disposal and
 *      the SSR markers h() does not.
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

    // The element's own children are in place, so a <select value> written above can apply. This
    // is targeted at THIS element: a global walk here would cost O(tracked selects) per element.
    settleSelectValue(el);

    return el;
}

/**
 * Dispatches each prop by the language's name-domain rules: ref, handler-form event,
 * reactive attribute, or static attribute. Reserved `on*` names are refused here exactly as
 * the compiler and the serializer refuse them, so no entry path accepts one.
 *
 * @internal
 */
function applyProps(el: HTMLElement, props: Props): void
{
    // Untracked: reading a sibling to JUDGE a write must not subscribe the writing effect to
    // it, which would re-run this attribute whenever an unrelated one changed.
    const peer = (attr: string): unknown =>
    {
        const raw = props[attr];
        return typeof raw === 'function' ? untrack(() => resolveReactive(raw)) : raw;
    };

    // for...in rather than Object.entries: this runs once per element created, and entries()
    // allocates an array of tuples each call.
    for (const key in props)
    {
        // for...in also walks INHERITED enumerable keys, so one prototype-pollution gadget
        // (`Object.prototype.onclick = '...'`) would inject its attribute onto every element ever
        // created. Own properties only, matching the serializer.
        if (!Object.hasOwn(props, key))
        {
            continue;
        }

        const value = props[key];
        // `ref` is never a DOM attribute: it hands the element back to the caller. Must run
        // before the reactive-function branch below, or a ref callback would be mistaken for a
        // reactive attribute.
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

        if (typeof value === 'function')
        {
            createEffect(() =>
            {
                const resolved = resolveReactive(value);
                setProperty(el, key, resolved, peer);
            });
            continue;
        }

        setProperty(el, key, value, peer);
    }
}

/**
 * Calls a reactive value while it is still a function, down to a concrete result.
 *
 * One `() =>` wrapper is the common case, but some wrapped expressions already evaluate to
 * a getter themselves - `classList()` returns `() => string`, and `{ p.title }` where
 * `p.title` is a getter compiles to `() => (p.title)`. Calling once would hand the inner
 * function to setProperty or buildNode, which stringify it, rendering source text into the
 * DOM.
 *
 * Reads happen inside the caller's effect, so every signal touched on the way down is
 * tracked and the binding stays fine-grained.
 *
 * @internal
 */
export const resolveReactive: (value: unknown) => unknown = resolveThunks;

/**
 * Hands the created element back to the caller, through a ref object's `.current` or a
 * callback. A ref is never rendered as an attribute.
 *
 * It fires at CONSTRUCTION, before the element is inserted, so layout reads here return
 * zeros and connection-dependent widgets fail. Capture the element in the ref and do
 * connected-time work in onMount, which runs once the synchronous render has inserted it.
 *
 * @internal
 */
function applyRef(el: HTMLElement, ref: unknown): void
{
    // The handler-value convention holds for refs too: null, undefined and false all mean "no
    // ref", so a conditional ref needs no ternary. Anything else throws the same rule text the
    // serializer uses, so no mode accepts a program another refuses.
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
function setProperty(el: HTMLElement, key: string, value: unknown, peer: PeerAttr): void
{
    if (DOM_PROPERTIES.has(key))
    {
        // `<select>.value` cannot simply be assigned: with no matching <option> yet the write is a
        // silent no-op, so it is parked and re-tried when children arrive. See select-value.ts.
        if (isChildResolvedProperty(key, el.localName))
        {
            writeSelectValue(el as HTMLSelectElement, value);
            return;
        }
        (el as unknown as Record<string, unknown>)[key] = value;
        // An <option>'s value is what RESOLVES its select's value, and `value` is a DOM PROPERTY
        // here - a property assignment produces no mutation record, so no MutationObserver of any
        // kind can see it. Changing an existing option's value in place therefore left the select
        // showing a stale selection while SSR, which reads the values directly, disagreed. This is
        // the seam: the framework knows it just changed the resolving input, so it settles the
        // owning select. `closest` returns null while the option is still detached, and the
        // select's own childList observer covers that case when it attaches.
        if (key === 'value' && el.localName === 'option')
        {
            // Walked explicitly rather than with `closest('select')`: an option's only valid
            // parents are <select>, <optgroup>, and <datalist>, so this is exact - and `closest`
            // is not reliable across the DOM implementations the suite runs on.
            const parent = el.parentElement;
            const owner = parent === null ? null
                : parent.localName === 'select' ? parent
                    : parent.localName === 'optgroup' ? parent.parentElement : null;
            settleSelectValue(owner);
        }
        return;
    }

    assertSafeAttribute(key, value, el.tagName, peer);

    // ARIA booleans are STRINGS, not HTML boolean attributes - see isAriaBoolean.
    if (isAriaBoolean(key, value))
    {
        el.setAttribute(key, String(value));
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
    setProperty(el, name, resolveReactive(value), (attr) => el.getAttribute(attr));
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
/**
 * Appends ONE child, normalising every shape the renderer can produce: an array (a
 * fragment), a getter (a reactive text node), any DOM node, a slot handle, or a primitive
 * (a text node). Exported because the ROOT append in `render` must use this same routine -
 * a fragment-rooted component returns the array form, whose static text children are plain
 * strings, and a hand-rolled root loop that only knew about Nodes crashed on them.
 *
 * @internal
 */
export function appendChild(parent: HTMLElement | DocumentFragment, child: Child): void
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

    // A route slot handle placed in a hand-written h() tree: it places its own markers
    // and effect. Checked before the coercion fallback, which would stringify it.
    if (isSlotHandle(child))
    {
        slotDriverOf(child).place(parent, null);
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
        // A LITERAL handle among a reactive array's members would place, but the hole
        // then owns the slot's markers as plain disposable nodes: the next swap strands
        // the segment's root and leaves the handle claimed forever. Refused (DEV throw,
        // prod warn); a getter member resolving to a handle is fine - it gets its own
        // binding with full slot support.
        refuseArraySlotMembers(value as readonly unknown[]);
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

/** Refuses LITERAL slot handles among a reactive array's members, recursively. @internal */
function refuseArraySlotMembers(children: readonly unknown[]): void
{
    for (const child of children)
    {
        if (Array.isArray(child))
        {
            refuseArraySlotMembers(child);
        }
        else if (isSlotHandle(child))
        {
            refuseSlotHandle(child, 'a reactive array value',
                'Place the slot directly ({ props.children }), not inside an array the hole rebuilds.');
        }
    }
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

    // A route slot handle this binding currently has PLACED (a hand-written conditional
    // outlet, `() => cond() ? props.children : <span/>`). Held OUTSIDE the per-run roots:
    // a same-handle re-resolution must be a no-op (the live-placement rule), and only a
    // genuine handle <-> non-handle transition disposes or places. The empty text node
    // stays as the binding's anchor; the slot's markers live in front of it.
    let placedSlot: { handle: object; dispose: DisposeFn } | null = null;
    onRootDispose(() =>
    {
        placedSlot?.dispose();
        placedSlot = null;
    });

    /** One update of this reactive child; returns this run's cleanup, if it registered one. */
    function update(): (() => void) | undefined
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

        // Route slot handle resolved by a hand-written reactive child - the appendChild
        // analog of driveHoleRange's branded branch (EVERY writer carries
        // the dispatch; without this the coercion below renders '[object Object]').
        if (isSlotHandle(value))
        {
            if (placedSlot !== null && placedSlot.handle === value)
            {
                localDispose();
                return;
            }
            placedSlot?.dispose();
            placedSlot = null;
            for (const extra of extras)
            {
                if (extra.parentNode === parent)
                {
                    parent.removeChild(extra);
                }
            }
            extras = [];
            // Reset the binding's anchor to an empty text node; the slot places its
            // marker pair (and content) immediately in front of it.
            if (currentNode.nodeType !== 3 || (currentNode as Text).data !== '')
            {
                const placeholder = document.createTextNode('');
                parent.replaceChild(placeholder, currentNode);
                if (currentNode instanceof HTMLElement)
                {
                    destroyComponent(currentNode);
                }
                currentNode = placeholder;
            }
            let slotDispose: DisposeFn = () => undefined;
            createRoot((dispose) =>
            {
                slotDispose = dispose;
                slotDriverOf(value).place(parent, currentNode);
            });
            placedSlot = { handle: value, dispose: slotDispose };
            localDispose();
            // NO per-run cleanup: it would run before every re-run and tear the
            // placement down under a same-handle re-resolution. Final teardown is the
            // onRootDispose above; a handle -> non-handle transition disposes in-body.
            return;
        }
        if (placedSlot !== null)
        {
            // handle -> non-handle: dispose the placement (re-arms the handle), then
            // fall through to render the new value normally.
            placedSlot.dispose();
            placedSlot = null;
        }

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
    }

    createEffect(update);
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

    // A route slot handle passes THROUGH: this function has no position data (one value
    // in, one node out), so the caller's appendToCo performs the actual placement - the
    // dispatch stays single-sited. The cast is the pass-through, not a coercion.
    if (isSlotHandle(value))
    {
        return value as unknown as Node;
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
    // A compiled <Outlet/> returns the route slot handle; it places its own markers and
    // effect at the slot position. Today's bare insertBefore would throw on a non-Node.
    if (isSlotHandle(result))
    {
        slotDriverOf(result).place(parent, marker);
    }
    else if (result !== null && result !== undefined)
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
function driveHoleRange(parent: Node, closeAnchor: ChildNode | null, content: ChildNode[], child: () => unknown, hydrating = false, adoptedSlot: unknown = null, adoptedSlotDispose: DisposeFn | null = null): void
{
    // The hole's live anchor node: the single primitive text node in the common
    // case. Extra nodes (an array-valued hole) are removed the first time the
    // value is materialised as a real node.
    let currentNode: ChildNode | null = content[0] ?? null;
    let extras: ChildNode[] = content.slice(1);
    let firstRun = hydrating;

    // A route slot handle the hole currently has PLACED. Held OUTSIDE the per-run root:
    // a re-run that resolves the SAME handle must be a no-op (the live-placement rule
    // forbids re-placement while live), and only a genuine handle <-> non-handle
    // transition disposes or places. `adoptedSlot` seeds this for a hydrated slot-hole
    // whose range the adoption walk already claimed (the consumed first run below then
    // only re-reads to establish subscriptions and record the value).
    let placedSlot: { handle: object; dispose: DisposeFn } | null = null;
    let consumeFirstRun = false;
    if (adoptedSlot !== null && isSlotHandle(adoptedSlot))
    {
        // The REAL disposer (the root adoptSlotHole wrapped the adoption in): without
        // it a later handle -> non-handle transition cannot tear the adopted placement
        // down, and the old range survives beside the new value.
        placedSlot = { handle: adoptedSlot, dispose: adoptedSlotDispose ?? ((): void => undefined) };
        consumeFirstRun = true;
        firstRun = false;
    }

    // Final teardown for a placed slot: registered on the hole's OWNING scope (not as a
    // per-run cleanup, which fires before every re-run and would tear the placement down
    // under a same-handle re-resolution).
    onRootDispose(() =>
    {
        placedSlot?.dispose();
        placedSlot = null;
    });

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

            // Route slot handle resolved by the hole (a conditional outlet,
            // `{ cond() ? props.children : fallback }`). Same handle as the live
            // placement: nothing to do. Otherwise: clear whatever the hole holds, place
            // the handle's markers + segment in the hole's range, and record it; the
            // handle -> non-handle direction below disposes the placement (which re-arms
            // the handle) before the new value renders.
            if (isSlotHandle(value))
            {
                if (firstRun)
                {
                    // The server serialized an ordinary [ ] hole; the client's first
                    // resolution yields a route slot - the condition flipped across the
                    // boundary. The symmetric rule: a MISMATCH, never a silent
                    // repair. (The legitimate hydrated slot-hole arrives pre-seeded via
                    // adoptedSlot, which clears firstRun before this effect exists.)
                    throw new HydrationMismatchError(
                        'reactive hole: the client resolved a route slot where the server serialized an ordinary hole (condition flipped across the render boundary)');
                }
                if (placedSlot !== null && placedSlot.handle === value)
                {
                    if (consumeFirstRun)
                    {
                        consumeFirstRun = false;
                    }
                    localDispose?.();
                    return;
                }
                placedSlot?.dispose();
                placedSlot = null;
                for (const extra of extras)
                {
                    if (extra.parentNode === parent)
                    {
                        parent.removeChild(extra);
                    }
                }
                extras = [];
                if (currentNode !== null)
                {
                    if (currentNode instanceof HTMLElement)
                    {
                        destroyComponent(currentNode);
                    }
                    parent.removeChild(currentNode);
                    currentNode = null;
                }
                let slotDispose: DisposeFn = () => undefined;
                createRoot((dispose) =>
                {
                    slotDispose = dispose;
                    slotDriverOf(value).place(parent, closeAnchor);
                });
                placedSlot = { handle: value, dispose: slotDispose };
                localDispose?.();
                // Deliberately NO per-run cleanup here: a returned cleanup runs before
                // EVERY re-run, and a same-handle re-resolution must keep the placement
                // (the live-placement rule). Final teardown is the onRootDispose
                // registered at hole creation below; transitions dispose in-body.
                return;
            }
            if (placedSlot !== null)
            {
                // handle -> non-handle: dispose the placement first (re-arms the
                // handle), then fall through to render the new value normally.
                placedSlot.dispose();
                placedSlot = null;
            }
            if (consumeFirstRun)
            {
                consumeFirstRun = false;
            }

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

        // The child walk ran AFTER applyProps, so an adopted <option selected> was written on
        // top of the select's own value. Settling here restores the value's precedence - the
        // same targeted call h() makes after appending children, because adoption performs no
        // childList mutation for the observer to see.
        settleSelectValue(el);
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
        // The compiled hole's value is a getter, so the handle cannot be seen without
        // running user code - which must not happen on this (tracked) stack. The
        // SERIALIZER already answered the question: peek the next comment. An
        // `azc:outlet` open anchor means the serialized value was a route slot handle;
        // the hole is then driven as a slot-hole (adopt inline, effect consumed) -
        // resolution happens ONCE, tracked, inside the hole's own effect. A `[` anchor
        // is an ordinary reactive hole, exactly as today.
        if (peeksSlotRange(cursor))
        {
            adoptSlotHole(child, cursor);
            return;
        }
        adoptReactiveHole(child, cursor);
        return;
    }

    // A BARE route slot handle: the compiled <Outlet/> emits an eager component call in
    // the hydrate h() tree, so Outlet's return value (the handle) sits bare among the
    // descriptor's children. Checked before the static-text fallback, which would
    // consume a text node that does not exist.
    if (isSlotHandle(child))
    {
        slotDriverOf(child).adopt(cursor);
        return;
    }

    // Static text: the server already rendered it; just consume the node.
    cursor.takeText();
}

/** Whether the cursor's next node is a route slot's serialized open anchor. @internal */
function peeksSlotRange(cursor: HydrationCursorType): boolean
{
    const next = cursor.peek();
    return next !== null && next.nodeType === 8 && (next as Comment).data === 'azc:outlet';
}

/**
 * Adopts a slot-hole: a reactive hole whose SERIALIZED value was a route slot handle.
 * The adoption walk claims the range inline through the handle's driver - obtained by an
 * UNTRACKED resolution, permitted for slot-holes only (a compiled children getter is
 * cheap and side-effect-free) - then the hole's effect is created with its first run
 * consumed: it performs the tracked re-read that establishes the hole's subscriptions
 * and records the placed handle as the hole's current value.
 *
 * @internal
 */
function adoptSlotHole(child: () => unknown, cursor: HydrationCursorType): void
{
    const resolved = untrack(() => resolveThunks(child));
    if (!isSlotHandle(resolved))
    {
        // The peek said slot, the resolution disagrees: SSR/CSR diverged.
        throw new HydrationMismatchError('slot hole: the serialized value was a route slot, the client value is not');
    }
    // The adoption runs in its OWN root so the hole can dispose the placement on a
    // later handle -> non-handle transition (the slot's machinery registers its
    // teardown on the current owner).
    let slotDispose: DisposeFn = () => undefined;
    createRoot((dispose) =>
    {
        slotDispose = dispose;
        slotDriverOf(resolved).adopt(cursor);
    });
    // A stable position for LATER handle <-> non-handle transitions: the server emits no
    // [ ] anchors around a slot-hole, and the slot's own markers leave with its disposal,
    // so without an anchor of the hole's OWN a toggled-away value would land at the
    // parent's tail (document position lost). The cursor's node list is a construction
    // snapshot, so the insert does not disturb the remaining walk.
    const anchor = document.createTextNode('');
    cursor.parent.insertBefore(anchor, cursor.peek());
    driveHoleRange(cursor.parent, anchor, [], child, false, resolved, slotDispose);
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
