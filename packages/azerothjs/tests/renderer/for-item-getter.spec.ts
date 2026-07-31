// @vitest-environment happy-dom
//
// The 2.0 row contract: the row builder receives the item as a GETTER, so a key that stays
// stable while its item is REPLACED (the immutable-update pattern every store produces) updates
// the row in place instead of freezing the values the row was built from. This was the single
// highest-frequency defect across the applications built on the framework; the old by-value
// contract could only warn about it.
import { describe, it, expect } from 'vitest';
import { createSignal, h, render, For } from 'azerothjs';

interface Row { id: number; name: string }

function mount(component: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(component, container);
    return container;
}

describe('For - item getter', () =>
{
    it('a replaced item (same key, new object) updates the row in place', () =>
    {
        const [items, setItems] = createSignal<Row[]>([{ id: 1, name: 'before' }]);
        const container = mount(() => h('ul', {}, For({
            each: items,
            key: (row) => row.id,
            children: (row) => h('li', {}, () => row().name)
        })));

        const el = container.querySelector('li') as HTMLElement;
        expect(el.textContent).toBe('before');

        setItems([{ id: 1, name: 'after' }]);

        expect(container.querySelector('li')).toBe(el);
        expect(el.textContent).toBe('after');
    });

    it('an identical item reference does not disturb the row', () =>
    {
        const row = { id: 1, name: 'stable' };
        const [items, setItems] = createSignal<Row[]>([row]);
        let builds = 0;
        const container = mount(() => h('ul', {}, For({
            each: items,
            key: (item) => item.id,
            children: (row) =>
            {
                builds += 1;
                return h('li', {}, () => row().name);
            }
        })));

        const el = container.querySelector('li') as HTMLElement;
        setItems([row]);

        expect(builds).toBe(1);
        expect(container.querySelector('li')).toBe(el);
        expect(el.textContent).toBe('stable');
    });

    it('getter and index stay correct together across a reorder that also replaces', () =>
    {
        const [items, setItems] = createSignal<Row[]>([
            { id: 1, name: 'a' },
            { id: 2, name: 'b' }
        ]);
        const container = mount(() => h('ul', {}, For({
            each: items,
            key: (row) => row.id,
            children: (row, index) => h('li', {}, () => `${ index() }:${ row().name }`)
        })));

        const [first, second] = Array.from(container.querySelectorAll('li'));
        expect(first?.textContent).toBe('0:a');
        expect(second?.textContent).toBe('1:b');

        setItems([
            { id: 2, name: 'B' },
            { id: 1, name: 'a' }
        ]);

        const after = Array.from(container.querySelectorAll('li'));
        expect(after[0]).toBe(second);
        expect(after[1]).toBe(first);
        expect(after[0]?.textContent).toBe('0:B');
        expect(after[1]?.textContent).toBe('1:a');
    });
});
