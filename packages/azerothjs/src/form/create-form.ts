/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Reactive form state: per-field signals, sync validation, a submit lifecycle, and
 * registration helpers for inputs - the same authoring style as createSignal and
 * createResource, with no class hierarchy and no schema layer.
 *
 * Sync validators, per-field and cross-field alike, run on every value change and on submit,
 * and `errors()` is always live, so the caller decides when to display - typically after blur,
 * plus every field once a submit has been attempted. Async validators run debounced once the
 * field's sync validator passes, are cancelled through an AbortSignal, and are awaited before
 * submit; `validating()` reports which fields are in flight.
 *
 * register() targets TEXT inputs. Checkboxes, radios, selects, files and dates need bespoke
 * wiring: call setValue from your own onChange handler.
 */

import type { Getter } from '../reactivity/index.ts';
import type { Mutation } from '../reactivity/create-mutation.ts';
import {
    createSignal,
    createMemo,
    createEffect,
    untrack,
    onCleanup
} from '../reactivity/index.ts';
import { dtEnterPrimitive, dtExitPrimitive } from '../reactivity/devtools.ts';
import type { Schema, FieldValidator, StandardSchemaV1 } from '@azerothjs/schema';

/**
 * @internal Runs a FOREIGN Standard Schema validator synchronously: null on success,
 * its issues on failure. The form's validation pipeline is synchronous by design
 * (every keystroke revalidates), so an async-refining schema - `~standard.validate`
 * returning a Promise - is a configuration error surfaced loudly, not a silent skip:
 * async checks belong in validateAsync.
 */
function standardIssues<T>(
    schema: StandardSchemaV1<T>,
    value: unknown,
    site: string
): ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined }> | null
{
    const result = schema['~standard'].validate(value);
    if (result instanceof Promise)
    {
        throw new Error(
            `createForm ${ site }: this Standard Schema validator is ASYNCHRONOUS (its validate returned a Promise). ` +
            'The sync validation pipeline runs per keystroke; put async checks in validateAsync, or use a synchronous schema.'
        );
    }
    return result.issues === undefined ? null : result.issues;
}

/**
 * A synchronous field validator: returns the error message for invalid input, or `null` when
 * the value is acceptable. It sees only its OWN field's value (single-argument by design).
 * Anything spanning SIBLING fields (password confirm, `end >= start`) belongs in {@link
 * FormConfig.validateForm}; one schema over the whole object goes in {@link FormConfig.schema}.
 * The validator shape and built-in rules (required/email/minLength/...) are defined in
 * @azerothjs/schema.
 */
export type { FieldValidator } from '@azerothjs/schema';

/**
 * An async field validator, for checks that need a server round-trip (is this username taken? does this
 * coupon exist?). Returns a Promise of the error message, or `null` when the value is acceptable.
 *
 * It receives an {@link AbortSignal} that is aborted when a newer value supersedes this run (the user kept
 * typing) or the form unmounts - forward it to `fetch(url, { signal })` so the stale request is cancelled.
 * Async validators run only AFTER the field's sync validator passes and the field has changed, debounced so
 * they do not fire on every keystroke; while one is pending, {@link FormApi.validating} reports the field.
 *
 * @typeParam V - The field's value type
 *
 * @example
 * ```ts
 * validateAsync: {
 *     username: async (value, signal) =>
 *     {
 *         const res = await fetch(`/api/username-taken?u=${value}`, { signal });
 *         return (await res.json()).taken ? 'Username is taken' : null;
 *     }
 * }
 * ```
 */
export type AsyncFieldValidator<V> = (value: V, signal: AbortSignal) => Promise<string | null>;

/**
 * Options passed to `createForm()`.
 *
 * @typeParam T - The form's values shape; keys are field names,
 *                values are field types.
 */
export interface FormConfig<T extends object>
{
    /** Initial values for every field. The keys here define the form's shape. */
    initial: T;

    /** Debug name surfaced to devtools; groups the form's field/derived/submit nodes. Explicit undefined is equivalent to absent. */
    name?: string | undefined;

    /**
     * Per-field sync rules. Each entry is a FieldValidator, an @azerothjs/schema node, or
     * any SYNCHRONOUS Standard Schema validator (a Zod/Valibot field schema) - a schema
     * used per-field reports its first issue's message. Optional - fields without a
     * rule are always considered valid. Run on every value change and on submit. Each rule
     * sees only its own field's value; for checks that span fields use {@link validateForm};
     * for one schema over the whole values object use {@link schema}.
     */
    validate?: { [K in keyof T]?: FieldValidator<T[K]> | Schema<T[K]> | StandardSchemaV1<T[K]> } | undefined;

    /**
     * ONE schema for the whole values object - the same declaration the api client
     * pre-validates with and the server boundary enforces, so all three report identical
     * failures. Native `@azerothjs/schema` OR any SYNCHRONOUS Standard Schema validator
     * (Zod, Valibot, ArkType) - a team keeps its existing schemas; an async-refining
     * foreign schema belongs in {@link validateAsync}, and using one here throws a
     * descriptive error rather than silently skipping it. Issues land per-field (first
     * issue per field wins; a nested path lands on its top-level field). Runs after the
     * per-field rules and before {@link validateForm}; a per-field error wins over a
     * schema error for the same field. The schema only ever speaks for fields it has
     * reported on, so a server error injected via {@link FormApi.setError} on an
     * untouched field survives.
     */
    schema?: Schema<T> | StandardSchemaV1<T>;

    /**
     * Cross-field sync validation. Receives the full, typed values snapshot and returns a partial map of
     * field name to error message (or `null`). Runs after the per-field validators, on every change and on
     * submit. A per-field error always wins over a cross-field one for the same field, so a format error
     * ("Invalid email") shows before a relationship error ("Passwords must match").
     *
     * Return a field's key with `null` when its cross-field constraint passes, so a previously-set
     * cross-field error clears; omit a field entirely to leave it untouched (e.g. preserving a server error
     * set via {@link FormApi.setError}).
     *
     * @example
     * ```ts
     * validateForm: (v) => ({
     *     confirm: v.confirm !== v.password ? 'Passwords must match' : null,
     *     endDate: v.endDate < v.startDate ? 'End must be after start' : null
     * })
     * ```
     */
    validateForm?: ((values: T) => { [K in keyof T]?: string | null }) | undefined;

    /**
     * Per-field ASYNC validators, for checks that need a server round-trip. Each runs only after the field's
     * own sync validator passes and the field has changed from its initial value, debounced by
     * {@link asyncDebounceMs}, with an AbortSignal that cancels superseded runs. Results merge into the same
     * `errors` map; {@link FormApi.validating} reports which fields have a check in flight. On submit, every
     * configured async validator is awaited before `onSubmit` runs.
     */
    validateAsync?: { [K in keyof T]?: AsyncFieldValidator<T[K]> } | undefined;

    /**
     * Debounce, in milliseconds, before an async validator fires after the value settles. Default `300`.
     * Ignored when no {@link validateAsync} is configured.
     */
    asyncDebounceMs?: number | undefined;

    /**
     * What the form submits to: a function, or a {@link Mutation}.
     *
     * A FUNCTION is called with the values snapshot. It may return a Promise - `submitting()`
     * is true for its duration, and any rejection populates `submitError()`.
     *
     * A MUTATION is run with them, and the form reads its outcome: a refused write lands in
     * `submitError()`, and any field errors the refusal carries land on the fields themselves.
     * This is the one place the two meet - a mutation is what a form submits to, not a second
     * form system - and it exists because the obvious hand-wiring is silently wrong:
     * `onSubmit: (v) => m.run(v)` resolves even when the write was refused, because `run`
     * answers rather than rejecting, so the form reports a success the server never gave.
     */
    onSubmit?: ((values: T) => void | Promise<void>) | Mutation<T, unknown>;
}

/**
 * The prop bag returned by `register(name)`, ready to spread onto
 * an `<input>` or `<textarea>` element. A type alias (not an interface) on purpose: aliases
 * get an implicit index signature, so the bag is assignable to the renderer's `Props`
 * parameter and `h('input', form.register('name'))` type-checks as documented.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- the alias is load-bearing (see doc above)
export type RegisteredFieldProps =
{
    /** The field name (HTML form semantics + accessibility). */
    name: string;

    /** Reactive getter for the current value - h() wires it as the input's `value` property. */
    value: () => unknown;

    /** Updates the field signal from the input's current text. */
    onInput: (event: Event) => void;

    /** Marks the field as touched. */
    onBlur: () => void;
}

/**
 * The reactive form API returned by `createForm()`.
 *
 * @typeParam T - The form's values shape
 */
export interface FormApi<T extends object>
{
    /** Reactive snapshot of every field's current value. */
    values: Getter<T>;

    /** Reactive map of field name to validation error (or `null`). */
    errors: Getter<{ [K in keyof T]: string | null }>;

    /** Reactive map of field name to whether the user has blurred the field. */
    touched: Getter<{ [K in keyof T]: boolean }>;

    /** Reactive map of field name to whether its value differs from `initial`. */
    dirty: Getter<{ [K in keyof T]: boolean }>;

    /** True while `onSubmit`'s returned promise is pending. */
    submitting: Getter<boolean>;

    /** The most recent rejection from `onSubmit`, or `null`. */
    submitError: Getter<unknown>;

    /** True when no field has an error. Useful for disabling submit buttons. */
    isValid: Getter<boolean>;

    /** Reactive map of field name to whether an async validator is currently in flight for it. */
    validating: Getter<{ [K in keyof T]: boolean }>;

    /** True while any field has an async validator in flight. Useful for disabling submit buttons. */
    isValidating: Getter<boolean>;

    /** Returns props to spread onto an `<input>` for the named field. */
    register: (name: keyof T) => RegisteredFieldProps;

    /**
     * Form-element submit handler. Calls `event.preventDefault()`,
     * marks every field touched, runs validators, and (if all
     * pass) invokes `onSubmit`. Safe to assign directly to
     * `<form onSubmit={form.handleSubmit}>`.
     */
    handleSubmit: (event: Event) => void;

    /** Restores values, errors, touched, and submitError to their initial state. */
    reset: () => void;

    /** Programmatically set a field's value (e.g., from a custom widget). */
    setValue: <K extends keyof T>(name: K, value: T[K]) => void;

    /** Inject a server-side error into the form (e.g., "email taken"). */
    setError: (name: keyof T, error: string | null) => void;
}

/**
 * Builds a reactive form: values, errors, touched, dirty, submitting and isValid as signal
 * getters, plus register, handleSubmit, reset, setValue and setError for wiring inputs and
 * driving submission.
 *
 * `initial` defines the SHAPE - its keys are the field set - as well as the starting values.
 *
 * The per-field `validate` map is SYNC. Returning a promise from one does not work; per-field
 * server checks belong in `validateAsync`, which is debounced, cancelled through an
 * AbortSignal, and awaited before submit.
 *
 * `errors()` is always live, so gate display on `touched()`. handleSubmit marks every field
 * touched, which is what makes errors appear across the form on a failed submit attempt. It
 * also re-validates against a fresh snapshot rather than trusting the live effect, so an
 * out-of-order programmatic change cannot let an invalid form through.
 *
 * An error injected with setError survives the user editing a DIFFERENT field, because
 * validation merges rather than overwrites.
 *
 * `dirty` compares by reference, so an object or array field reads as dirty from its first
 * write onwards.
 *
 * register() targets TEXT inputs and textareas. Other input types need a custom onChange
 * calling setValue.
 *
 * @typeParam T - The values shape, inferred from `initial`.
 * @param config - Form configuration.
 * @param config.initial - Starting values, and the field set.
 * @param config.validate - Per-field sync validators. A field without one is always valid.
 * @param config.validateForm - Cross-field sync validation over the whole snapshot, returning
 *                              a partial error map.
 * @param config.validateAsync - Per-field async validators.
 * @param config.onSubmit - Receives the values snapshot once validation passes. May be async.
 * @returns The {@link FormApi}.
 * @example
 * ```ts
 * const form = createForm({
 *     initial: { name: '', email: '' },
 *     validate: {
 *         name: v => v.length < 2 ? 'Too short' : null,
 *         email: v => v.includes('@') ? null : 'Invalid email'
 *     },
 *     onSubmit: async (values) =>
 *     {
 *         await api.save(values);
 *     }
 * });
 *
 * h('form', { onSubmit: form.handleSubmit },
 *     h('input', form.register('name')),
 *     h('p', {}, () => form.touched().name ? form.errors().name : ''),
 *     h('input', form.register('email')),
 *     h('p', {}, () => form.touched().email ? form.errors().email : ''),
 *     h('button',
 *         { disabled: () => form.submitting() || !form.isValid() },
 *         () => form.submitting() ? 'Saving...' : 'Save'
 *     )
 * );
 * ```
 *
 * @example
 * ```ts
 * // Server-side error injection - call setError in onSubmit's
 * // catch path to surface an error on a specific field.
 * const form = createForm({
 *     initial: { username: '' },
 *     onSubmit: async (values) =>
 *     {
 *         try { await register(values); }
 *         catch (err)
 *         {
 *             form.setError('username', String(err));
 *             throw err;
 *         }
 *     }
 * });
 * ```
 */
export function createForm<T extends object>(
    config: FormConfig<T>
): FormApi<T>
{
    const initial = config.initial;
    const fieldNames = Object.keys(initial) as (keyof T)[];
    const frame = dtEnterPrimitive('form', config.name);

    // Per-field signals: one signal per field, kept in a map so register(name)
    // and setValue(name, value) can look up the right setter generically. The
    // values getter recomputes its snapshot object from these signals, so each
    // individual setValue notifies exactly one downstream effect (the values
    // memo), not all field readers.
    interface FieldHandle<V>
    {
        value: Getter<V>;
        setValue: (next: V) => void;
    }
    const fields = {} as { [K in keyof T]: FieldHandle<T[K]> };
    for (const name of fieldNames)
    {
        const [getter, setter] = createSignal<T[keyof T]>(initial[name], { name: String(name) });
        fields[name] = {
            value: getter,
            setValue: setter
        };
    }

    // Per-field rules normalize ONCE: a schema node (anything with safeParse) wraps into the
    // FieldValidator shape the rest of the machinery speaks - its first issue is the message.
    const fieldRules = {} as { [K in keyof T]?: FieldValidator<T[K]> };
    if (config.validate)
    {
        for (const name of Object.keys(config.validate) as (keyof T)[])
        {
            // The explicit annotation flattens the mapped-indexed type into a plain
            // union, which is what lets `typeof` narrow it (function -> FieldValidator,
            // object -> schema) without casts. A native schema keeps its one-pass
            // first-issue safeParse; a foreign Standard Schema runs `~standard.validate`
            // (synchronously - see standardIssues).
            const rule: FieldValidator<T[keyof T]> | Schema<T[keyof T]> | StandardSchemaV1<T[keyof T]> | undefined = config.validate[name];
            if (rule === undefined)
            {
                continue;
            }
            if (typeof rule === 'function')
            {
                fieldRules[name] = rule;
            }
            else if ('safeParse' in rule)
            {
                const schema = rule;
                fieldRules[name] = (value: T[keyof T]): string | null =>
                {
                    const parsed = schema.safeParse(value, { mode: 'first' });
                    return parsed.ok ? null : (parsed.issues[0]?.message ?? 'Invalid value');
                };
            }
            else
            {
                const schema = rule;
                fieldRules[name] = (value: T[keyof T]): string | null =>
                {
                    const issues = standardIssues(schema, value, String(name));
                    return issues === null ? null : (issues[0]?.message ?? 'Invalid value');
                };
            }
        }
    }

    // Cross-field validateForm: the accumulating set records which fields it has EVER flagged, so
    // a now-passing field is explicitly cleared even when the natural "partial error map" style
    // returns `{}` (or omits the field). Without this, a fixed password-confirm stays invalid.
    const crossSpoke = new Set<keyof T>();
    function runCross(snapshot: T): { [K in keyof T]?: string | null } | undefined
    {
        if (!config.validateForm)
        {
            return undefined;
        }
        const overlay: { [K in keyof T]?: string | null } = { ...config.validateForm(snapshot) };
        for (const name of fieldNames)
        {
            const err: string | null | undefined = overlay[name];
            if (err !== undefined && err !== null)
            {
                crossSpoke.add(name);
            }
        }
        for (const field of crossSpoke)
        {
            if (!(field in overlay) || overlay[field] === undefined)
            {
                overlay[field] = null; // previously flagged, now passing (or omitted): clear
            }
        }
        return overlay;
    }

    // Whole-form schema: issues map onto their top-level field. The accumulating set records
    // which fields the schema has EVER spoken for, so a fixed field is explicitly cleared
    // (null) while a field the schema never flagged keeps errors injected via setError().
    const schemaSpoke = new Set<keyof T>();
    function runSchema(snapshot: T): { [K in keyof T]?: string | null } | undefined
    {
        if (!config.schema)
        {
            return undefined;
        }
        const overlay = {} as { [K in keyof T]?: string | null };

        // Native fast path keeps the one-pass safeParse (dotted string paths); a foreign
        // Standard Schema validator maps its segment-array paths to the same shape.
        let failures: ReadonlyArray<{ field: string; message: string }>;
        if ('safeParse' in config.schema)
        {
            const parsed = config.schema.safeParse(snapshot);
            failures = parsed.ok ? [] : parsed.issues
                .filter((issue) => issue.path !== '') // a root-level issue has no field to land on
                .map((issue) => ({ field: issue.path.split('.')[0] ?? '', message: issue.message }));
        }
        else
        {
            const issues = standardIssues(config.schema, snapshot, 'schema');
            failures = issues === null ? [] : issues.flatMap((issue) =>
            {
                const seg = issue.path?.[0];
                if (seg === undefined)
                {
                    return []; // a root-level issue has no field to land on
                }
                return [{ field: String(typeof seg === 'object' ? seg.key : seg), message: issue.message }];
            });
        }

        for (const { field, message } of failures)
        {
            const key = field as keyof T;
            schemaSpoke.add(key);
            if (overlay[key] === undefined)
            {
                overlay[key] = message; // first issue per field wins
            }
        }
        for (const field of schemaSpoke)
        {
            if (!(field in overlay))
            {
                overlay[field] = null; // previously flagged, now passing: clear
            }
        }
        return overlay;
    }

    // Errors / touched / submit signals.
    const initialErrors = makeRecord<keyof T, string | null>(fieldNames, null);
    const initialTouched = makeRecord<keyof T, boolean>(fieldNames, false);
    const [errors, setErrors] = createSignal(initialErrors, { name: 'errors' });
    const [touched, setTouched] = createSignal(initialTouched, { name: 'touched' });
    const [submitting, setSubmitting] = createSignal(false, { name: 'submitting' });
    const [submitError, setSubmitError] = createSignal<unknown>(null, { name: 'submitError' });

    // Derived: values, dirty, isValid.
    //
    // `values` is a memo over every field signal - reading it subscribes to all
    // fields collectively, which matches the expectation of "the form's values"
    // as a single observable shape.
    const values = createMemo<T>(() =>
    {
        const out = {} as T;
        for (const name of fieldNames)
        {
            out[name] = fields[name].value();
        }
        return out;
    }, { name: 'values' });

    const dirty = createMemo<{ [K in keyof T]: boolean }>(() =>
    {
        const v = values();
        const out = {} as { [K in keyof T]: boolean };
        for (const name of fieldNames)
        {
            // Reference comparison - for object/array fields this means
            // "always dirty after first write" (the caller produced a new
            // reference). Acceptable v1 contract; apps using object fields can
            // override via setValue semantics.
            out[name] = v[name] !== initial[name];
        }
        return out;
    }, { name: 'dirty' });

    const isValid = createMemo<boolean>(() =>
    {
        const e = errors();
        for (const name of fieldNames)
        {
            if (e[name] !== null)
            {
                return false;
            }
        }
        return true;
    }, { name: 'isValid' });

    // Async-validation pending state: per-field "is a server check in flight".
    const [validating, setValidating] = createSignal(
        makeRecord<keyof T, boolean>(fieldNames, false),
        { name: 'validating' }
    );

    const isValidating = createMemo<boolean>(() =>
    {
        const v = validating();
        for (const name of fieldNames)
        {
            if (v[name])
            {
                return true;
            }
        }
        return false;
    }, { name: 'isValidating' });

    function setValidatingField(name: keyof T, pending: boolean): void
    {
        // Skip the write (and its notification) when the flag is unchanged.
        setValidating(prev => prev[name] === pending ? prev : { ...prev, [name]: pending });
    }

    // Computes the FULL fresh errors map for a snapshot: every per-field
    // validator, then the cross-field validateForm overlaid onto any field its
    // own validator left valid (per-field errors win). Used by handleSubmit,
    // which re-validates from scratch.
    function runValidators(snapshot: T): { [K in keyof T]: string | null }
    {
        const next = makeRecord<keyof T, string | null>(fieldNames, null);

        for (const name of fieldNames)
        {
            const validator = fieldRules[name];
            if (validator)
            {
                next[name] = validator(snapshot[name]);
            }
        }

        // Overlay order: whole-form schema first, then cross-field - structure/format errors
        // read before relationship errors, and a per-field error wins for its field either way.
        const overlays = [runSchema(snapshot), runCross(snapshot)];
        for (const overlay of overlays)
        {
            if (overlay)
            {
                for (const name of fieldNames)
                {
                    // Only fill a field the earlier passes left valid.
                    if (next[name] === null && name in overlay)
                    {
                        next[name] = overlay[name] ?? null;
                    }
                }
            }
        }

        return next;
    }

    // Validation effect: re-runs every time any field changes. Reads each field
    // via the values memo (already a dependency), then writes the new errors map
    // inside untrack so the effect doesn't subscribe to itself.
    createEffect(() =>
    {
        const snapshot = values();
        untrack(() =>
        {
            const schemaOverlay = runSchema(snapshot);
            const cross = runCross(snapshot);

            // Nothing to recompute: leave the errors map alone, so an error
            // injected via setError() survives. (The initial map is all-null.)
            if (!config.validate && !schemaOverlay && !cross)
            {
                return;
            }

            // Merge rather than overwrite. A field is recomputed only if it has a
            // per-field rule or appears in the schema/cross-field results; any other
            // field keeps its current error, so a server error injected via
            // setError() (e.g. "username taken") is not wiped when the user edits
            // an unrelated field. Per-field errors win, then schema, then cross-field.
            setErrors(prev =>
            {
                const next = { ...prev };
                for (const name of fieldNames)
                {
                    const validator = fieldRules[name];
                    if (validator)
                    {
                        const fieldError = validator(snapshot[name]);
                        next[name] = fieldError;
                        if (fieldError !== null)
                        {
                            continue;
                        }
                    }
                    // Field is valid per-field (or unvalidated): the whole-form schema
                    // speaks first, then the cross-field result, for fields they name.
                    if (schemaOverlay && name in schemaOverlay)
                    {
                        next[name] = schemaOverlay[name] ?? null;
                        if (next[name] !== null)
                        {
                            continue;
                        }
                    }
                    if (cross && name in cross)
                    {
                        next[name] = cross[name] ?? null;
                    }
                }
                return next;
            });
        });
    });

    // --- Async validation (optional) ---
    //
    // A field's async validator runs only after its sync validator passes (no
    // point asking the server about malformed input) and the field has changed,
    // debounced so it does not fire on every keystroke, and with an AbortSignal so
    // a newer keystroke supersedes an in-flight request. Results merge into the
    // same errors map; validating() reports which fields have a check pending.

    // Per-field in-flight controllers, so a fresh run (or reset / unmount) aborts
    // the previous request for that field.
    const asyncControllers = {} as { [K in keyof T]?: AbortController };

    function abortAsync(name: keyof T): void
    {
        const controller = asyncControllers[name];
        if (controller)
        {
            asyncControllers[name] = undefined;
            controller.abort();
        }
    }

    // Runs one field's async validator: aborts any in-flight run for the field,
    // marks it validating, and on completion merges the verdict into errors unless
    // a newer run has superseded it. Resolves to the verdict (null = valid), or
    // null when superseded. Rejections propagate to the caller (the submit path
    // surfaces them; background runs swallow them).
    function runFieldAsync<K extends keyof T>(name: K, value: T[K]): Promise<string | null>
    {
        const asyncValidator = config.validateAsync?.[name];
        if (!asyncValidator)
        {
            return Promise.resolve(null);
        }

        abortAsync(name);
        const controller = new AbortController();
        asyncControllers[name] = controller;
        setValidatingField(name, true);

        return Promise.resolve(asyncValidator(value, controller.signal)).then(
            (result) =>
            {
                if (controller.signal.aborted)
                {
                    return null;
                }
                asyncControllers[name] = undefined;
                setErrors(prev => ({ ...prev, [name]: result }));
                setValidatingField(name, false);
                return result;
            },
            (error: unknown) =>
            {
                if (controller.signal.aborted)
                {
                    return null;
                }
                asyncControllers[name] = undefined;
                setValidatingField(name, false);
                throw error;
            }
        );
    }

    if (config.validateAsync)
    {
        const debounceMs = config.asyncDebounceMs ?? 300;

        for (const name of fieldNames)
        {
            if (!config.validateAsync[name])
            {
                continue;
            }

            // One effect per async field. It subscribes to that field's value,
            // gates on "changed and sync-valid", then schedules the debounced run.
            // onCleanup fires before the next run AND on owner dispose, so it both
            // cancels a pending debounce and aborts an in-flight request when the
            // value changes again or the form unmounts.
            createEffect(() =>
            {
                const value = fields[name].value();

                const syncValidator = fieldRules[name];
                const changed = value !== initial[name];
                if (!changed || (syncValidator && syncValidator(value) !== null))
                {
                    // Nothing to check (unchanged, or sync already failed): clear the
                    // pending flag. The previous run's onCleanup already aborted any
                    // in-flight request and cancelled any pending debounce.
                    setValidatingField(name, false);
                    return;
                }

                const timer = setTimeout(() =>
                {
                    // Background run: a rejection (e.g. network error) is non-fatal -
                    // the field simply shows no async error and the user can retry.
                    void runFieldAsync(name, value).catch(() =>
                    { /* non-fatal */ });
                }, debounceMs);

                onCleanup(() =>
                {
                    clearTimeout(timer);
                    abortAsync(name);
                });
            });
        }
    }

    // Imperative API.

    // An <input> always yields a string, but a field may be typed `number`. When a string lands in a field
    // whose initial value is a number, coerce it so values()/onSubmit (and numeric validators like min/max)
    // see the typed value rather than a stringified one. This is what makes `bind:value={f.age}` work for a
    // numeric field with no per-field configuration; `Number('')` is `0`, the natural empty default. A value
    // already of the right type (a programmatic `setValue('age', 25)`) passes through untouched.
    function coerceFieldValue<K extends keyof T>(name: K, value: T[K]): T[K]
    {
        if (typeof value === 'string' && typeof initial[name] === 'number')
        {
            return Number(value) as unknown as T[K];
        }
        return value;
    }

    function setValue<K extends keyof T>(name: K, value: T[K]): void
    {
        (fields[name].setValue)(coerceFieldValue(name, value));
    }

    function setError(name: keyof T, error: string | null): void
    {
        setErrors(prev => ({ ...prev, [name]: error }));
    }

    function reset(): void
    {
        for (const name of fieldNames)
        {
            abortAsync(name);
            (fields[name].setValue)(
                initial[name]
            );
        }
        schemaSpoke.clear();
        setErrors(makeRecord(fieldNames, null));
        setTouched(makeRecord(fieldNames, false));
        setValidating(makeRecord(fieldNames, false));
        setSubmitError(null);
    }

    function register(name: keyof T): RegisteredFieldProps
    {
        return {
            name: String(name),
            value: () => fields[name].value(),
            onInput: (event: Event): void =>
            {
                // h() doesn't restrict input types; if register is wired onto a
                // non-text element this cast would be wrong. register is
                // documented as text-only. Route through setValue so a numeric
                // field is coerced from the input's string like bind:value is.
                const target = event.target as HTMLInputElement;
                setValue(name, target.value as unknown as T[keyof T]);
            },
            onBlur: (): void =>
            {
                setTouched(prev => ({ ...prev, [name]: true }));
            }
        };
    }

    // Invokes onSubmit synchronously with the submitting lifecycle. Used when no
    // async validation is configured, so a valid submit calls onSubmit in the same
    // tick (the synchronous-submit contract).
    function invokeSubmit(snapshot: T): void
    {
        if (!config.onSubmit)
        {
            return;
        }

        setSubmitError(null);
        setSubmitting(true);

        let result: void | Promise<void>;
        try
        {
            result = runSubmit(config.onSubmit, snapshot);
        }
        catch (err)
        {
            // Synchronous throw inside onSubmit.
            setSubmitError(() => err);
            setSubmitting(false);
            return;
        }

        if (result instanceof Promise)
        {
            result.then(
                () => setSubmitting(false),
                (err: unknown) =>
                {
                    setSubmitError(() => err);
                    setSubmitting(false);
                }
            );
        }
        else
        {
            setSubmitting(false);
        }
    }

    /**
     * Lands a refusal's field map on the fields it names.
     *
     * Read STRUCTURALLY rather than through `@azerothjs/http`'s `applyFieldErrors`: the
     * framework does not depend on the server package, and a form is handed refusals by
     * whatever transport an application chose. The first path segment is the field, which is
     * the same rule `applyFieldErrors` applies - duplicated across the package boundary by
     * house precedent, as `RoutePathParams` duplicates the HTTP router's params typing.
     */
    function applyRefusedFields(error: unknown): void
    {
        const fields = (error as { fields?: unknown } | null)?.fields;
        if (typeof fields !== 'object' || fields === null)
        {
            return;
        }
        const seen = new Set<string>();
        for (const [path, message] of Object.entries(fields as Record<string, unknown>))
        {
            const field = path.split('.', 1)[0] ?? path;
            if (field === '' || seen.has(field) || typeof message !== 'string')
            {
                continue;
            }
            seen.add(field);
            setError(field as keyof T, message);
        }
    }

    /**
     * Runs whatever the form submits to. A mutation ANSWERS a refusal instead of rejecting, so
     * its outcome has to be read; a function keeps its existing contract exactly.
     */
    function runSubmit(target: NonNullable<FormConfig<T>['onSubmit']>, snapshot: T): void | Promise<void>
    {
        if (typeof target === 'function')
        {
            return target(snapshot);
        }
        return target.run(snapshot).then((outcome) =>
        {
            if (!outcome.ok)
            {
                setSubmitError(() => outcome.error);
                applyRefusedFields(outcome.error);
            }
        });
    }

    // Tail of the async submit path: submitting() is already true and submitError
    // already cleared. Awaits onSubmit (sync or async) and clears submitting.
    async function finishSubmitAsync(snapshot: T): Promise<void>
    {
        if (!config.onSubmit)
        {
            setSubmitting(false);
            return;
        }
        try
        {
            await runSubmit(config.onSubmit, snapshot);
        }
        catch (err)
        {
            setSubmitError(() => err);
        }
        finally
        {
            setSubmitting(false);
        }
    }

    function handleSubmit(event: Event): void
    {
        event.preventDefault();

        // On submit, mark every field touched so previously-hidden
        // errors become visible to the user.
        setTouched(makeRecord(fieldNames, true));

        // Re-run sync validators against the current snapshot. The value-watching
        // effect already keeps errors in sync, but re-running here is robust against
        // out-of-order programmatic state changes.
        const snapshot = values();
        const fresh = runValidators(snapshot);
        setErrors(fresh);

        // Bail if anything is invalid. Compute validity from the freshly-computed
        // errors directly rather than reading isValid() - this avoids reactive
        // timing edge cases between the effect run and the isValid memo recompute.
        for (const name of fieldNames)
        {
            if (fresh[name] !== null)
            {
                return;
            }
        }

        // Fields with an async validator (sync has already passed for every field).
        const asyncRules = config.validateAsync;
        const asyncFields = asyncRules
            ? fieldNames.filter((name) => asyncRules[name])
            : [];

        // No async validation: invoke onSubmit synchronously (unchanged behavior).
        if (asyncFields.length === 0)
        {
            invokeSubmit(snapshot);
            return;
        }

        // Async validation phase: await every async validator, then submit if all
        // pass. submitting() stays true across both the checks and onSubmit.
        setSubmitError(null);
        setSubmitting(true);
        Promise.all(asyncFields.map((name) => runFieldAsync(name, snapshot[name]))).then(
            (results) =>
            {
                if (results.some((result) => result !== null))
                {
                    // An async check failed; its error is now in errors().
                    setSubmitting(false);
                    return;
                }
                void finishSubmitAsync(snapshot);
            },
            (err: unknown) =>
            {
                // An async validator threw (e.g. a network failure): validity cannot
                // be confirmed, so do not submit; surface it as a submit error.
                setSubmitError(() => err);
                setSubmitting(false);
            }
        );
    }

    dtExitPrimitive(frame);
    return {
        values,
        errors,
        touched,
        dirty,
        submitting,
        submitError,
        isValid,
        validating,
        isValidating,
        register,
        handleSubmit,
        reset,
        setValue,
        setError
    };
}

/**
 * Builds a `Record<K, V>` with every key initialised to the same value. Used
 * for the initial errors / touched maps, where "every field starts at null /
 * false" is the right default.
 *
 * @example
 * ```ts
 * makeRecord(['name', 'email'], null);   // { name: null, email: null }
 * makeRecord(['name', 'email'], false);  // { name: false, email: false }
 * ```
 *
 * @internal
 */
function makeRecord<K extends string | number | symbol, V>(
    keys: readonly K[],
    fill: V
): Record<K, V>
{
    const out = {} as Record<K, V>;
    for (const k of keys)
    {
        out[k] = fill;
    }
    return out;
}
