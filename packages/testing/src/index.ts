/**
 * MODULE: @azerothjs/testing - testing utilities for AzerothJS apps
 *
 * Every test against a reactive tree repeats the same shape: mount inside a root, mutate signals,
 * assert DOM, dispose. Forgetting the disposal is the common failure - the leaked effects keep running
 * into later tests. These helpers own that lifecycle:
 *   - renderTest(component) - mount into a fresh container in document.body (ATTACHED, so delegated
 *     events fire), returning { container, unmount };
 *   - cleanup()             - unmount everything renderTest mounted; auto-registered with a global
 *     `afterEach` when one exists (vitest/jest with globals enabled), else call it from your own;
 *   - leakGuard(...getters) - snapshot subscriber counts; the returned fn throws if any getter gained
 *     subscribers - the assertable form of "unmount released everything";
 *   - fire(el, type, init?) - dispatch a BUBBLING event, which delegated (compiled dom-target)
 *     handlers need.
 *
 * @see {@link renderTest}
 * @see {@link leakGuard}
 */

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
 * renderTest
 *
 * PURPOSE:
 * Mounts a component for a test - a fresh container appended to document.body, the tree built inside
 * its own reactive root - and returns the container plus an idempotent unmount.
 *
 * WHY IT EXISTS:
 * Every reactive-tree test needs the same mount/dispose lifecycle, and forgetting disposal leaks
 * effects into later tests. renderTest owns that lifecycle so a test can't get it wrong.
 *
 * COMPILER / RUNTIME ROLE:
 * Test-time, testing; wraps createRoot plus the render() teardown contract (root dispose + per-node
 * destroy hooks).
 *
 * INPUT CONTRACT:
 * - component: a function returning the root element to mount.
 *
 * OUTPUT CONTRACT:
 * - A {@link RenderResult}: `container` (attached to document.body) and `unmount()` (idempotent).
 *
 * WHY THIS DESIGN:
 * The container is ATTACHED to document.body so delegated events actually fire. unmount disposes the
 * root AND removes nodes one-by-one (not `innerHTML = ''`) so MutationObserver teardown (Portal
 * auto-cleanup) fires and destroy hooks run per element - the same contract as render()'s remount path.
 *
 * WHEN TO USE:
 * Any unit/integration test of a component or a reactive binding.
 *
 * WHEN NOT TO USE:
 * SSR string-output tests (call renderToString directly - no DOM needed); environments without a DOM.
 *
 * EDGE CASES:
 * - unmount is idempotent (a second call no-ops).
 * - {@link cleanup} unmounts any result you forgot to unmount.
 *
 * PERFORMANCE NOTES:
 * One container + one root per call; negligible.
 *
 * DEVELOPER WARNING:
 * Requires a DOM (happy-dom/jsdom/browser). The container is attached to document.body, so always
 * unmount (or rely on cleanup) or trees bleed across tests.
 *
 * @param component - A function returning the root element
 * @returns A {@link RenderResult} with the attached container and an idempotent unmount
 * @see {@link cleanup}
 * @see {@link leakGuard}
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
export function renderTest(component: () => HTMLElement | DocumentFragment): RenderResult
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
 * Unmounts everything {@link renderTest} mounted. Registered automatically with the environment's
 * global `afterEach` when one exists at import time; call it from your own afterEach otherwise.
 *
 * @returns Nothing; every tracked tree is unmounted as a side effect.
 * @see {@link renderTest}
 */
export function cleanup(): void
{
    for (const result of Array.from(mounted))
    {
        result.unmount();
    }
}

/**
 * leakGuard
 *
 * PURPOSE:
 * Snapshots the subscriber count of each signal/memo getter and returns an assertion that throws
 * (naming the offenders) if any getter holds MORE subscribers than at the snapshot.
 *
 * WHY IT EXISTS:
 * Leaked effects are INVISIBLE to DOM assertions - a disposed-looking tree can still hold live
 * subscribers. This makes "tearing down the tree released every subscription" assertable.
 *
 * COMPILER / RUNTIME ROLE:
 * Test-time, testing; built on reactivity's subscriberCount probe.
 *
 * INPUT CONTRACT:
 * - getters: the signal/memo getters to watch.
 *
 * OUTPUT CONTRACT:
 * - A function to call after teardown; it throws (listing each offending getter and its before->after
 *   counts) if any getter gained subscribers, and returns nothing on success.
 *
 * WHY THIS DESIGN:
 * It compares post-teardown counts to a baseline, so it flags NET leaks regardless of how many
 * subscribers existed at the start, and names each offender for fast debugging.
 *
 * WHEN TO USE:
 * Leak tests around a mount -> mutate -> unmount cycle.
 *
 * WHEN NOT TO USE:
 * Asserting an exact subscriber count (it only flags increases); getters meant to stay subscribed
 * past the check.
 *
 * EDGE CASES:
 * - Equal or fewer subscribers passes; only an increase throws.
 *
 * PERFORMANCE NOTES:
 * O(getters) at snapshot and at check.
 *
 * DEVELOPER WARNING:
 * Snapshot BEFORE mounting and check AFTER unmounting - snapshot while mounted and the baseline
 * already includes the subscriptions you are trying to detect.
 *
 * @param getters - Signal or memo getters to watch
 * @returns An assertion function that throws if subscriptions were not released
 * @see {@link renderTest}
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
            const getter = getters[i];
            const before = baseline[i];
            if (getter === undefined || before === undefined)
            {
                continue;
            }
            const now = subscriberCount(getter);
            if (now > before)
            {
                leaks.push(`getter #${ i }: ${ before } -> ${ now } subscribers`);
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
 * @returns Nothing; the event is dispatched as a side effect.
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
