// @vitest-environment happy-dom
//
// The highest-frequency defect found by building real applications on this framework: a keyed row
// is built once from its item, so a list whose keys are ids and whose rows show mutable fields
// renders stale data forever. Two unrelated products hit it independently, the second AFTER it had
// been documented. A dev warning is the non-breaking half of the fix.
import { describe, expect, it, vi } from 'vitest';
import { createRoot, createSignal, h, For } from 'azerothjs';

interface Row
{
    id: string;
    status: string;
}

function attach(rows: () => Row[], key: (row: Row) => string): () => void
{
    return createRoot((dispose) =>
    {
        const list = For({
            each: rows,
            key,
            children: (row: Row) => h('li', { 'data-status': row.status }, row.status)
        });
        document.body.append(list);
        return dispose;
    });
}

describe('<For> stale-row warning', () =>
{
    it('warns when a reused row\'s item changed contents under a stable key', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const [rows, set] = createSignal<Row[]>([{ id: 'a', status: 'active' }]);
        const dispose = attach(rows, (row) => row.id);

        // Same id, different status: exactly the shape both applications shipped.
        set([{ id: 'a', status: 'archived' }]);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain('kept its key');
        expect(String(warn.mock.calls[0]?.[0])).toContain('status');

        warn.mockRestore();
        dispose();
    });

    it('stays silent when the key changes with the content', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const [rows, set] = createSignal<Row[]>([{ id: 'a', status: 'active' }]);
        // Folding the mutable field into the key is one of the two documented fixes.
        const dispose = attach(rows, (row) => `${ row.id }:${ row.status }`);

        set([{ id: 'a', status: 'archived' }]);
        expect(warn).not.toHaveBeenCalled();

        warn.mockRestore();
        dispose();
    });

    it('stays silent for an unchanged item', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const row: Row = { id: 'a', status: 'active' };
        const [rows, set] = createSignal<Row[]>([row]);
        const dispose = attach(rows, (item) => item.id);

        // Same reference, and a re-render: nothing is stale.
        set([row]);
        expect(warn).not.toHaveBeenCalled();

        warn.mockRestore();
        dispose();
    });
});
