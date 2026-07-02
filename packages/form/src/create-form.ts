/**
 * MODULE: form/create-form
 *
 * createForm gives reactive form state: per-field signals, sync validation, a submit lifecycle
 * (submitting + error), and DOM-friendly registration helpers for <input> elements - same authoring
 * style as createSignal/createResource, with no class hierarchy or schema layer.
 *
 * VALIDATION TIMING: sync validators (per-field `validate` + cross-field `validateForm`) run on every
 * value change and on submit; errors() is always live, so callers decide when to display (typical: show
 * after blur, plus all fields after a submit attempt). Async validators (`validateAsync`) run debounced
 * after the field's sync validator passes, with AbortSignal cancellation, and are awaited before submit;
 * validating() reports the in-flight fields.
 *
 * register() targets TEXT inputs: form.register('name') returns a prop bag for <input>/<textarea>.
 * Checkboxes, radios, selects, files, and dates need bespoke wiring - call form.setValue from a
 * custom onChange handler. The internal field-signal/validation machinery below carries its own comments.
 */

import type { Getter } from '@azerothjs/reactivity';
import {
    createSignal,
    createMemo,
    createEffect,
    untrack,
    onCleanup
} from '@azerothjs/reactivity';

/**
 * A sync field validator. Returns the error message for invalid input, or `null` when the value is
 * acceptable. A validator sees only its OWN field's value - it is a single-argument function, so it
 * stays trivial to write, wrap, and compose with {@link combine}. Anything that depends on SIBLING
 * fields (password confirm, `end >= start`, `requiredIf`) belongs in the form-level
 * {@link FormConfig.validateForm}, which receives the whole typed snapshot.
 *
 * @typeParam V - The field's value type
 */
export type FieldValidator<V> = (value: V) => string | null;

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

    /**
     * Per-field sync validators. Optional - fields without a validator are always considered valid. Run on
     * every value change and on submit. Each validator sees only its own field's value; for checks that
     * span fields use {@link validateForm}.
     */
    validate?: { [K in keyof T]?: FieldValidator<T[K]> };

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
    validateForm?: (values: T) => { [K in keyof T]?: string | null };

    /**
     * Per-field ASYNC validators, for checks that need a server round-trip. Each runs only after the field's
     * own sync validator passes and the field has changed from its initial value, debounced by
     * {@link asyncDebounceMs}, with an AbortSignal that cancels superseded runs. Results merge into the same
     * `errors` map; {@link FormApi.validating} reports which fields have a check in flight. On submit, every
     * configured async validator is awaited before `onSubmit` runs.
     */
    validateAsync?: { [K in keyof T]?: AsyncFieldValidator<T[K]> };

    /**
     * Debounce, in milliseconds, before an async validator fires after the value settles. Default `300`.
     * Ignored when no {@link validateAsync} is configured.
     */
    asyncDebounceMs?: number;

    /**
     * Called when the form passes validation on submit. May return a Promise -
     * `submitting()` will be true for its duration, and any rejection populates
     * `submitError()`.
     */
    onSubmit?: (values: T) => void | Promise<void>;
}

/**
 * The prop bag returned by `register(name)`, ready to spread onto
 * an `<input>` or `<textarea>` element.
 */
export interface RegisteredFieldProps
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
    register: <K extends keyof T>(name: K) => RegisteredFieldProps;

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
    setError: <K extends keyof T>(name: K, error: string | null) => void;
}

/**
 * createForm
 *
 * PURPOSE:
 * Builds a reactive form whose state - values, errors, touched, dirty, submitting, isValid - is
 * observable through standard signal getters, plus register()/handleSubmit()/reset()/setValue()/
 * setError() for wiring inputs and driving submission.
 *
 * WHY IT EXISTS:
 * Form state is a pile of moving parts (values, errors, touched, dirty, the submit lifecycle) and
 * wiring each input + re-validating by hand drifts out of sync fast. Without it you'd hand-roll a
 * signal per field, a separate errors signal, a validation effect, and the submit handler:
 *
 *     const [name, setName] = createSignal('');
 *     const [errors, setErrors] = createSignal({ name: null });
 *     createEffect(() => setErrors({ name: name().length < 2 ? 'Too short' : null }));
 *     h('input', { value: name, onInput: e => setName(e.target.value) });
 *     // touched/dirty/submitting and the submit handler are still on you
 *
 * createForm packages all of it: one config yields reactive state and a register()/handleSubmit() pair.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, form; built on createSignal/createMemo/createEffect/untrack. Composes with the rest of the
 * framework: errors propagate to <ErrorBoundary>, submitting() plugs into <Suspense>, and submitted
 * values flow into a store or a createResource invalidate.
 *
 * INPUT CONTRACT:
 * - config.initial: defines the form's shape (its keys ARE the field set) and starting values.
 * - config.validate?: per-field SYNC validators; a field without one is always valid.
 * - config.validateForm?: SYNC cross-field validation over the whole snapshot; returns a partial error map.
 * - config.validateAsync?: per-field ASYNC validators (debounced, AbortSignal-cancelled, awaited on submit).
 * - config.onSubmit?: called with the values snapshot when validation passes; may return a Promise.
 *
 * OUTPUT CONTRACT:
 * - A {@link FormApi}: reactive getters (values/errors/touched/dirty/submitting/submitError/isValid/
 *   validating/isValidating) plus imperative methods (register/handleSubmit/reset/setValue/setError).
 *
 * WHY THIS DESIGN:
 * One signal per field means setValue notifies exactly one downstream (the values memo), not every
 * reader. The validation effect MERGES rather than overwrites, so an error injected via setError()
 * survives the user editing a different field. handleSubmit re-validates against a fresh snapshot
 * (robust to out-of-order programmatic state changes) instead of trusting the live effect.
 *
 * WHEN TO USE:
 * Any form needing validation + a submit lifecycle, or several coordinated inputs.
 *
 * WHEN NOT TO USE:
 * A single trivial input (a plain createSignal is lighter). Streaming/long-lived async derivations beyond
 * one-shot field checks still belong in createResource; validateAsync covers the per-field server check.
 *
 * EDGE CASES:
 * - dirty uses reference comparison, so object/array fields read as "always dirty after first write".
 * - errors() is always live; gate display with touched() (and handleSubmit marks all fields touched).
 * - register() assumes a text input/textarea; other input types need a custom onChange + setValue.
 *
 * PERFORMANCE NOTES:
 * Per-field signals give targeted updates; values/dirty/isValid are memos, recomputed only on change.
 *
 * DEVELOPER WARNING:
 * register() is for TEXT inputs only. The per-field `validate` map is SYNC - returning a Promise from one
 * does not work; put server checks in `validateAsync`, which is the async-aware path.
 *
 * @typeParam T - The form's values shape, inferred from `initial`
 * @param config - The form configuration
 * @returns A {@link FormApi} for reading state and driving submission
 * @see {@link FormApi}
 * @see {@link RegisteredFieldProps}
 *
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
        const [getter, setter] = createSignal<T[keyof T]>(initial[name]);
        fields[name] = {
            value: getter as Getter<T[keyof T]>,
            setValue: setter as (next: T[keyof T]) => void
        };
    }

    // Errors / touched / submit signals.
    const initialErrors = makeRecord<keyof T, string | null>(fieldNames, null);
    const initialTouched = makeRecord<keyof T, boolean>(fieldNames, false);
    const [errors, setErrors] = createSignal(initialErrors);
    const [touched, setTouched] = createSignal(initialTouched);
    const [submitting, setSubmitting] = createSignal(false);
    const [submitError, setSubmitError] = createSignal<unknown>(null);

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
            out[name] = fields[name].value() as T[keyof T];
        }
        return out;
    });

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
    });

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
    });

    // Async-validation pending state: per-field "is a server check in flight".
    const [validating, setValidating] = createSignal(
        makeRecord<keyof T, boolean>(fieldNames, false)
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
    });

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

        const validate = config.validate;
        if (validate)
        {
            for (const name of fieldNames)
            {
                const validator = validate[name];
                if (validator)
                {
                    next[name] = validator(snapshot[name]);
                }
            }
        }

        const cross = config.validateForm ? config.validateForm(snapshot) : undefined;
        if (cross)
        {
            for (const name of fieldNames)
            {
                // Only fill a field the per-field pass left valid - format errors
                // take precedence over relationship errors on the same field.
                if (next[name] === null && name in cross)
                {
                    next[name] = cross[name] ?? null;
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
            const validate = config.validate;
            const cross = config.validateForm ? config.validateForm(snapshot) : undefined;

            // Nothing to recompute: leave the errors map alone, so an error
            // injected via setError() survives. (The initial map is all-null.)
            if (!validate && !cross)
            {
                return;
            }

            // Merge rather than overwrite. A field is recomputed only if it has a
            // per-field validator or appears in the cross-field result; any other
            // field keeps its current error, so a server error injected via
            // setError() (e.g. "username taken") is not wiped when the user edits
            // an unrelated field. Per-field errors win over cross-field ones.
            setErrors(prev =>
            {
                const next = { ...prev };
                for (const name of fieldNames)
                {
                    const validator = validate?.[name];
                    if (validator)
                    {
                        const fieldError = validator(snapshot[name]);
                        next[name] = fieldError;
                        if (fieldError !== null)
                        {
                            continue;
                        }
                    }
                    // Field is valid per-field (or unvalidated): let the
                    // cross-field result speak for it if it names this key.
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
                const value = fields[name].value() as T[keyof T];

                const syncValidator = config.validate?.[name];
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
        (fields[name].setValue as (next: T[K]) => void)(coerceFieldValue(name, value));
    }

    function setError<K extends keyof T>(name: K, error: string | null): void
    {
        setErrors(prev => ({ ...prev, [name]: error }));
    }

    function reset(): void
    {
        for (const name of fieldNames)
        {
            abortAsync(name);
            (fields[name].setValue as (next: T[keyof T]) => void)(
                initial[name] as T[keyof T]
            );
        }
        setErrors(makeRecord(fieldNames, null));
        setTouched(makeRecord(fieldNames, false));
        setValidating(makeRecord(fieldNames, false));
        setSubmitError(null);
    }

    function register<K extends keyof T>(name: K): RegisteredFieldProps
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
                setValue(name, target.value as unknown as T[K]);
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
            result = config.onSubmit(snapshot);
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
                (err) =>
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
            await config.onSubmit(snapshot);
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
        const asyncFields = config.validateAsync
            ? fieldNames.filter((name) => config.validateAsync![name])
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
