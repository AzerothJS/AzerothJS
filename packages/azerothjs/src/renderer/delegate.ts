/**
 * MODULE: renderer/delegate (internal)
 *
 * Event delegation for the template (`dom`-target) path: one document-level listener per event
 * type, with per-element handlers stored on the elements themselves. Compiled rows stop paying
 * an addEventListener per handler per row - the listener exists once and registering a handler
 * is one property write.
 *
 * SCOPE: ONLY bindProps (compiled dom-target output) delegates; h() keeps per-element listeners
 * because delegation changes observable behavior for detached elements and non-bubbling
 * dispatches, and h()'s contract predates it. The opt-in dom target carries the stricter
 * semantics: a delegated handler fires only for events that actually bubble to the document.
 * The document listeners are never removed (at most one per type for the page's life; removal
 * bookkeeping would cost more than the listeners do).
 */

import { getDestroyHooks, setDestroyHooks } from '../component/destroy-hooks.ts';

/**
 * Per-event-type Symbol keys: a delegated handler is stored DIRECTLY on the element under its
 * type's Symbol (`el[SYM_click] = handler`) - one property write and NO per-element store
 * object. With thousands of rows each carrying a couple of handlers, the old
 * `{ click: fn, ... }` wrapper object per element was pure resident overhead.
 *
 * @internal
 */
const TYPE_KEYS = new Map<string, symbol>();

/** The Symbol key for one event type (created on first use). @internal */
function typeKey(type: string): symbol
{
    let key = TYPE_KEYS.get(type);
    if (key === undefined)
    {
        key = Symbol(`azeroth_on_${ type }`);
        TYPE_KEYS.set(type, key);
    }
    return key;
}

/** Event types with a document listener installed. @internal */
const installed = new Set<string>();

/**
 * Bubbling events worth delegating. Conservative: everything here reliably
 * bubbles in browsers and happy-dom. Non-bubbling types (focus, blur,
 * mouseenter, ...) keep per-element listeners.
 *
 * @internal
 */
const DELEGATED_EVENTS = new Set([
    'click', 'dblclick', 'contextmenu',
    'input', 'change',
    'keydown', 'keyup', 'keypress',
    'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout',
    'pointerdown', 'pointerup', 'pointermove',
    'touchstart', 'touchend', 'touchmove'
]);

/** @internal */
interface DelegatedStore { [key: symbol]: EventListener | boolean | undefined }

/**
 * Marks an element whose delegated-handler teardown hook is registered, so re-binding a
 * second event type (or re-running bindProps) does not stack duplicate hooks.
 *
 * @internal
 */
const CLEANUP_KEY = Symbol('azeroth_delegate_cleanup');

/** Whether bindProps should delegate this (lowercase) event type. @internal */
export function isDelegatedEvent(type: string): boolean
{
    return DELEGATED_EVENTS.has(type);
}

/**
 * Removes every delegated handler (and the teardown marker) from one element. Runs as the
 * element's destroy hook: without it, a torn-down element that application code re-inserts
 * still carries its type Symbols, so the document listener would fire the OLD handler with
 * its stale captured scope. Registered types are bounded by TYPE_KEYS (one entry per event
 * type ever delegated), so the sweep is a handful of property reads.
 *
 * @internal
 */
function clearDelegatedHandlers(el: HTMLElement): void
{
    const store = el as unknown as DelegatedStore;
    for (const key of TYPE_KEYS.values())
    {
        // Assign undefined rather than delete: dispatch already gates on
        // `typeof handler !== 'function'`, so a cleared slot is inert, and the
        // CLEANUP_KEY reset lets a later re-bind re-register the hook.
        store[key] = undefined;
    }
    store[CLEANUP_KEY] = undefined;
}

/**
 * Registers a delegated handler for `type` on `el`, installing the shared
 * document listener for that type on first use. The element's first delegated
 * handler also attaches ONE destroy hook so destroyComponent() unregisters the
 * handlers with the rest of the subtree's node-bound teardown.
 *
 * @internal
 */
export function delegateEvent(el: HTMLElement, type: string, handler: EventListener): void
{
    const store = el as unknown as DelegatedStore;
    store[typeKey(type)] = handler;

    if (store[CLEANUP_KEY] === undefined)
    {
        store[CLEANUP_KEY] = true;
        const existing = getDestroyHooks(el);
        if (existing !== undefined && existing.length > 0)
        {
            existing.push(() => clearDelegatedHandlers(el));
        }
        else
        {
            setDestroyHooks(el, [() => clearDelegatedHandlers(el)]);
        }
    }

    if (!installed.has(type))
    {
        installed.add(type);
        document.addEventListener(type, dispatchDelegated);
    }
}

/**
 * The shared listener. The propagation path is SNAPSHOTTED before any handler runs -
 * native dispatch computes the path up front, so a handler that removes or reparents its
 * own node must not truncate (or reroute) the walk for its ancestors' handlers. Each
 * snapshot node's handler is read at invocation time, so a handler unregistered
 * mid-dispatch (teardown) is skipped; stopPropagation ends the walk after the current
 * node, and stopImmediatePropagation ends it unconditionally (tracked with a per-dispatch
 * override because reading cancelBubble observes only the stop-propagation flag).
 *
 * @internal
 */
function dispatchDelegated(event: Event): void
{
    const key = typeKey(event.type);

    const path: Node[] = [];
    for (let node: Node | null = event.target as Node | null; node !== null; node = node.parentNode)
    {
        path.push(node);
    }

    // Observe stopImmediatePropagation, which no DOM property reflects (cancelBubble tracks
    // only stopPropagation, and happy-dom does not even set it for the immediate variant).
    // The override records the call and re-dispatches to the native method with an explicit
    // `this`; it is removed in the finally so later document listeners see the real method.
    let immediateStop = false;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured only to re-invoke via .call(this) below; never called unbound
    const nativeStopImmediate = event.stopImmediatePropagation;
    event.stopImmediatePropagation = function stopImmediatePropagation(this: Event): void
    {
        immediateStop = true;
        nativeStopImmediate.call(this);
    };

    try
    {
        for (const node of path)
        {
            const handler = (node as unknown as DelegatedStore)[key];
            if (typeof handler !== 'function')
            {
                continue;
            }
            handler.call(node, event);
            // eslint-disable-next-line @typescript-eslint/no-deprecated, @typescript-eslint/no-unnecessary-condition -- reading cancelBubble is the only way to OBSERVE stopPropagation() from outside (the deprecation targets writing it); immediateStop is mutated by the override closure, which the rule's flow analysis cannot see
            if (immediateStop || event.cancelBubble)
            {
                return;
            }
        }
    }
    finally
    {
        // Restore the prototype method for the listeners that run after this one.
        delete (event as unknown as Record<string, unknown>).stopImmediatePropagation;
    }
}
