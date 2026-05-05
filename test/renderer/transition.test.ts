import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, createSignal } from '@azerothjs/core';
import { Transition } from '../../packages/renderer/src/transition.ts';

// ── Test helpers ─────────────────────────────────────────────
//
// `requestAnimationFrame` is async and unpredictable in tests.
// We replace it with a queue we can flush manually so each test
// can step through the enter/leave lifecycle deterministically.

let rafCallbacks: Array<(time: number) => void> = [];

/** Runs every queued rAF callback once, then clears the queue. */
function flushRaf(): void
{
    const cbs = rafCallbacks;
    rafCallbacks = [];
    for (const cb of cbs) cb(performance.now());
}

/** Dispatches a synthetic `transitionend` event on `el`. */
function fireTransitionEnd(el: HTMLElement): void
{
    el.dispatchEvent(new Event('transitionend'));
}

/** Returns the single child element of the Transition's container. */
function getChild(container: HTMLElement): HTMLElement | null
{
    return container.firstElementChild as HTMLElement | null;
}

// ─────────────────────────────────────────────────────────────

describe('<Transition>', () =>
{
    let originalRaf: typeof window.requestAnimationFrame;

    beforeEach(() =>
    {
        rafCallbacks = [];
        originalRaf = window.requestAnimationFrame;
        window.requestAnimationFrame = (cb): number =>
        {
            rafCallbacks.push(cb);
            return rafCallbacks.length;
        };
    });

    afterEach(() =>
    {
        window.requestAnimationFrame = originalRaf;
        vi.useRealTimers();
    });

    it('mounts children immediately when when() is initially true (no enter animation)', () =>
    {
        createRoot((dispose) =>
        {
            const [isOpen] = createSignal(true);
            const container = Transition({
                when: isOpen,
                name: 'fade',
                children: () =>
                {
                    const div = document.createElement('div');
                    div.setAttribute('data-id', 'child');
                    div.textContent = 'hello';
                    return div;
                }
            });

            const child = getChild(container);
            expect(child).not.toBeNull();
            expect(child!.getAttribute('data-id')).toBe('child');

            // First-run mount must NOT apply enter classes —
            // we want the page-load to look stable, not flash
            // every animated element on first paint.
            expect(child!.classList.contains('fade-enter-from')).toBe(false);
            expect(child!.classList.contains('fade-enter-active')).toBe(false);

            dispose();
        });
    });

    it('runs the enter cycle when when() toggles false → true', () =>
    {
        createRoot((dispose) =>
        {
            const [isOpen, setIsOpen] = createSignal(false);
            const container = Transition({
                when: isOpen,
                name: 'fade',
                children: () =>
                {
                    const div = document.createElement('div');
                    div.setAttribute('data-id', 'child');
                    return div;
                }
            });

            // Starts hidden — no child yet.
            expect(getChild(container)).toBeNull();

            setIsOpen(true);

            // Synchronously after toggle: enter-from + enter-active.
            const child = getChild(container);
            expect(child).not.toBeNull();
            expect(child!.classList.contains('fade-enter-from')).toBe(true);
            expect(child!.classList.contains('fade-enter-active')).toBe(true);
            expect(child!.classList.contains('fade-enter-to')).toBe(false);

            // Next frame: enter-from is replaced by enter-to.
            flushRaf();
            expect(child!.classList.contains('fade-enter-from')).toBe(false);
            expect(child!.classList.contains('fade-enter-to')).toBe(true);
            expect(child!.classList.contains('fade-enter-active')).toBe(true);

            // Transition end: all classes cleared, element stays.
            fireTransitionEnd(child!);
            expect(child!.classList.contains('fade-enter-active')).toBe(false);
            expect(child!.classList.contains('fade-enter-to')).toBe(false);
            expect(getChild(container)).toBe(child); // still mounted

            dispose();
        });
    });

    it('keeps the element in the DOM throughout the leave cycle, removes only after transitionend', () =>
    {
        createRoot((dispose) =>
        {
            const [isOpen, setIsOpen] = createSignal(true);
            const container = Transition({
                when: isOpen,
                name: 'fade',
                children: () =>
                {
                    const div = document.createElement('div');
                    div.setAttribute('data-id', 'child');
                    return div;
                }
            });

            const child = getChild(container);
            expect(child).not.toBeNull();

            setIsOpen(false);

            // Leave classes applied immediately. Crucially, the
            // element is STILL in the DOM — that's what gives the
            // browser a chance to animate it.
            expect(child!.classList.contains('fade-leave-from')).toBe(true);
            expect(child!.classList.contains('fade-leave-active')).toBe(true);
            expect(getChild(container)).toBe(child);

            flushRaf();
            expect(child!.classList.contains('fade-leave-from')).toBe(false);
            expect(child!.classList.contains('fade-leave-to')).toBe(true);
            expect(getChild(container)).toBe(child); // still mounted

            // Only after transitionend does the element actually
            // leave the DOM.
            fireTransitionEnd(child!);
            expect(getChild(container)).toBeNull();

            dispose();
        });
    });

    it('falls back to instant swap when no name is provided', () =>
    {
        createRoot((dispose) =>
        {
            const [isOpen, setIsOpen] = createSignal(false);
            const container = Transition({
                when: isOpen,
                children: () =>
                {
                    const div = document.createElement('div');
                    div.setAttribute('data-id', 'child');
                    return div;
                }
            });

            // No name → no animation → behaves like Show.
            setIsOpen(true);
            const child = getChild(container);
            expect(child).not.toBeNull();
            // No classes were added because there's no name family.
            expect(child!.className).toBe('');

            setIsOpen(false);
            // No leave animation either — element gone immediately.
            expect(getChild(container)).toBeNull();

            dispose();
        });
    });

    it('completes via fallback timeout when transitionend never fires', () =>
    {
        // Use fake timers so we can advance to the fallback
        // timeout without actually waiting 1s in real time.
        vi.useFakeTimers();

        createRoot((dispose) =>
        {
            const [isOpen, setIsOpen] = createSignal(false);
            const container = Transition({
                when: isOpen,
                name: 'fade',
                duration: 100,
                children: () =>
                {
                    const div = document.createElement('div');
                    div.setAttribute('data-id', 'child');
                    return div;
                }
            });

            setIsOpen(true);
            flushRaf();

            const child = getChild(container);
            // Mid-transition — still has active class.
            expect(child!.classList.contains('fade-enter-active')).toBe(true);

            // Advance past the fallback timeout. transitionend
            // never fires, but the timeout brings the cycle to
            // a clean end.
            vi.advanceTimersByTime(150);
            expect(child!.classList.contains('fade-enter-active')).toBe(false);
            expect(child!.classList.contains('fade-enter-to')).toBe(false);

            dispose();
        });
    });

    it('queues a mid-transition toggle and applies it after the current cycle', () =>
    {
        createRoot((dispose) =>
        {
            const [isOpen, setIsOpen] = createSignal(false);
            const container = Transition({
                when: isOpen,
                name: 'fade',
                children: () =>
                {
                    const div = document.createElement('div');
                    div.setAttribute('data-id', 'child');
                    return div;
                }
            });

            // Begin entering.
            setIsOpen(true);
            const enteringChild = getChild(container);
            expect(enteringChild).not.toBeNull();
            expect(enteringChild!.classList.contains('fade-enter-active')).toBe(true);

            // While the enter animation is in flight, toggle to
            // hide. The change is queued — no leave classes yet.
            setIsOpen(false);
            expect(enteringChild!.classList.contains('fade-leave-active')).toBe(false);
            expect(getChild(container)).toBe(enteringChild); // still mounted

            // Complete the enter cycle.
            flushRaf();
            fireTransitionEnd(enteringChild!);

            // Now the queued leave should kick in synchronously
            // — leave classes applied to the same element.
            expect(enteringChild!.classList.contains('fade-leave-active')).toBe(true);
            expect(enteringChild!.classList.contains('fade-leave-from')).toBe(true);
            expect(getChild(container)).toBe(enteringChild); // still mounted

            // Finish the leave too.
            flushRaf();
            fireTransitionEnd(enteringChild!);
            expect(getChild(container)).toBeNull();

            dispose();
        });
    });
});
