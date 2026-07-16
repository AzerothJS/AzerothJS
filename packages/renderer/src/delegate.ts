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

/** Per-element delegated handler store, keyed by event type. @internal */
const HANDLERS = Symbol('azeroth_delegated_handlers');

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
interface DelegatedStore { [HANDLERS]?: Record<string, EventListener> }

/** Whether bindProps should delegate this (lowercase) event type. @internal */
export function isDelegatedEvent(type: string): boolean
{
    return DELEGATED_EVENTS.has(type);
}

/**
 * Registers a delegated handler for `type` on `el`, installing the shared
 * document listener for that type on first use.
 *
 * @internal
 */
export function delegateEvent(el: HTMLElement, type: string, handler: EventListener): void
{
    const store = el as unknown as DelegatedStore;
    let handlers = store[HANDLERS];
    if (handlers === undefined)
    {
        handlers = {};
        store[HANDLERS] = handlers;
    }
    handlers[type] = handler;

    if (!installed.has(type))
    {
        installed.add(type);
        document.addEventListener(type, dispatchDelegated);
    }
}

/**
 * The shared listener: walks from the event target up the tree, invoking
 * each registered handler for the event's type, stopping if a handler calls
 * stopPropagation - matching what per-element bubbling listeners would do.
 *
 * @internal
 */
function dispatchDelegated(event: Event): void
{
    let node: Node | null = event.target as Node | null;

    while (node !== null)
    {
        const handler = (node as unknown as DelegatedStore)[HANDLERS]?.[event.type];
        if (handler !== undefined)
        {
            handler.call(node, event);
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- reading cancelBubble is the only way to OBSERVE a handler's stopPropagation() from outside; the deprecation targets writing it
            if (event.cancelBubble)
            {
                return;
            }
        }
        node = node.parentNode;
    }
}
