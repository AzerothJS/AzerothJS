/**
 * MODULE: renderer/transition
 *
 * <Transition> wraps a conditionally-rendered element with CSS-class-driven enter/leave
 * animations. Same swap pattern as <Show>, but instead of instant mount/unmount it adds
 * transition classes for the browser to animate against and removes the element only AFTER the
 * leave animation finishes - the deferred-removal leave is the part that is hard to do by hand
 * around Show.
 *
 * VUE-STYLE 6-CLASS CONVENTION (with name: 'fade'): `fade-enter-from` / `-enter-active` /
 * `-enter-to` (enter) and the matching `-leave-*` trio; CSS pairs the from/to states with a
 * transition on the -active classes.
 *
 * LIFECYCLE: enter = mount, add enter-from+active, force reflow, next frame swap to enter-to,
 * clear classes on transitionend; leave = add leave-from+active, force reflow, next frame swap
 * to leave-to, remove from DOM on transitionend. The FIRST run mounts INSTANTLY (Vue's
 * appear:false default) so a page does not fade in a wave on load. A mid-flight toggle CANCELS
 * the in-flight run and reverses FROM THE CURRENT COMPUTED STYLE (the reversal skips the
 * opposite 'from' class, so a half-entered sheet animates back from exactly where it is - no
 * finish-then-reverse). A transitionend that never fires
 * (missing CSS transition) is backstopped by a `duration` timeout (default 1000ms) so the state
 * machine cannot wedge. The phase-machine internals below carry their own comments.
 */

import type { DisposeFn, HydrationCursor as HydrationCursorType } from '@azerothjs/reactivity';
import { createEffect, createRoot, onRootDispose, isStringMode, isHydrating, untrack, serializeChild, wrapContentsAnchored, hydrationNode } from '@azerothjs/reactivity';
import { destroyComponent, type CoTarget, type MountNode, createCoMarkers, appendToCo, adoptCoRange } from '@azerothjs/component';
import { hydrateChild, resolveReactive } from './h.ts';

/**
 * Props for the `<Transition>` component.
 */
export interface TransitionProps
{
    /** Whether to show: a value, or a getter (thunk/signal) for reactivity. The
     *  compiler emits a getter-object prop; manual callers may pass `() => cond`
     *  or a signal. `resolveReactive` unwraps it on each read. */
    when: boolean | (() => boolean);

    /** Factory that builds the element when entering. */
    children: () => HTMLElement;

    /**
     * Class-name prefix that auto-generates the 6-class family
     * (`${name}-enter-from`, `${name}-enter-active`, etc.). When
     * absent, the component falls back to instant swap (same as
     * `<Show>`).
     */
    name?: string;

    /**
     * Fallback timeout in milliseconds for the `transitionend`
     * watcher. If your CSS doesn't define a transition (or it's
     * shorter than expected), the element will still complete its
     * lifecycle after this many ms. Default: 1000.
     */
    duration?: number;
}

/**
 * Internal phase tracker. Used to prevent re-entrant transitions
 * and to queue toggles that arrive mid-flight.
 *
 * @internal
 */
type Phase = 'idle' | 'entering' | 'leaving';

/**
 * Default fallback timeout (ms) when no CSS transition is
 * defined or transitionend never fires.
 *
 * @internal
 */
const FALLBACK_TIMEOUT_MS = 1000;

/**
 * Transition
 *
 * PURPOSE:
 * Renders children() while `when` is true, animating the element in/out via the CSS class
 * family derived from `name`, and deferring DOM removal until the leave animation completes.
 *
 * WHY IT EXISTS:
 * The leave animation is the hard part: you must add the leave classes, force a reflow, swap to
 * the "to" state, and remove the node only on transitionend (with a timeout backstop). Doing
 * that by hand around <Show> is fiddly and easy to wedge; Transition packages the full
 * enter/leave state machine.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, renderer; an animated control-flow component. Mode-dispatched: client state machine,
 * static initial content in SSR (no browser to animate against), instant adoption on hydration
 * (later toggles animate).
 *
 * INPUT CONTRACT:
 * - when: boolean or getter (resolveReactive-unwrapped).
 * - children: thunk building the element to animate.
 * - name: optional class-family prefix; absent => instant swap (like Show).
 * - duration: optional transitionend fallback timeout in ms (default 1000).
 *
 * OUTPUT CONTRACT:
 * - Returns an HTMLElement-typed handle (a comment-marker co-range) owning the single animated child.
 *
 * WHY THIS DESIGN:
 * A phase machine (idle/entering/leaving) with mid-flight cancellation sequences
 * enter/leave without overlap; each child mounts in its own createRoot so its effects dispose on
 * leave; a transitionend listener with a duration timeout guarantees progress even without a
 * real CSS transition. The first-run instant mount avoids load-time fade waves.
 *
 * WHEN TO USE:
 * For enter/leave animations on a single conditional element (modals, drawers, toasts).
 *
 * WHEN NOT TO USE:
 * For instant show/hide (use {@link Show}). For per-row list animations (v1 animates one child).
 *
 * EDGE CASES:
 * - No `name`: instant swap (Show semantics).
 * - First mount never animates; a mid-flight toggle cancels and reverses from the current visual state.
 * - Missing CSS transition still completes via the duration timeout.
 *
 * PERFORMANCE NOTES:
 * One child at a time; one transitionend listener + timeout per phase; one forced reflow per
 * enter/leave start (required to commit the from-state before animating).
 *
 * DEVELOPER WARNING:
 * Define the CSS class family (or pass no `name` for instant) - relying on the duration timeout
 * for every transition makes leaves feel laggy. Mid-flight reversal cancels the in-flight run: rapid open/close stays crisp.
 *
 * @param props - {@link TransitionProps}: `when`, `children`, optional `name`, `duration`.
 * @returns An HTMLElement-typed handle owning the animated child.
 * @see {@link Show}
 * @example
 * Transition({ when: isOpen, name: 'fade', children: () => h('div', { class: 'modal' }, 'Hi') });
 * // CSS: .fade-enter-from,.fade-leave-to{opacity:0} .fade-enter-active,.fade-leave-active{transition:opacity .3s}
 */
export function Transition(props: TransitionProps): MountNode
{
    // Server-side rendering.
    // Emit the static initial content (no animation classes - there
    // is no browser to animate against). Matches the instant,
    // no-enter-animation first mount of the client path.
    if (isStringMode())
    {
        const inner = untrack(() => resolveReactive(props.when)) ? serializeChild(props.children()) : '';
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
    // <Transition> works inside <table>/<select>/<ul>. See ./co-range.ts.
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
            el = props.children();
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
            hydrateChild(props.children(), cursor);
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
        const cls = classFamily(direction);
        if (cls && currentEl)
        {
            currentEl.classList.remove(cls.from, cls.active, cls.to);
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
