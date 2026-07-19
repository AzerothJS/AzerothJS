// @vitest-environment happy-dom
//
// TransitionGroup: keyed items animate in on join and defer removal while their
// leave plays. Same assertion philosophy as transition.spec.ts - deterministic
// end states, not frame-precise class snapshots.
import { describe, it, expect } from 'vitest';
import { createSignal } from '@azerothjs/reactivity';
import { h, render, TransitionGroup } from '@azerothjs/renderer';

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

interface Toast { id: number; text: string }

function mount(initial: Toast[]): { container: HTMLElement; set: (next: Toast[]) => void }
{
    const container = makeContainer();
    const [items, setItems] = createSignal<Toast[]>(initial);
    render(() => h('div', {}, TransitionGroup({
        each: items,
        key: (t: Toast) => t.id,
        name: 'toast',
        duration: 40,
        children: (t: Toast) => h('p', { class: 'toast', 'data-id': String(t.id) }, t.text)
    })), container);
    return { container, set: setItems };
}

const ids = (container: HTMLElement): string[] =>
    [...container.querySelectorAll('.toast')].map((el) => el.getAttribute('data-id') ?? '');

describe('TransitionGroup', () =>
{
    it('renders the initial list instantly, in order, without enter classes', () =>
    {
        const { container } = mount([{ id: 1, text: 'a' }, { id: 2, text: 'b' }]);
        expect(ids(container)).toEqual(['1', '2']);
        expect(container.querySelector('.toast-enter-active')).toBeNull();
        container.remove();
    });

    it('a joining item mounts immediately and plays the enter family', async () =>
    {
        const { container, set } = mount([{ id: 1, text: 'a' }]);
        set([{ id: 1, text: 'a' }, { id: 2, text: 'b' }]);
        expect(ids(container)).toEqual(['1', '2']);

        // Mid-enter: the new item carries the active class; the old one does not.
        const second = container.querySelector('[data-id="2"]');
        expect(second?.classList.contains('toast-enter-active')).toBe(true);

        await settle(80);
        expect(second?.classList.contains('toast-enter-active')).toBe(false);
        container.remove();
    });

    it('a departing item stays in the DOM while its leave plays, then is removed', async () =>
    {
        const { container, set } = mount([{ id: 1, text: 'a' }, { id: 2, text: 'b' }]);
        set([{ id: 2, text: 'b' }]);

        // Deferred removal: still present, playing its exit.
        expect(ids(container)).toEqual(['1', '2']);
        const leavingEl = container.querySelector('[data-id="1"]');
        expect(leavingEl?.classList.contains('toast-leave-active')).toBe(true);

        await settle(80);
        expect(ids(container)).toEqual(['2']);
        container.remove();
    });

    it('items inserted while another leaves land in the right order around it', async () =>
    {
        const { container, set } = mount([{ id: 1, text: 'a' }, { id: 2, text: 'b' }]);
        set([{ id: 2, text: 'b' }]);                                // 1 starts leaving
        set([{ id: 3, text: 'c' }, { id: 2, text: 'b' }]);          // 3 joins at the front

        await settle(80);
        expect(ids(container)).toEqual(['3', '2']);
        container.remove();
    });

    it('surviving items keep their element identity across joins and departures', async () =>
    {
        const { container, set } = mount([{ id: 1, text: 'a' }, { id: 2, text: 'b' }]);
        const keeper = container.querySelector('[data-id="2"]');
        set([{ id: 2, text: 'b' }, { id: 3, text: 'c' }]);
        await settle(80);
        expect(container.querySelector('[data-id="2"]')).toBe(keeper);
        container.remove();
    });

    it('without a name, items swap instantly (For semantics)', () =>
    {
        const container = makeContainer();
        const [items, setItems] = createSignal<Toast[]>([{ id: 1, text: 'a' }]);
        render(() => h('div', {}, TransitionGroup({
            each: items,
            key: (t: Toast) => t.id,
            children: (t: Toast) => h('p', { class: 'toast', 'data-id': String(t.id) }, t.text)
        })), container);

        setItems([{ id: 2, text: 'b' }]);
        expect(ids(container)).toEqual(['2']);
        container.remove();
    });

    it('reordering repositions surviving items (no animation, documented v1)', () =>
    {
        const { container, set } = mount([{ id: 1, text: 'a' }, { id: 2, text: 'b' }, { id: 3, text: 'c' }]);
        set([{ id: 3, text: 'c' }, { id: 1, text: 'a' }, { id: 2, text: 'b' }]);
        expect(ids(container)).toEqual(['3', '1', '2']);
        container.remove();
    });
});
