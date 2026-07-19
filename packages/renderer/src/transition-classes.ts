/**
 * MODULE: renderer/transition-classes (internal)
 *
 * The one implementation of the 6-class enter/leave play that <Transition>,
 * <TransitionGroup>, and the router's <Routes transition> all drive: add
 * `{name}-{dir}-from` + `-active`, force a reflow, swap `-from` for `-to` on the
 * next frame, and settle on transitionend - with a duration backstop so a missing
 * CSS transition can never wedge a state machine. Exposed as @internal runtime for
 * the framework's own animated components; not application API.
 */

/** @internal Default transitionend backstop (ms). */
export const TRANSITION_FALLBACK_MS = 1000;

/**
 * Plays one direction of the class family on `el`; calls `onDone` exactly once
 * when the transition ends (or the backstop fires). Returns a cancel function
 * that detaches the wait and strips the family's classes WITHOUT calling
 * `onDone` - the caller decides what a cancellation means.
 *
 * `fromCurrent` skips the '-from' snap so the animation departs from the
 * element's current computed style (the reversal path).
 *
 * @internal
 */
export function playTransitionClasses(
    el: HTMLElement,
    name: string,
    direction: 'enter' | 'leave',
    duration: number | undefined,
    onDone: () => void,
    fromCurrent = false
): () => void
{
    const from = `${ name }-${ direction }-from`;
    const active = `${ name }-${ direction }-active`;
    const to = `${ name }-${ direction }-to`;

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function teardown(): void
    {
        el.removeEventListener('transitionend', handler);
        if (timer !== null)
        {
            clearTimeout(timer);
        }
    }

    function finish(): void
    {
        if (settled)
        {
            return;
        }
        settled = true;
        teardown();
        el.classList.remove(from, active, to);
        onDone();
    }

    function handler(event: Event): void
    {
        // Descendant transitions bubble; only the element's own completion counts.
        if (event.target === el)
        {
            finish();
        }
    }

    if (fromCurrent)
    {
        el.classList.add(active);
    }
    else
    {
        el.classList.add(from, active);
    }

    // Commit the "from" state before the "to" class lands on the next frame.
    void el.offsetHeight;

    requestAnimationFrame(() =>
    {
        if (settled)
        {
            return;
        }
        el.classList.remove(from);
        el.classList.add(to);
        el.addEventListener('transitionend', handler);
        timer = setTimeout(finish, duration ?? TRANSITION_FALLBACK_MS);
    });

    return (): void =>
    {
        if (settled)
        {
            return;
        }
        settled = true;
        teardown();
        el.classList.remove(from, active, to);
    };
}
