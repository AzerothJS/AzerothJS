// Testing utilities for AzerothJS apps. Every test against a reactive tree
// repeats the same shape: mount inside a root, mutate signals, assert DOM,
// dispose. Forgetting the disposal is the common failure - the leaked
// effects keep running into later tests. These helpers own that lifecycle:
//
//   renderTest(component)  mount into a fresh container in document.body
//                          (attached, so delegated events fire), returning
//                          { container, unmount }.
//   cleanup()              unmount everything renderTest mounted. Called
//                          automatically after each test when a global
//                          `afterEach` exists (vitest/jest with globals
//                          enabled); otherwise call it from your own
//                          afterEach.
//   leakGuard(...getters)  snapshot signal subscriber counts; the returned
//                          function throws if any getter has MORE
//                          subscribers than at the snapshot - the
//                          assertable form of "unmount released
//                          everything".
//   fire(el, type, init?)  dispatch a bubbling event - what delegated
//                          handlers (the compiled dom target) need.

import { createRoot, subscriberCount, type Getter } from '@azerothjs/reactivity';
import { destroyComponent } from '@azerothjs/component';

/** A mounted test tree. */
export interface RenderResult
{
    /** The container element, attached to document.body. */
    container: HTMLElement;

    /** Disposes the tree's effects, runs component destroy hooks, and
     *  removes the container. Idempotent. */
    unmount: () => void;
}

/** Everything renderTest mounted and has not yet unmounted. @internal */
const mounted = new Set<RenderResult>();

/**
 * Mounts a component for a test: fresh container appended to document.body,
 * the tree built inside its own reactive root. Unmount disposes the root,
 * runs destroy hooks per removed node (the same teardown contract as
 * render()), and removes the container.
 *
 * @param component - A function returning the root element
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0);
 * const { container, unmount } = renderTest(() =>
 *     h('p', {}, () => `count: ${ count() }`));
 *
 * expect(container.textContent).toBe('count: 0');
 * setCount(1);
 * expect(container.textContent).toBe('count: 1');
 * unmount();
 * ```
 */
export function renderTest(component: () => HTMLElement): RenderResult
{
    const container = document.createElement('div');
    document.body.appendChild(container);

    let dispose!: () => void;
    createRoot((d) =>
    {
        dispose = d;
        container.appendChild(component());
    });

    let unmounted = false;
    const result: RenderResult = {
        container,
        unmount: (): void =>
        {
            if (unmounted)
            {
                return;
            }
            unmounted = true;
            mounted.delete(result);

            dispose();

            // Per-node removal (not innerHTML = '') so MutationObserver-based
            // teardown - Portal auto-cleanup - still fires, and destroy hooks
            // run per element. Same contract as render()'s remount path.
            while (container.firstChild)
            {
                const node = container.firstChild;
                container.removeChild(node);
                if (node instanceof HTMLElement)
                {
                    destroyComponent(node);
                }
            }
            container.remove();
        }
    };

    mounted.add(result);
    return result;
}

/**
 * Unmounts everything renderTest mounted. Registered automatically with the
 * environment's global `afterEach` when one exists at import time; call it
 * from your own afterEach otherwise.
 */
export function cleanup(): void
{
    for (const result of Array.from(mounted))
    {
        result.unmount();
    }
}

/**
 * Snapshots the subscriber count of each signal/memo getter and returns an
 * assertion function: call it after unmounting and it throws (naming the
 * offenders) if any getter holds MORE subscribers than at the snapshot.
 *
 * This is the assertable form of "tearing down the tree released every
 * subscription" - leaked effects are invisible to DOM assertions because a
 * disposed-looking tree can still hold live subscribers.
 *
 * @param getters - Signal or memo getters to watch
 *
 * @example
 * ```ts
 * const [count] = createSignal(0);
 * const check = leakGuard(count);
 *
 * const { unmount } = renderTest(() => h('p', {}, () => String(count())));
 * unmount();
 *
 * check(); // throws if the binding's effect was not released
 * ```
 */
export function leakGuard(...getters: Getter<unknown>[]): () => void
{
    const baseline = getters.map((getter) => subscriberCount(getter));

    return (): void =>
    {
        const leaks: string[] = [];
        for (let i = 0; i < getters.length; i++)
        {
            const now = subscriberCount(getters[i]);
            if (now > baseline[i])
            {
                leaks.push(`getter #${ i }: ${ baseline[i] } -> ${ now } subscribers`);
            }
        }
        if (leaks.length > 0)
        {
            throw new Error(`leakGuard: subscriptions not released after teardown - ${ leaks.join('; ') }`);
        }
    };
}

/**
 * Dispatches a BUBBLING event on an element. Delegated handlers (compiled
 * dom-target output binds events on the document) only see events that
 * bubble; a bare `new Event('click')` does not.
 *
 * @param el - The target element
 * @param type - Event type ('click', 'input', ...)
 * @param init - Extra event init entries, merged over the bubbling defaults
 *
 * @example
 * ```ts
 * fire(button, 'click');
 * fire(input, 'input');
 * ```
 */
export function fire(el: HTMLElement, type: string, init?: EventInit): void
{
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
}

// Auto-cleanup: test runners with globals enabled expose afterEach at module
// scope during collection. Hook registration must happen at import time -
// inside a test body it would be rejected by the runner.
const globalAfterEach = (globalThis as { afterEach?: (fn: () => void) => void }).afterEach;
if (typeof globalAfterEach === 'function')
{
    globalAfterEach(() => cleanup());
}
