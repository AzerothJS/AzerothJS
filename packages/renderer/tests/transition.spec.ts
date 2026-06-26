// @vitest-environment happy-dom
//
// Behavioral coverage for Transition (transition.ts). The animated enter/leave
// path is rAF + transitionend driven; happy-dom does drive requestAnimationFrame
// and timers, so we assert the deterministic, observable outcomes: first-run
// instant mount (no enter animation), instant swap with no `name`, animated
// enter classes, and the duration-timeout backstop completing a leave with no
// real CSS transition. We DO NOT assert frame-precise intermediate class state
// (non-deterministic across rAF scheduling); we assert end states only.
import { describe, it, expect } from 'vitest';
import { createSignal, createRoot } from '@azerothjs/reactivity';
import { h, render, Transition } from '@azerothjs/renderer';

// Wait long enough for rAF + the fallback duration timeout to fully drive a
// leave/enter cycle to completion.
function settle(ms = 30): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeContainer(): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    return container;
}

describe('Transition — instant (no name)', () =>
{
    it('mounts the child when when is initially true', () =>
    {
        const container = makeContainer();
        const [on] = createSignal(true);
        render(() => h('div', {}, Transition({
            when: on,
            children: () => h('p', { class: 'box' }, 'content')
        })), container);
        expect(container.querySelector('.box')).not.toBeNull();
        container.remove();
    });

    it('swaps instantly (Show semantics) when no name is provided', () =>
    {
        const container = makeContainer();
        const [on, setOn] = createSignal(false);
        render(() => h('div', {}, Transition({
            when: on,
            children: () => h('p', { class: 'box' }, 'content')
        })), container);
        expect(container.querySelector('.box')).toBeNull();

        setOn(true);
        expect(container.querySelector('.box')).not.toBeNull();

        setOn(false);
        // No name -> immediate unmount, no transition wait.
        expect(container.querySelector('.box')).toBeNull();
        container.remove();
    });
});

describe('Transition — first-run mount is instant', () =>
{
    it('does not apply enter classes on the initial mount even with a name', () =>
    {
        const container = makeContainer();
        const [on] = createSignal(true);
        render(() => h('div', {}, Transition({
            when: on,
            name: 'fade',
            children: () => h('p', { class: 'box' }, 'content')
        })), container);
        const box = container.querySelector('.box')!;
        // First mount is instant (Vue appear:false): no enter-from class present.
        expect(box.classList.contains('fade-enter-from')).toBe(false);
        expect(box.classList.contains('fade-enter-active')).toBe(false);
        container.remove();
    });
});

describe('Transition — animated enter/leave (rAF + timeout backstop)', () =>
{
    it('adds enter classes when showing a hidden element with a name', async () =>
    {
        const container = makeContainer();
        const [on, setOn] = createSignal(false);
        render(() => h('div', {}, Transition({
            when: on,
            name: 'fade',
            duration: 5,
            children: () => h('p', { class: 'box' }, 'content')
        })), container);
        expect(container.querySelector('.box')).toBeNull();

        setOn(true);
        // The element is mounted synchronously and gets the active class.
        const box = container.querySelector('.box')!;
        expect(box).not.toBeNull();
        expect(box.classList.contains('fade-enter-active')).toBe(true);

        // After the cycle completes, transition classes are cleared.
        await settle();
        expect(box.classList.contains('fade-enter-active')).toBe(false);
        expect(box.classList.contains('fade-enter-from')).toBe(false);
        expect(box.classList.contains('fade-enter-to')).toBe(false);
        // Still in the DOM.
        expect(container.querySelector('.box')).toBe(box);
        container.remove();
    });

    it('defers removal during leave, then removes after the duration backstop fires', async () =>
    {
        const container = makeContainer();
        const [on, setOn] = createSignal(true);
        render(() => h('div', {}, Transition({
            when: on,
            name: 'fade',
            duration: 5,
            children: () => h('p', { class: 'box' }, 'content')
        })), container);
        const box = container.querySelector('.box')!;
        expect(box).not.toBeNull();

        setOn(false);
        // Leave started: element still present, marked with the leave-active class.
        expect(container.querySelector('.box')).toBe(box);
        expect(box.classList.contains('fade-leave-active')).toBe(true);

        // No real CSS transition fires transitionend; the duration timeout
        // backstops it and completes the leave (removal).
        await settle();
        expect(container.querySelector('.box')).toBeNull();
        container.remove();
    });

    it('completes a full leave-then-enter cycle and ends visible', async () =>
    {
        const container = makeContainer();
        const [on, setOn] = createSignal(true);
        render(() => h('div', {}, Transition({
            when: on,
            name: 'fade',
            duration: 5,
            children: () => h('p', { class: 'box' }, 'content')
        })), container);
        expect(container.querySelector('.box')).not.toBeNull();

        setOn(false);
        await settle();
        expect(container.querySelector('.box')).toBeNull();

        setOn(true);
        await settle();
        const box = container.querySelector('.box');
        expect(box).not.toBeNull();
        expect(box!.classList.contains('fade-enter-active')).toBe(false);
        container.remove();
    });
});

describe('Transition — root disposal', () =>
{
    it('removes the child immediately on surrounding-root dispose (no animation)', () =>
    {
        const container = makeContainer();
        const [on] = createSignal(true);
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            container.appendChild(h('div', {}, Transition({
                when: on,
                name: 'fade',
                children: () => h('p', { class: 'box' }, 'content')
            })));
        });
        expect(container.querySelector('.box')).not.toBeNull();

        dispose();
        expect(container.querySelector('.box')).toBeNull();
        container.remove();
    });
});
