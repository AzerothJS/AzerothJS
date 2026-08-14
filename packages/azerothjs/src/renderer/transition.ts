/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Conditional rendering with CSS-class-driven enter and leave animations. The swap pattern is
 * Show's, except the element is removed only AFTER its leave animation finishes - that
 * deferred removal is the part that is genuinely hard to build by hand around Show.
 *
 * The class family follows the Vue convention. With `name: 'fade'` that is `fade-enter-from`,
 * `-enter-active` and `-enter-to`, plus the matching `-leave-*` trio; the CSS pairs the from
 * and to states with a transition on the active classes.
 *
 * Entering mounts the element, adds enter-from and enter-active, forces a reflow, swaps to
 * enter-to on the next frame, and clears the classes on transitionend. Leaving mirrors that
 * and removes the element at the end. The FIRST run mounts instantly, matching Vue's
 * `appear: false` default, so a page does not fade in as a wave on load.
 *
 * A mid-flight toggle CANCELS the run in progress and reverses from the CURRENT COMPUTED
 * STYLE, skipping the opposite 'from' class, so a half-entered sheet animates back from
 * exactly where it is instead of finishing and then reversing.
 *
 * A transitionend that never fires - missing or shorter CSS than expected - is backstopped by
 * the `duration` timeout, so the state machine cannot wedge. A leaving element is still
 * mounted with live handlers, so it is marked `data-azeroth-transition-leaving` and given
 * `pointer-events: none` by one injected, overridable rule: an element on its way out must
 * not take another click.
 */

import type { DisposeFn } from '../reactivity/index.ts';
import type { HydrationCursor as HydrationCursorType } from '../reactivity/internal.ts';
import { createEffect, createRoot, onRootDispose, isStringMode, isHydrating, untrack } from '../reactivity/index.ts';
import { refuseSlotHandle } from '../reactivity/slot-handle.ts';
import { serializeChild, wrapContentsAnchored, hydrationNode } from '../reactivity/internal.ts';
import { destroyComponent, type CoTarget, type MountNode, createCoMarkers, appendToCo, adoptCoRange } from '../component/index.ts';
import { adoptStyleSheet } from './adopt-style.ts';
import { hydrateChild, resolveReactive } from './h.ts';

/** Props for {@link Transition}. */
export interface TransitionProps
{
    /** Whether to show: a value, or a getter for reactivity. */
    when: boolean | (() => boolean);

    /** Builds the element when entering. */
    children: () => HTMLElement;

    /**
     * Class-name prefix generating the six-class family - `${name}-enter-from`,
     * `${name}-enter-active` and so on. Without it the component falls back to an instant
     * swap, exactly like Show.
     */
    name?: string;

    /**
     * Fallback timeout in milliseconds for the transitionend watcher. When the CSS defines no
     * transition, or a shorter one than expected, the element still completes its lifecycle
     * after this long. Defaults to 1000.
     */
    duration?: number;
}

/** Prevents re-entrant transitions and lets a mid-flight toggle be handled as a reversal. */
type Phase = 'idle' | 'entering' | 'leaving';

/** The refusal hint every Transition mode shares. */
const TRANSITION_SLOT_HINT = 'Animate route swaps with the route-level `transition` prop on <Routes> instead.';

const FALLBACK_TIMEOUT_MS = 1000;

/**
 * Attribute marking the element of an IN-FLIGHT LEAVE. The leave keeps the element mounted -
 * handlers attached, scope alive - until the animation ends or the fallback timeout fires, so
 * without this a "Confirm payment" button stays clickable for the whole second it spends
 * animating away, and the second click is a real double-submit.
 *
 * @internal
 */
export const LEAVING_ATTR = 'data-azeroth-transition-leaving';

/**
 * Injects, once per document, the single overridable rule that makes a leaving element inert.
 * Author-level (no `!important`) so an app can override it, and scoped to the framework-owned
 * attribute so it touches nothing else. The framework never mutates the element's inline
 * styles: presentation stays declarative and app-overridable, and the animating CSS keeps
 * full ownership of the element's `style` attribute.
 *
 * @internal
 */
export function ensureLeavingStyle(): void
{
    adoptStyleSheet(LEAVING_ATTR, `[${ LEAVING_ATTR }]{pointer-events:none}`, LEAVING_ATTR);
}

/**
 * Renders one element while `when` is truthy, animating it in and out through the class
 * family derived from `name`, and deferring removal until the leave animation completes.
 *
 * Define the CSS class family. Relying on the duration timeout for every transition makes
 * leaves feel laggy, and omitting `name` entirely gives a clean instant swap instead.
 *
 * The first mount never animates. A mid-flight toggle cancels the run in progress and
 * reverses from the current visual state, so rapid open and close stays crisp. A leaving
 * element stops accepting pointer input for the length of its leave, and a reversed leave
 * becomes interactive again.
 *
 * One child at a time. For per-row list animations use TransitionGroup.
 *
 * On the server the initial content is emitted statically, there being no browser to animate
 * against, and hydration adopts it instantly; later toggles animate normally.
 *
 * @param props - See {@link TransitionProps}.
 * @returns A handle owning the animated child, typed as a node.
 * @example
 * Transition({
 *     when: isOpen,
 *     name: 'fade',
 *     children: () => h('div', { class: 'modal' }, 'Hi')
 * });
 *
 * // .fade-enter-from, .fade-leave-to     { opacity: 0 }
 * // .fade-enter-active, .fade-leave-active { transition: opacity .3s }
 *
 * @see {@link Show} for instant show and hide.
 */
export function Transition(props: TransitionProps): MountNode
{
    // Server-side rendering.
    // Emit the static initial content (no animation classes - there
    // is no browser to animate against). Matches the instant,
    // no-enter-animation first mount of the client path.
    if (isStringMode())
    {
        const child = untrack(() => resolveReactive(props.when)) ? props.children() : '';
        // A route slot cannot live in a Transition (single-element machine); refused
        // identically in every mode so the server never serializes a segment the
        // client would then refuse to animate.
        const inner = refuseSlotHandle(child, 'Transition', TRANSITION_SLOT_HINT) ? '' : serializeChild(child);
        return wrapContentsAnchored('transition', inner) as unknown as MountNode;
    }

    // Hydration.
    // Adopt the server comment markers; the first effect run adopts the
    // already-rendered child (no enter animation), later toggles animate.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            const { target, contentCursor } = adoptCoRange(cursor);
            driveTransition(props, target, true, contentCursor);
        }) as unknown as MountNode;
    }

    // No wrapper element: comment markers bracket the (single) animated child so
    // <Transition> works inside <table>/<select>/<ul>. See azerothjs's co-range.ts.
    const { fragment, target } = createCoMarkers('transition');

    driveTransition(props, target, false);

    return fragment;
}

/**
 * Drives the transition state machine on `container`. Shared by the DOM path
 * (a fresh span) and hydration (the adopted server span). When
 * `hydrateFirstRun` is true, the initial visible element is adopted from the
 * existing server DOM instead of built and appended.
 *
 * @internal
 */
function driveTransition(props: TransitionProps, target: CoTarget, hydrateFirstRun: boolean, hydrationCursor?: HydrationCursorType): void
{
    let currentEl: HTMLElement | null = null;
    let currentDispose: DisposeFn | null = null;
    let phase: Phase = 'idle';

    /**
     * Cancels the in-flight `transitionend`/timeout wait, if any -
     * detaching its listener and clearing its timer WITHOUT running
     * the completion callback. `null` when no wait is armed. Only
     * ever one wait is in flight at a time (the phase machine never
     * overlaps them), so a single slot is enough.
     */
    let cancelPendingWait: (() => void) | null = null;

    /**
     * Returns the 3-class family for one direction, or `null`
     * when no `name` was provided.
     */
    function classFamily(direction: 'enter' | 'leave'): {
        from: string;
        active: string;
        to: string;
    } | null
    {
        if (!props.name)
        {
            return null;
        }
        return {
            from: `${ props.name }-${ direction }-from`,
            active: `${ props.name }-${ direction }-active`,
            to: `${ props.name }-${ direction }-to`
        };
    }

    /**
     * Builds and mounts the child inside its own root, so any
     * effects/components it creates can be torn down on leave.
     */
    function mountEl(): HTMLElement
    {
        let el!: HTMLElement;
        let dispose!: DisposeFn;
        createRoot((d) =>
        {
            dispose = d;
            const built = props.children();
            // A route slot's marker range is not a single element: the classList /
            // transitionend / removeChild machinery below would TypeError or leak on it.
            if (refuseSlotHandle(built, 'Transition', TRANSITION_SLOT_HINT))
            {
                el = undefined as unknown as HTMLElement;
                return;
            }
            el = built;
            appendToCo(target, el);
        });
        currentEl = el;
        currentDispose = dispose;
        return el;
    }

    /**
     * Hydration counterpart to {@link mountEl}: adopts the already-present
     * server child instead of building a new one, inside its own root.
     */
    function adoptEl(): HTMLElement
    {
        let el!: HTMLElement;
        let dispose!: DisposeFn;
        createRoot((d) =>
        {
            dispose = d;
            const cursor = hydrationCursor as HydrationCursorType;
            const adopted = cursor.peekElement();
            const child = props.children();
            // Refused BEFORE hydrateChild: its bare-branded branch would otherwise
            // ADOPT the slot into a host whose machine cannot manage it.
            if (refuseSlotHandle(child, 'Transition', TRANSITION_SLOT_HINT))
            {
                el = undefined as unknown as HTMLElement;
                return;
            }
            hydrateChild(child, cursor);
            el = adopted as HTMLElement;
        });
        currentEl = el;
        currentDispose = dispose;
        return el;
    }

    /**
     * Tears down `currentEl` immediately, without animating.
     * Used on root dispose and when no `name` is configured.
     */
    function unmountElImmediate(): void
    {
        if (!currentEl)
        {
            return;
        }

        // Abandon any in-flight enter/leave wait so its timer and
        // transitionend listener don't linger past unmount.
        cancelPendingWait?.();

        const el = currentEl;
        const dispose = currentDispose;
        currentEl = null;
        currentDispose = null;
        // el is the single child between the markers; remove it from whatever
        // parent the markers currently live in.
        el.parentNode?.removeChild(el);
        dispose?.();
        destroyComponent(el);
    }

    /**
     * Listens for `transitionend` on the element, with a timeout
     * fallback so the state machine can't wedge if the user
     * forgot the CSS transition (or it never fires).
     */
    function waitForEndOrTimeout(el: HTMLElement, callback: () => void): void
    {
        const duration = props.duration ?? FALLBACK_TIMEOUT_MS;
        let done = false;

        function teardown(): void
        {
            el.removeEventListener('transitionend', handler);
            clearTimeout(timer);
            cancelPendingWait = null;
        }

        function finish(): void
        {
            if (done)
            {
                return;
            }
            done = true;
            teardown();
            callback();
        }

        function handler(event: Event): void
        {
            // Ignore transitionend from descendant elements that
            // bubble up to our target - only count the outer
            // element's own transition completion.
            if (event.target !== el)
            {
                return;
            }
            finish();
        }

        el.addEventListener('transitionend', handler);
        const timer = setTimeout(finish, duration);

        // Allow a forced unmount (root dispose) to detach this
        // wait's listener + timer without running `callback`.
        cancelPendingWait = (): void =>
        {
            if (done)
            {
                return;
            }
            done = true;
            teardown();
        };
    }

    /**
     * Runs the enter sequence on `currentEl`. No-op if there's no name (instant
     * mount path). `fromCurrent` skips the 'enter-from' snap - used when
     * REVERSING a cancelled leave, so the animation starts from wherever the
     * element visually is instead of jumping to the hidden state first.
     */
    function startEnter(fromCurrent = false): void
    {
        if (!currentEl)
        {
            return;
        }
        const cls = classFamily('enter');
        if (!cls)
        {
            phase = 'idle';
            return;
        }

        const el = currentEl;
        phase = 'entering';
        if (fromCurrent)
        {
            el.classList.add(cls.active);
        }
        else
        {
            el.classList.add(cls.from, cls.active);
        }

        // Force a reflow so the browser commits the "from" state
        // before we add the "to" class on the next frame.
        void el.offsetHeight;

        requestAnimationFrame(() =>
        {
            // Bail if the state changed while we were waiting.
            if (phase !== 'entering' || currentEl !== el)
            {
                return;
            }

            el.classList.remove(cls.from);
            el.classList.add(cls.to);

            waitForEndOrTimeout(el, () =>
            {
                if (phase !== 'entering' || currentEl !== el)
                {
                    return;
                }
                el.classList.remove(cls.active, cls.to);
                phase = 'idle';
            });
        });
    }

    /**
     * Runs the leave sequence and removes `currentEl` from the DOM when it
     * finishes. No-op (just unmounts) if no name. `fromCurrent` skips the
     * 'leave-from' snap - used when REVERSING a cancelled enter, so a
     * half-entered element animates out from exactly where it is.
     */
    function startLeave(fromCurrent = false): void
    {
        if (!currentEl)
        {
            return;
        }

        const cls = classFamily('leave');
        if (!cls)
        {
            unmountElImmediate();
            phase = 'idle';
            return;
        }

        const el = currentEl;
        const dispose = currentDispose;
        phase = 'leaving';
        ensureLeavingStyle();
        el.setAttribute(LEAVING_ATTR, '');
        if (fromCurrent)
        {
            el.classList.add(cls.active);
        }
        else
        {
            el.classList.add(cls.from, cls.active);
        }

        void el.offsetHeight;

        requestAnimationFrame(() =>
        {
            if (phase !== 'leaving' || currentEl !== el)
            {
                return;
            }

            el.classList.remove(cls.from);
            el.classList.add(cls.to);

            waitForEndOrTimeout(el, () =>
            {
                if (phase !== 'leaving' || currentEl !== el)
                {
                    return;
                }
                el.parentNode?.removeChild(el);
                dispose?.();
                destroyComponent(el);
                currentEl = null;
                currentDispose = null;
                phase = 'idle';
            });
        });
    }

    /**
     * Cancels the in-flight run for one direction: detaches its wait (listener
     * + timer) and strips that direction's classes, leaving the element at its
     * CURRENT computed style - the starting point the reversal animates from.
     */
    function cancelInFlight(direction: 'enter' | 'leave'): void
    {
        cancelPendingWait?.();
        if (!currentEl)
        {
            return;
        }
        const cls = classFamily(direction);
        if (cls)
        {
            currentEl.classList.remove(cls.from, cls.active, cls.to);
        }
        // A cancelled leave re-enters and stays mounted: it must be interactive again.
        if (direction === 'leave')
        {
            currentEl.removeAttribute(LEAVING_ATTR);
        }
    }

    // Reactive driver.
    //
    // First run: instant mount (no enter animation), matching
    // Vue's `appear: false` default. Subsequent runs: animate the
    // transition (or queue if one is in flight).
    let isFirstRun = true;
    createEffect(() =>
    {
        const shouldShow = resolveReactive(props.when) as boolean;

        if (isFirstRun)
        {
            isFirstRun = false;
            if (shouldShow)
            {
                if (hydrateFirstRun)
                {
                    adoptEl();
                }
                else
                {
                    mountEl();
                }
            }
            return;
        }

        if (phase === 'idle')
        {
            const isShowing = currentEl !== null;
            if (shouldShow && !isShowing)
            {
                mountEl();
                startEnter();
            }
            else if (!shouldShow && isShowing)
            {
                startLeave();
            }
        }
        else if (phase === 'entering' && !shouldShow)
        {
            // Reverse a half-done enter: cancel it and leave from the element's
            // current visual state - rapid open/close stays crisp.
            cancelInFlight('enter');
            startLeave(true);
        }
        else if (phase === 'leaving' && shouldShow)
        {
            // Reverse a half-done leave: the element is still mounted; re-enter
            // from wherever it visually is (no rebuild, state preserved).
            cancelInFlight('leave');
            startEnter(true);
        }
        // Same-direction toggles mid-flight are already heading there: no-op.
    });

    // Force-cleanup on root dispose. We skip animations here -
    // when the surrounding scope unmounts there's no DOM target
    // to animate against.
    onRootDispose(() =>
    {
        unmountElImmediate();
    });
}
