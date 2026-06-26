/**
 * MODULE: form/create-form
 *
 * createForm gives reactive form state: per-field signals, sync validation, a submit lifecycle
 * (submitting + error), and DOM-friendly registration helpers for <input> elements - same authoring
 * style as createSignal/createResource, with no class hierarchy or schema layer.
 *
 * VALIDATION TIMING: validators run on every value change and on submit; errors() is always live, so
 * callers decide when to display (typical: show after blur, plus all fields after a submit attempt).
 * Async validators are not in v1 - compose them externally with createResource (a validateAsync
 * option can be added later without breaking the API).
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
    untrack
} from '@azerothjs/reactivity';

/**
 * A sync field validator. Returns the error message for invalid input, or
 * `null` when the value is acceptable.
 *
 * @typeParam V - The field's value type
 */
export type FieldValidator<V> = (value: V) => string | null;

/**
 * Options passed to `createForm()`.
 *
 * @typeParam T - The form's values shape; keys are field names,
 *                values are field types.
 */
export interface FormConfig<T extends Record<string, unknown>>
{
    /** Initial values for every field. The keys here define the form's shape. */
    initial: T;

    /**
     * Per-field sync validators. Optional - fields without a validator are
     * always considered valid. Run on every value change and on submit.
     */
    validate?: { [K in keyof T]?: FieldValidator<T[K]> };

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
export interface FormApi<T extends Record<string, unknown>>
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
 * - config.onSubmit?: called with the values snapshot when validation passes; may return a Promise.
 *
 * OUTPUT CONTRACT:
 * - A {@link FormApi}: reactive getters (values/errors/touched/dirty/submitting/submitError/isValid)
 *   plus imperative methods (register/handleSubmit/reset/setValue/setError).
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
 * A single trivial input (a plain createSignal is lighter); async/cross-field validation (compose
 * createResource externally - v1 validators are sync only).
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
 * register() is for TEXT inputs only. Validators are SYNC in v1 - returning a Promise from one does
 * not work; compose async validation via createResource.
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
export function createForm<T extends Record<string, unknown>>(
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

    // Validation effect: re-runs every time any field changes. Reads each field
    // via the values memo (already a dependency), then writes the new errors map
    // inside untrack so the effect doesn't subscribe to itself.
    function runValidators(snapshot: T): { [K in keyof T]: string | null }
    {
        if (!config.validate)
        {
            return makeRecord(fieldNames, null);
        }

        const next = {} as { [K in keyof T]: string | null };
        for (const name of fieldNames)
        {
            const validator = config.validate[name];
            next[name] = validator ? validator(snapshot[name]) : null;
        }
        return next;
    }

    createEffect(() =>
    {
        const snapshot = values();
        untrack(() =>
        {
            const validate = config.validate;
            // No validators configured: leave the errors map alone, so an
            // error injected via setError() survives. (The initial map is
            // already all-null.)
            if (!validate)
            {
                return;
            }

            // Merge rather than overwrite: only fields that have a validator are
            // recomputed here. Fields without one keep their current error
            // untouched, so a server error injected via setError() (e.g.
            // "username taken") is not wiped when the user edits some other
            // field. Validated fields still re-validate live on every change.
            setErrors(prev =>
            {
                const next = { ...prev };
                for (const name of fieldNames)
                {
                    const validator = validate[name];
                    if (validator)
                    {
                        next[name] = validator(snapshot[name]);
                    }
                }
                return next;
            });
        });
    });

    // Imperative API.

    function setValue<K extends keyof T>(name: K, value: T[K]): void
    {
        (fields[name].setValue as (next: T[K]) => void)(value);
    }

    function setError<K extends keyof T>(name: K, error: string | null): void
    {
        setErrors(prev => ({ ...prev, [name]: error }));
    }

    function reset(): void
    {
        for (const name of fieldNames)
        {
            (fields[name].setValue as (next: T[keyof T]) => void)(
                initial[name] as T[keyof T]
            );
        }
        setErrors(makeRecord(fieldNames, null));
        setTouched(makeRecord(fieldNames, false));
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
                // documented as text-only.
                const target = event.target as HTMLInputElement;
                (fields[name].setValue as (next: T[K]) => void)(
                    target.value as unknown as T[K]
                );
            },
            onBlur: (): void =>
            {
                setTouched(prev => ({ ...prev, [name]: true }));
            }
        };
    }

    function handleSubmit(event: Event): void
    {
        event.preventDefault();

        // On submit, mark every field touched so previously-hidden
        // errors become visible to the user.
        setTouched(makeRecord(fieldNames, true));

        // Re-run validators against the current snapshot. The
        // value-watching effect above already keeps errors in
        // sync, but re-running here is robust against any
        // out-of-order programmatic state changes.
        const snapshot = values();
        const fresh = runValidators(snapshot);
        setErrors(fresh);

        // Bail if anything is invalid. Compute validity from the
        // freshly-computed errors directly rather than reading isValid() - this
        // avoids reactive timing edge cases between the effect run and the
        // isValid memo recompute.
        for (const name of fieldNames)
        {
            if (fresh[name] !== null)
            {
                return;
            }
        }

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

    return {
        values,
        errors,
        touched,
        dirty,
        submitting,
        submitError,
        isValid,
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
