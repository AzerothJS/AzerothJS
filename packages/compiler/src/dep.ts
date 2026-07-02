/**
 * MODULE: compiler/dep - pure data types for reactive analysis
 *
 * Kept in their own module, free of any `typescript` import, so data layers like the Render Plan IR
 * (ir.ts) can use {@link Dep} / {@link ReactiveSources} without pulling the TypeScript compiler into
 * their dependency graph.
 *
 * @internal Compiler analysis data types; not part of the package's public API.
 */

/** The component's reactive sources, by name. */
export interface ReactiveSources
{
    /** `state` and `derived` declaration names. */
    names: ReadonlySet<string>;

    /** Whether `props` is a reactive source (its field reads track). */
    hasProps: boolean;

    /**
     * The subset of `names` that is WRITABLE - i.e. has a generated setter. Only `state`
     * is writable; `derived` is read-only. When set, the reactive rewrite rejects an
     * assignment/increment to any source NOT in this set (a `derived` write would otherwise
     * synthesize a call to a setter that is never defined). Omitted => no writability check
     * (every source treated as writable; used by isolated rewrite tests).
     */
    writable?: ReadonlySet<string>;

    /**
     * Destructured prop aliases from a `component Name({ a, b = default }: P)` signature: each local
     * binding name maps to the EXPRESSION a bare read of it lowers to - `props.a`, or `(props.a ?? default)`
     * for a defaulted binding, or `props.orig` for a rename `{ orig: a }`. So a destructured prop stays
     * reactive exactly as `props.a` would. Empty/absent for the plain `props: P` form.
     */
    propAliases?: ReadonlyMap<string, string>;

    /**
     * `form` declarations: form name -> its field-key set (the keys of the form's `initial` object). A
     * FIELD read `name.field` rewrites to `name.values().field` and a write `name.field = v` to
     * `name.setValue('field', v)` (so `bind:value={name.field}` works). The FormApi members
     * (`name.errors()`, `name.handleSubmit`, ...) are NOT fields, so they are left untouched.
     */
    forms?: ReadonlyMap<string, ReadonlySet<string>>;

    /**
     * Array-form ROW variables: the `<For>` row binding name -> its field-key set (the blank row's keys).
     * Bound when a For iterates an array-form (`<For each={items.rows()}>{(row) => ...}`). A FIELD read
     * `row.field` rewrites to `row.form.values().field` and a write `row.field = v` to
     * `row.form.setValue('field', v)` - the same as a `form` field, but through the row's `.form`. Kept
     * SEPARATE from `forms` so the row variable (a For arrow param) is not treated as a shadowing local by
     * the scope walker. `row.key` / `row.form` / FormApi access (`row.form.errors()`) are not fields and
     * stay untouched.
     */
    rowForms?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** One resolved reactive dependency. */
export type Dep =
    /** A read of a `state`/`derived` source. */
    | { kind: 'source'; name: string }
    /** A read of a props field (`props.name`), or the whole bag (`field: '*'`). */
    | { kind: 'prop'; field: string };
