/**
 * MODULE: form/field-array
 *
 * createFieldArray manages a DYNAMIC LIST of repeated sub-forms - invoice line items, multiple phone
 * numbers, survey answers - by composing one {@link createForm} per row. It owns the add/remove/reorder
 * operations plus the per-row reactive lifecycle, and exposes aggregated values()/isValid()/error() so the
 * list joins a parent submit as a single unit.
 *
 * WHY A HELPER (not just an array): each row is a full createForm with its own validation effects (and any
 * async timers). Removing a row must DISPOSE that row's reactive scope or it leaks; a plain
 * `createSignal<FormApi[]>` cannot, because the row forms live in the parent scope, outside any <For>'s
 * per-key disposal. createFieldArray gives each row its own createRoot, disposes it on remove(), and tears
 * down whatever remains when the surrounding scope unmounts.
 *
 * BINDING ROWS: the `bind:value={f.field}` sugar is recognised by the compiler only for a top-level `form`
 * declaration; a row form here is a runtime object, so bind a row field with the explicit createForm API -
 * spread `{...row.form.register('field')}` onto the input (which also applies numeric coercion), or read
 * `row.form.values()` / write `row.form.setValue(...)` by hand. The `form` keyword stays for flat forms;
 * arrays compose below it.
 */

import type { Getter } from '@azerothjs/reactivity';
import { createSignal, createMemo, createRoot, onRootDispose } from '@azerothjs/reactivity';
import { createForm } from './create-form.ts';
import type { FormApi, FormConfig } from './create-form.ts';

/**
 * Options passed to `createFieldArray()`.
 *
 * @typeParam T - The shape of ONE row.
 */
export interface FieldArrayConfig<T extends object>
{
    /** Factory for a fresh, blank row. Called by `append()` and to seed new rows. */
    blank: () => T;

    /** Initial rows. Defaults to an empty list. */
    initial?: T[];

    /** Per-row, per-field sync validators - forwarded verbatim to each row's `createForm`. */
    validate?: FormConfig<T>['validate'];

    /** Per-row cross-field validation - forwarded verbatim to each row's `createForm`. */
    validateForm?: FormConfig<T>['validateForm'];

    /** Per-row async validators - forwarded verbatim to each row's `createForm`. */
    validateAsync?: FormConfig<T>['validateAsync'];

    /** Debounce (ms) for per-row async validators - forwarded verbatim to each row's `createForm`. */
    asyncDebounceMs?: FormConfig<T>['asyncDebounceMs'];

    /**
     * Array-LEVEL validation: a rule over the whole list (minimum/maximum length, "no duplicate emails").
     * Returns an error message or `null`. Surfaced as {@link FieldArrayApi.error} and folded into
     * {@link FieldArrayApi.isValid}.
     */
    validateArray?: (rows: T[]) => string | null;
}

/**
 * One row of a field array: a stable `key` (for `<For>` identity across reorder/remove) plus the row's
 * `form`.
 *
 * @typeParam T - The shape of one row.
 */
export interface FieldArrayRow<T extends object>
{
    /** Stable identity for `<For key={(row) => row.key}>`; survives reorder and removal. */
    key: number;

    /** The row's form. Bind its fields with `{...row.form.register('field')}`. */
    form: FormApi<T>;
}

/**
 * The API returned by `createFieldArray()`.
 *
 * @typeParam T - The shape of one row.
 */
export interface FieldArrayApi<T extends object>
{
    /** Reactive list of rows. Pass to `<For each={fa.rows()} key={(row) => row.key}>`. */
    rows: Getter<FieldArrayRow<T>[]>;

    /** Reactive aggregated snapshot: every row's values, in order. */
    values: Getter<T[]>;

    /** True when every row is valid AND the array-level rule passes. */
    isValid: Getter<boolean>;

    /** The array-level error from `validateArray` (or `null`). */
    error: Getter<string | null>;

    /** Appends a new row from `blank()`, optionally overriding some fields. */
    append: (init?: Partial<T>) => void;

    /** Removes the row at `index`, disposing its reactive scope. */
    remove: (index: number) => void;

    /** Moves the row at `from` to `to`, preserving each row's identity (and DOM, under `<For>`). */
    move: (from: number, to: number) => void;

    /**
     * Reveals every row's errors (marks fields touched and re-validates, as a submit would) and returns the
     * current {@link isValid}. Call from the parent's submit handler to gate submission on the rows. Sync:
     * it does not await async row validators, whose results land live in each row's errors.
     */
    validateAll: () => boolean;

    /** Disposes all rows and rebuilds the list from `initial`. */
    reset: () => void;
}

/**
 * createFieldArray
 *
 * PURPOSE:
 * Manages a dynamic list of repeated sub-forms, one {@link createForm} per row, with add/remove/reorder and
 * aggregated values()/isValid()/error().
 *
 * WHY IT EXISTS:
 * A repeating sub-form needs each row independently validated yet the whole list submitted together, and
 * every removed row's validation effects disposed so they do not leak. Hand-rolling that is the awkward,
 * error-prone part; createFieldArray owns the per-row createRoot/dispose lifecycle and the aggregation
 * memos, leaving authoring to `<For>` + `register`.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, form; pure composition over createForm + signals/memos. It adds no new validation concepts - row
 * validators are the same `validate`/`validateForm`/`validateAsync` as a flat form.
 *
 * INPUT CONTRACT:
 * - config.blank: factory for a new row.
 * - config.initial?: starting rows (default none).
 * - config.validate?/validateForm?/validateAsync?: per-row validators, forwarded to each row's createForm.
 * - config.validateArray?: array-level rule over all row values.
 *
 * OUTPUT CONTRACT:
 * - A {@link FieldArrayApi}: rows()/values()/isValid()/error() getters plus append/remove/move/validateAll/
 *   reset.
 *
 * WHY THIS DESIGN:
 * Each row gets its own createRoot so remove() can dispose exactly that row; an onRootDispose tears down any
 * rows still present when the surrounding scope unmounts. Stable monotonic keys let `<For>` reuse DOM across
 * reorder and removal.
 *
 * WHEN TO USE:
 * A list of repeated, individually-validated sub-forms.
 *
 * WHEN NOT TO USE:
 * A flat form (use the `form` keyword / createForm). A fixed, non-repeating group (just more fields).
 *
 * EDGE CASES:
 * - Bind row fields with `{...row.form.register('field')}` - the `bind:value` sugar is form-keyword only.
 * - validateAll() is synchronous; async row validators resolve into each row's errors independently.
 *
 * @typeParam T - The shape of one row, inferred from `blank`.
 * @param config - The field-array configuration.
 * @returns A {@link FieldArrayApi}.
 *
 * @example
 * ```ts
 * const items = createFieldArray({
 *     blank: () => ({ description: '', qty: 1, price: 0 }),
 *     validate: { description: required(), qty: min(1), price: min(0) },
 *     validateArray: (rows) => rows.length === 0 ? 'Add at least one item' : null
 * });
 *
 * items.append();                 // add a blank row
 * items.remove(0);                // remove + dispose row 0
 * const total = () => items.values().reduce((sum, r) => sum + r.qty * r.price, 0);
 * ```
 */
export function createFieldArray<T extends object>(config: FieldArrayConfig<T>): FieldArrayApi<T>
{
    // Monotonic row identity and per-row teardown. Each row's createForm lives in its own createRoot so its
    // validation effects (and any async timers) can be disposed exactly when that row is removed.
    let nextKey = 0;
    const disposers = new Map<number, () => void>();

    function buildRow(value: T): FieldArrayRow<T>
    {
        const key = nextKey;
        nextKey += 1;

        let dispose: () => void = () =>
        { /* set synchronously below */ };
        const form = createRoot((rootDispose) =>
        {
            dispose = rootDispose;
            return createForm<T>({
                initial: value,
                validate: config.validate,
                validateForm: config.validateForm,
                validateAsync: config.validateAsync,
                asyncDebounceMs: config.asyncDebounceMs
            });
        });

        disposers.set(key, dispose);
        return { key, form };
    }

    function disposeRow(key: number): void
    {
        const dispose = disposers.get(key);
        if (dispose)
        {
            disposers.delete(key);
            dispose();
        }
    }

    const [rows, setRows] = createSignal<FieldArrayRow<T>[]>(
        (config.initial ?? []).map((value) => buildRow(value))
    );

    // Aggregation: values recomputes when the row set changes or any row's values change.
    const values = createMemo<T[]>(() => rows().map((row) => row.form.values()));

    const error = createMemo<string | null>(() =>
        config.validateArray ? config.validateArray(values()) : null
    );

    const isValid = createMemo<boolean>(() =>
        error() === null && rows().every((row) => row.form.isValid())
    );

    function append(init?: Partial<T>): void
    {
        const value = init ? { ...config.blank(), ...init } : config.blank();
        setRows((prev) => [...prev, buildRow(value)]);
    }

    function remove(index: number): void
    {
        setRows((prev) =>
        {
            const row = prev[index];
            if (!row)
            {
                return prev;
            }
            disposeRow(row.key);
            return prev.filter((_, i) => i !== index);
        });
    }

    function move(from: number, to: number): void
    {
        setRows((prev) =>
        {
            if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length)
            {
                return prev;
            }
            const next = [...prev];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            return next;
        });
    }

    function validateAll(): boolean
    {
        // Reveal each row's errors the way a submit would (mark fields touched + re-validate). The row forms
        // carry no onSubmit, so handleSubmit only touches and validates. Validity is read live afterwards.
        const event = { preventDefault()
        { /* no-op */ } } as unknown as Event;
        for (const row of rows())
        {
            row.form.handleSubmit(event);
        }
        return isValid();
    }

    function reset(): void
    {
        for (const row of rows())
        {
            disposeRow(row.key);
        }
        setRows((config.initial ?? []).map((value) => buildRow(value)));
    }

    // Tear down any rows still present when the surrounding scope unmounts.
    onRootDispose(() =>
    {
        for (const dispose of disposers.values())
        {
            dispose();
        }
        disposers.clear();
    });

    return { rows, values, isValid, error, append, remove, move, validateAll, reset };
}
