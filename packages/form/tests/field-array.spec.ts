// @vitest-environment node
//
// Behavioral coverage for createFieldArray (field-array.ts). Like createForm, the state is
// DOM-independent - rows/values/isValid/error are signals/memos and append/remove/move/reset/validateAll
// are plain methods - so this suite runs in a DOM-less node environment. Each array is built inside a
// createRoot so its (and its rows') effects have an owner, and the root is disposed at the end.
import { describe, it, expect } from 'vitest';
import { createRoot } from '@azerothjs/reactivity';
import { createFieldArray, required, min, combine } from '@azerothjs/form';
import type { FieldArrayApi } from '@azerothjs/form';

interface LineItem
{
    description: string;
    qty: number;
    price: number;
}

function blankItem(): LineItem
{
    return { description: '', qty: 1, price: 0 };
}

function flush(): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createFieldArray - rows + mutation', () =>
{
    it('starts from initial rows, each a form with a stable key', () =>
    {
        createRoot((dispose) =>
        {
            const items = createFieldArray<LineItem>({
                blank: blankItem,
                initial: [{ description: 'Setup', qty: 2, price: 100 }]
            });
            expect(items.rows()).toHaveLength(1);
            expect(items.rows()[0]!.form.values()).toEqual({ description: 'Setup', qty: 2, price: 100 });
            expect(typeof items.rows()[0]!.key).toBe('number');
            dispose();
        });
    });

    it('append adds a blank row (with optional overrides); keys stay unique', () =>
    {
        createRoot((dispose) =>
        {
            const items = createFieldArray<LineItem>({ blank: blankItem });
            items.append();
            items.append({ description: 'Hosting', price: 50 });
            expect(items.rows()).toHaveLength(2);
            expect(items.values()).toEqual([
                { description: '', qty: 1, price: 0 },
                { description: 'Hosting', qty: 1, price: 50 }
            ]);
            const keys = items.rows().map((row) => row.key);
            expect(new Set(keys).size).toBe(2);
            dispose();
        });
    });

    it('remove drops the row at an index', () =>
    {
        createRoot((dispose) =>
        {
            const items = createFieldArray<LineItem>({
                blank: blankItem,
                initial: [
                    { description: 'A', qty: 1, price: 1 },
                    { description: 'B', qty: 1, price: 2 },
                    { description: 'C', qty: 1, price: 3 }
                ]
            });
            items.remove(1);
            expect(items.values().map((v) => v.description)).toEqual(['A', 'C']);
            dispose();
        });
    });

    it('move reorders rows while preserving identity', () =>
    {
        createRoot((dispose) =>
        {
            const items = createFieldArray<LineItem>({
                blank: blankItem,
                initial: [
                    { description: 'A', qty: 1, price: 1 },
                    { description: 'B', qty: 1, price: 2 },
                    { description: 'C', qty: 1, price: 3 }
                ]
            });
            const keyA = items.rows()[0]!.key;
            items.move(0, 2);
            expect(items.values().map((v) => v.description)).toEqual(['B', 'C', 'A']);
            // The moved row kept its identity (same key, same form instance).
            expect(items.rows()[2]!.key).toBe(keyA);
            dispose();
        });
    });

    it('reset disposes current rows and rebuilds from initial', () =>
    {
        createRoot((dispose) =>
        {
            const items = createFieldArray<LineItem>({
                blank: blankItem,
                initial: [{ description: 'Seed', qty: 1, price: 9 }]
            });
            items.append({ description: 'Extra' });
            expect(items.rows()).toHaveLength(2);
            items.reset();
            expect(items.values()).toEqual([{ description: 'Seed', qty: 1, price: 9 }]);
            dispose();
        });
    });
});

describe('createFieldArray - aggregation + validation', () =>
{
    it('values() tracks edits to a row live', () =>
    {
        createRoot((dispose) =>
        {
            const items = createFieldArray<LineItem>({ blank: blankItem, initial: [blankItem()] });
            items.rows()[0]!.form.setValue('qty', 5);
            expect(items.values()[0]?.qty).toBe(5);
            dispose();
        });
    });

    it('isValid() folds per-row validity together', () =>
    {
        createRoot((dispose) =>
        {
            const items = createFieldArray<LineItem>({
                blank: blankItem,
                initial: [blankItem()],
                validate: { description: required('Required'), qty: min(1), price: min(0) }
            });
            // The blank row has an empty description -> invalid.
            expect(items.isValid()).toBe(false);
            items.rows()[0]!.form.setValue('description', 'Widget');
            expect(items.isValid()).toBe(true);
            dispose();
        });
    });

    it('validateArray drives error() and isValid()', () =>
    {
        createRoot((dispose) =>
        {
            const items = createFieldArray<LineItem>({
                blank: blankItem,
                validateArray: (rows) => rows.length === 0 ? 'Add at least one item' : null
            });
            expect(items.error()).toBe('Add at least one item');
            expect(items.isValid()).toBe(false);
            items.append();
            expect(items.error()).toBeNull();
            expect(items.isValid()).toBe(true);
            dispose();
        });
    });

    it('validateAll reveals row errors and reports overall validity', () =>
    {
        createRoot((dispose) =>
        {
            const items = createFieldArray<LineItem>({
                blank: blankItem,
                initial: [blankItem()],
                validate: { description: combine(required('Required')) }
            });
            // Nothing touched yet, but validity is live.
            expect(items.rows()[0]!.form.touched().description).toBe(false);
            const ok = items.validateAll();
            expect(ok).toBe(false);                                    // blank description is invalid
            expect(items.rows()[0]!.form.touched().description).toBe(true);  // revealed
            items.rows()[0]!.form.setValue('description', 'Widget');
            expect(items.validateAll()).toBe(true);
            dispose();
        });
    });
});

describe('createFieldArray - lifecycle', () =>
{
    it('disposes a removed row, aborting its in-flight async validation', async () =>
    {
        let aborted = false;
        const { items, dispose } = withFieldArray(() => createFieldArray<{ sku: string }>({
            blank: () => ({ sku: '' }),
            initial: [{ sku: 'seed' }],
            asyncDebounceMs: 0,
            validateAsync: {
                sku: (_value, signal) =>
                {
                    signal.addEventListener('abort', () =>
                    {
                        aborted = true;
                    });
                    return new Promise<string | null>(() =>
                    { /* never resolves */ });
                }
            }
        }));

        items.rows()[0]!.form.setValue('sku', 'changed');    // changed + sync-valid -> async fires
        await flush();
        expect(aborted).toBe(false);
        items.remove(0);                                    // disposing the row aborts its in-flight check
        expect(aborted).toBe(true);
        dispose();
    });

    it('disposes all remaining rows when the surrounding scope unmounts', async () =>
    {
        let aborted = false;
        const { items, dispose } = withFieldArray(() => createFieldArray<{ sku: string }>({
            blank: () => ({ sku: '' }),
            initial: [{ sku: 'seed' }],
            asyncDebounceMs: 0,
            validateAsync: {
                sku: (_value, signal) =>
                {
                    signal.addEventListener('abort', () =>
                    {
                        aborted = true;
                    });
                    return new Promise<string | null>(() =>
                    { /* never resolves */ });
                }
            }
        }));

        items.rows()[0]!.form.setValue('sku', 'changed');
        await flush();
        dispose();                                          // unmount -> onRootDispose tears down the row
        expect(aborted).toBe(true);
    });
});

// --- helpers -------------------------------------------------------------

// Builds a field array inside a createRoot and hands back its dispose, so a test can await async work
// outside the root callback and tear the owner down at the end.
function withFieldArray<T extends object>(
    build: () => FieldArrayApi<T>
): { items: FieldArrayApi<T>; dispose: () => void }
{
    let dispose!: () => void;
    const items = createRoot((d) =>
    {
        dispose = d;
        return build();
    });
    return { items, dispose };
}
