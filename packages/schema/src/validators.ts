/**
 * MODULE: schema/validators
 *
 * Built-in field validators - the framework's ONE set of rules, shared by the browser form
 * (createForm's `validate` option), this package's `refine`, and anywhere else a
 * `(value) => message | null` check fits. Each factory returns a FieldValidator<V>, optionally
 * chained with combine(). Every factory takes an optional `message` to override its default
 * text - the common i18n need without a message-bundle layer.
 *
 * SKIP-EMPTY CONVENTION: every validator EXCEPT required() silently passes on empty values ('', null,
 * undefined). This makes combine(required(), email()) produce the right errors in order - empty input
 * yields 'This field is required' (from required), 'bad-input' yields 'Invalid email address' (from
 * email). Without the skip, an empty input would show "Invalid email" before the user typed anything.
 * Matches Zod / Yup / react-hook-form, so it's already familiar.
 *
 * CONTRAVARIANCE: required() is typed FieldValidator<unknown>. TypeScript's parameter contravariance
 * makes that assignable to any narrower FieldValidator<V> slot, so combine(required(), email()) infers
 * V = string (what the email field expects) with no casts. combine() narrows to the strictest member.
 *
 * SCOPE: each validator here checks ONE field's value in isolation. Cross-field rules (password confirm,
 * date ranges) live in createForm's top-level `validateForm`, which sees the whole values snapshot - so
 * these stay single-argument and trivially composable. NOT IN V1: async validators (compose createResource
 * externally) and i18n message bundles (the per-call message override covers the common case). Each public
 * factory below carries its own concise JSDoc + example; isEmpty is @internal.
 */

import { EMAIL_PATTERN, type FieldValidator } from './schema.ts';

/**
 * Returns true for the values we treat as "no input": `null`, `undefined`, and
 * a string that is empty after trimming.
 *
 * Empty arrays are not handled here - `required()` checks for them separately
 * before delegating to `isEmpty`, since the empty-array case only applies to
 * that one validator.
 *
 * @example
 * ```ts
 * isEmpty('');       // true
 * isEmpty('   ');    // true (trimmed)
 * isEmpty(null);     // true
 * isEmpty('hi');     // false
 * ```
 *
 * @internal
 */
export function isEmpty(value: unknown): boolean
{
    if (value === null || value === undefined)
    {
        return true;
    }
    if (typeof value === 'string' && value.trim() === '')
    {
        return true;
    }
    return false;
}

/**
 * Validator: the field must have a value.
 *
 * Treats `''` (after trim), `null`, `undefined`, and empty arrays as missing.
 * Use this in front of more specific validators when a field is mandatory.
 *
 * @param message - Optional override for the default message.
 *                  Default: `'This field is required'`.
 *
 * @example
 * ```ts
 * validate: { email: required() }                     // default message
 * validate: { email: required('Email is required') }  // custom message
 * ```
 */
export function required(message?: string): FieldValidator
{
    return (value: unknown): string | null =>
    {
        if (Array.isArray(value) && value.length === 0)
        {
            return message ?? 'This field is required';
        }
        return isEmpty(value) ? (message ?? 'This field is required') : null;
    };
}

/**
 * Validator: string must be at least `n` characters long.
 *
 * Skips empty values - pair with `required()` to enforce both.
 *
 * @example
 * ```ts
 * validate: { name: combine(required(), minLength(2)) }
 * ```
 */
export function minLength(n: number, message?: string): FieldValidator<string>
{
    return (value: string): string | null =>
    {
        if (isEmpty(value))
        {
            return null;
        }
        return value.length < n
            ? (message ?? `Must be at least ${ n } character${ n === 1 ? '' : 's' }`)
            : null;
    };
}

/**
 * Validator: string must be at most `n` characters long.
 *
 * Skips empty values.
 *
 * @example
 * ```ts
 * validate: { username: combine(required(), maxLength(20)) }
 * ```
 */
export function maxLength(n: number, message?: string): FieldValidator<string>
{
    return (value: string): string | null =>
    {
        if (isEmpty(value))
        {
            return null;
        }
        return value.length > n
            ? (message ?? `Must be at most ${ n } character${ n === 1 ? '' : 's' }`)
            : null;
    };
}

/**
 * Validator: number must be at least `n`.
 *
 * Skips `null`/`undefined`. Note that `0` is not skipped - it's a valid numeric
 * value; to require a non-zero number, combine with `required()` (which treats
 * `0` as a valid value) and add an explicit check, or use `min(1)`.
 *
 * @example
 * ```ts
 * validate: { age: combine(required(), min(18)) }
 * ```
 */
export function min(n: number, message?: string): FieldValidator<number>
{
    return (value: number | null | undefined): string | null =>
    {
        if (value === null || value === undefined)
        {
            return null;
        }
        return value < n ? (message ?? `Must be at least ${ n }`) : null;
    };
}

/**
 * Validator: number must be at most `n`.
 *
 * Skips `null`/`undefined`.
 *
 * @example
 * ```ts
 * validate: { rating: combine(required(), min(1), max(5)) }
 * ```
 */
export function max(n: number, message?: string): FieldValidator<number>
{
    return (value: number | null | undefined): string | null =>
    {
        if (value === null || value === undefined)
        {
            return null;
        }
        return value > n ? (message ?? `Must be at most ${ n }`) : null;
    };
}

/**
 * Validator: string must match the supplied regular expression.
 *
 * Skips empty values. The regex is tested with `.test()` - set the `g` flag
 * carefully (it carries `lastIndex` between calls).
 *
 * @example
 * ```ts
 * const slug = pattern(/^[a-z0-9-]+$/, 'Lowercase letters, numbers, dashes only');
 * validate: { slug: combine(required(), slug) }
 * ```
 */
export function pattern(regex: RegExp, message?: string): FieldValidator<string>
{
    return (value: string): string | null =>
    {
        if (isEmpty(value))
        {
            return null;
        }
        return regex.test(value) ? null : (message ?? 'Invalid format');
    };
}

/**
 * Validator: string must look like an email address.
 *
 * Uses the framework's ONE email rule (EMAIL_PATTERN in schema.ts - the same check
 * `string({ format: 'email' })` runs). Pragmatic, not RFC 5322 exhaustive. Skips empty
 * values.
 *
 * @example
 * ```ts
 * validate: { email: combine(required(), email()) }
 * ```
 */
export function email(message?: string): FieldValidator<string>
{
    return (value: string): string | null =>
    {
        if (isEmpty(value))
        {
            return null;
        }
        return EMAIL_PATTERN.test(value) ? null : (message ?? 'Invalid email address');
    };
}

/**
 * Validator: string must parse as a URL via `new URL()`.
 *
 * Accepts any scheme that the browser parses, including `mailto:`,
 * `tel:`, `data:`, etc. For HTTP-only validation, follow with a
 * `pattern(/^https?:/)` check. Skips empty values.
 *
 * @example
 * ```ts
 * validate: { website: combine(required(), url()) }
 * ```
 */
export function url(message?: string): FieldValidator<string>
{
    return (value: string): string | null =>
    {
        if (isEmpty(value))
        {
            return null;
        }
        try
        {
            new URL(value);
            return null;
        }
        catch
        {
            return message ?? 'Invalid URL';
        }
    };
}

/**
 * Validator: value must strictly equal one of `values`.
 *
 * Uses `Object.is` for comparison (handles `NaN` correctly, which
 * `===` does not).
 *
 * @example
 * ```ts
 * validate: { role: oneOf(['admin', 'editor', 'viewer'] as const) }
 * ```
 */
export function oneOf<V>(values: readonly V[], message?: string): FieldValidator<V>
{
    return (value: V): string | null =>
    {
        for (const allowed of values)
        {
            if (Object.is(value, allowed))
            {
                return null;
            }
        }
        return message ?? `Must be one of: ${ values.join(', ') }`;
    };
}

/**
 * Combines several validators into one. Runs them in order,
 * returns the first error encountered, or `null` if every
 * validator passes.
 *
 * Validators may have varying value-type generics - TypeScript narrows the
 * combined type to the strictest one (or, if all are `unknown`, stays at
 * `unknown`). In practice this means `combine(required(), email())` correctly
 * types as `FieldValidator<string>` and slots into a string-typed field.
 *
 * @example
 * ```ts
 * validate: {
 *     password: combine(
 *         required(),
 *         minLength(8, '8+ characters'),
 *         pattern(/[A-Z]/, 'At least one uppercase letter'),
 *         pattern(/[0-9]/, 'At least one digit')
 *     )
 * }
 * ```
 */
export function combine<V>(...validators: FieldValidator<V>[]): FieldValidator<V>
{
    return (value: V): string | null =>
    {
        for (const validator of validators)
        {
            const error = validator(value);
            if (error !== null)
            {
                return error;
            }
        }
        return null;
    };
}
