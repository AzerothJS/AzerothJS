// ============================================================================
// AZEROTHJS — <Transition>
// ============================================================================
//
// Wraps a conditionally-rendered element with CSS-class-driven
// enter/leave animations. Same swap pattern as `<Show>` — but
// instead of an instant mount/unmount, we add transition classes
// for the browser to animate against, and only remove the element
// from the DOM after the leave animation has finished.
//
// VUE-STYLE 6-CLASS CONVENTION:
//
//   With `name: 'fade'`, the component applies these classes
//   during the transition:
//
//     `${name}-enter-from`     — initial state at enter start
//     `${name}-enter-active`   — present throughout enter
//     `${name}-enter-to`       — final state at enter end
//     `${name}-leave-from`     — initial state at leave start
//     `${name}-leave-active`   — present throughout leave
//     `${name}-leave-to`       — final state at leave end
//
//   Pair with CSS like:
//
//     .fade-enter-from, .fade-leave-to    { opacity: 0; }
//     .fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
//     .fade-enter-to, .fade-leave-from    { opacity: 1; }
//
// LIFECYCLE:
//
//   Enter (when toggles false → true):
//     1. Mount the element, append to container
//     2. Add enter-from + enter-active
//     3. Force reflow so the browser paints the "from" state
//     4. Next animation frame: remove enter-from, add enter-to
//        → CSS transition runs
//     5. On transitionend (or duration timeout): clear all classes
//
//   Leave (when toggles true → false):
//     1. Element is in DOM
//     2. Add leave-from + leave-active
//     3. Force reflow
//     4. Next animation frame: remove leave-from, add leave-to
//     5. On transitionend: remove element from DOM, run cleanup
//
// FIRST RUN — NO ENTER ANIMATION:
//
//   Matches Vue's `appear: false` default — the initial mount is
//   instant, so the page doesn't show a wave of fade-ins on load.
//   Animations kick in only when the user actually toggles state.
//
// IN-FLIGHT TOGGLES:
//
//   v1 queues a single pending change instead of cancelling. If
//   `when` flips during an enter, we let the enter complete and
//   then immediately start the leave. The result feels right for
//   most clicks-twice scenarios; mid-flight reversal is left for
//   v1.x.
//
// FALLBACK TIMEOUT:
//
//   If the user forgot to actually define a CSS transition,
//   `transitionend` never fires. We arm a setTimeout for
//   `duration` ms (default 1000) so the state machine can never
//   wedge.
//
// ============================================================================

import type { DisposeFn } from '@azerothjs/reactivity';
import { createEffect, createRoot, onRootDispose } from '@azerothjs/reactivity';
import { destroyComponent } from '@azerothjs/component';

/**
 * Props for the `<Transition>` component.
 */
export interface TransitionProps
{
    /** Reactive boolean — true to show the element, false to hide. */
    when: () => boolean;

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
 * Renders `children()` only while `when()` returns true, with CSS
 * enter/leave animations driven by the `name` prop.
 *
 * Skip the `name` prop for an instant swap (the same behaviour as
 * `<Show>` — useful when you want the option of animating without
 * committing to it for every render).
 *
 * @param props - `{ when, children, name?, duration? }`
 *
 * @returns An invisible (`display: contents`) container that owns
 *          the animated child element.
 *
 * @example
 * ```ts
 * const [isOpen, setIsOpen] = createSignal(false);
 *
 * Transition({
 *     when: isOpen,
 *     name: 'fade',
 *     children: () => h('div', { class: 'modal' }, 'Hi!')
 * });
 *
 * // CSS:
 * //   .fade-enter-from, .fade-leave-to    { opacity: 0; }
 * //   .fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
 * //   .fade-enter-to, .fade-leave-from    { opacity: 1; }
 * ```
 *
 * @example
 * ```ts
 * // No name prop → instant swap, identical to <Show>.
 * Transition({
 *     when: isOpen,
 *     children: () => h('p', {}, 'Instantly visible')
 * });
 * ```
 */
export function Transition(props: TransitionProps): HTMLElement
{
    const container = document.createElement('span');
    container.style.display = 'contents';

    let currentEl: HTMLElement | null = null;
    let currentDispose: DisposeFn | null = null;
    let phase: Phase = 'idle';

    /**
     * Queued target state when a toggle arrives mid-transition.
     * `null` means no pending change. We only ever queue ONE
     * level deep — if the user toggles three times in quick
     * succession, the middle hop is silently coalesced.
     */
    let pendingShouldShow: boolean | null = null;

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
        if (!props.name) return null;
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
            container.appendChild(el);
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
        if (!currentEl) return;
        const el = currentEl;
        const dispose = currentDispose;
        currentEl = null;
        currentDispose = null;
        if (container.contains(el))
        {
            container.removeChild(el);
        }
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

        function finish(): void
        {
            if (done) return;
            done = true;
            el.removeEventListener('transitionend', handler);
            clearTimeout(timer);
            callback();
        }

        function handler(event: Event): void
        {
            // Ignore transitionend from descendant elements that
            // bubble up to our target — only count the outer
            // element's own transition completion.
            if (event.target !== el) return;
            finish();
        }

        el.addEventListener('transitionend', handler);
        const timer = setTimeout(finish, duration);
    }

    /**
     * Runs the enter sequence on `currentEl`. No-op if there's
     * no name (instant mount path).
     */
    function startEnter(): void
    {
        if (!currentEl) return;
        const cls = classFamily('enter');
        if (!cls)
        {
            phase = 'idle';
            checkPending();
            return;
        }

        const el = currentEl;
        phase = 'entering';
        el.classList.add(cls.from, cls.active);

        // Force a reflow so the browser commits the "from" state
        // before we add the "to" class on the next frame.
        void el.offsetHeight;

        requestAnimationFrame(() =>
        {
            // Bail if the state changed while we were waiting.
            if (phase !== 'entering' || currentEl !== el) return;

            el.classList.remove(cls.from);
            el.classList.add(cls.to);

            waitForEndOrTimeout(el, () =>
            {
                if (phase !== 'entering' || currentEl !== el) return;
                el.classList.remove(cls.active, cls.to);
                phase = 'idle';
                checkPending();
            });
        });
    }

    /**
     * Runs the leave sequence and removes `currentEl` from the
     * DOM when it finishes. No-op (just unmounts) if no name.
     */
    function startLeave(): void
    {
        if (!currentEl) return;

        const cls = classFamily('leave');
        if (!cls)
        {
            unmountElImmediate();
            phase = 'idle';
            checkPending();
            return;
        }

        const el = currentEl;
        const dispose = currentDispose;
        phase = 'leaving';
        el.classList.add(cls.from, cls.active);

        void el.offsetHeight;

        requestAnimationFrame(() =>
        {
            if (phase !== 'leaving' || currentEl !== el) return;

            el.classList.remove(cls.from);
            el.classList.add(cls.to);

            waitForEndOrTimeout(el, () =>
            {
                if (phase !== 'leaving' || currentEl !== el) return;
                if (container.contains(el))
                {
                    container.removeChild(el);
                }
                dispose?.();
                destroyComponent(el);
                currentEl = null;
                currentDispose = null;
                phase = 'idle';
                checkPending();
            });
        });
    }

    /**
     * After a transition completes, applies any queued state
     * change. The queue is at most one element deep — multiple
     * rapid toggles collapse to the most recent.
     */
    function checkPending(): void
    {
        if (pendingShouldShow === null) return;
        const shouldShow = pendingShouldShow;
        pendingShouldShow = null;

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

    // ── Reactive driver ──────────────────────────────────────
    //
    // First run: instant mount (no enter animation), matching
    // Vue's `appear: false` default. Subsequent runs: animate the
    // transition (or queue if one is in flight).
    let isFirstRun = true;
    createEffect(() =>
    {
        const shouldShow = props.when();

        if (isFirstRun)
        {
            isFirstRun = false;
            if (shouldShow) mountEl();
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
        else
        {
            // A transition is in flight — record where we want
            // to end up, and let the current cycle finish.
            pendingShouldShow = shouldShow;
        }
    });

    // Force-cleanup on root dispose. We skip animations here —
    // when the surrounding scope unmounts there's no DOM target
    // to animate against.
    onRootDispose(() =>
    {
        unmountElImmediate();
    });

    return container as unknown as HTMLElement;
}
