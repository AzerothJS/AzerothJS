// ============================================================================
// AZEROTHJS — phone() Validator
// ============================================================================
//
// Validates phone numbers in E.164 international format. Pragmatic
// scope: starts with `+`, total digit count between 8 and 15, and
// (optionally) the calling-code prefix matches one of a supplied
// country list.
//
// WHAT THIS DOES:
//
//   - Strips human-friendly punctuation: spaces, hyphens, dots,
//     parentheses. So `+1 (415) 555-1234` and `+14155551234` are
//     treated identically.
//   - Requires the leading `+` (strict E.164 format).
//   - Requires 8 to 15 total digits (E.164 max is 15; 7 + at least
//     one country-code digit is the realistic minimum).
//   - With `countries: [...]`, checks that the digits start with
//     one of those countries' calling codes.
//
// WHAT THIS DOES NOT DO:
//
//   - Per-country length validation (US numbers are exactly 10
//     digits after +1; we accept 7–14 digits after +1).
//   - Mobile vs landline vs special-service distinction.
//   - Carrier code validation.
//   - Disambiguation between countries sharing a calling code
//     (e.g., +1 for US/Canada/NANP territories — we accept any
//     number starting with `1`, not just genuine US numbers).
//
//   For all of the above, use libphonenumber-js as a
//   `FieldValidator<string>` and chain it via `combine()`. We
//   deliberately don't compete with its 70 KB metadata.
//
// SKIP-EMPTY:
//
//   Like every other validator, `phone()` passes silently on
//   empty/null/undefined input. Pair with `required()` when the
//   field is mandatory.
//
// ============================================================================

import type { FieldValidator } from './create-form.ts';
import { getCountry } from './countries.ts';

/**
 * Options for the `phone()` validator.
 */
export interface PhoneOptions
{
    /**
     * Restrict accepted numbers to those starting with one of
     * these countries' calling codes. ISO 3166-1 alpha-2 codes
     * (e.g., `'US'`, `'GB'`, `'IR'`).
     *
     * If the array is empty or `undefined`, any valid E.164
     * number passes. Unknown ISO codes are silently ignored
     * — they won't accept anything (or reject anything specific).
     */
    countries?: string[];

    /**
     * Override the default error message. The same message is
     * used for every kind of failure (missing `+`, wrong digit
     * count, country mismatch); for granular messages, build
     * your own validator with the country dataset directly.
     */
    message?: string;
}

/**
 * Returns true for the values we treat as "no input": empty
 * string after trim, null, undefined.
 *
 * @internal
 */
function isEmpty(value: unknown): boolean
{
    if (value === null || value === undefined) return true;
    return typeof value === 'string' && value.trim() === '';
}

/**
 * Validator: phone number must be a valid E.164 international
 * number, optionally restricted to a list of countries.
 *
 * Skips empty values — pair with `required()` to enforce both:
 *
 * ```ts
 * validate: { phone: combine(required(), phone({ countries: ['US', 'GB'] })) }
 * ```
 *
 * @param options - Optional `{ countries, message }` configuration
 *
 * @returns A `FieldValidator<string>` ready to slot into a form's
 *          `validate` map
 *
 * @example
 * ```ts
 * // Any country
 * createForm({
 *     initial: { phone: '' },
 *     validate: { phone: phone() }
 * });
 *
 * // Restrict to a specific list
 * createForm({
 *     initial: { phone: '' },
 *     validate: {
 *         phone: phone({ countries: ['US', 'CA', 'GB', 'IR'] })
 *     }
 * });
 *
 * // Inputs all parse the same way after stripping punctuation:
 * //   '+1 (415) 555-1234'  ✓
 * //   '+14155551234'       ✓
 * //   '+1.415.555.1234'    ✓
 * //   '4155551234'         ✗  (no leading +)
 * //   '+98 21 1234567'     ✓ if 'IR' is in countries
 * ```
 *
 * @example
 * ```ts
 * // For exact per-country length / mobile-vs-landline rules,
 * // chain libphonenumber-js as a custom validator:
 * import { isValidPhoneNumber } from 'libphonenumber-js';
 *
 * validate: {
 *     phone: combine(
 *         required(),
 *         phone({ countries: ['US'] }),
 *         (value) => isValidPhoneNumber(value, 'US') ? null : 'Not a real US number'
 *     )
 * }
 * ```
 */
export function phone(options?: PhoneOptions): FieldValidator<string>
{
    const message = options?.message;
    const countryFilter = options?.countries;

    // Pre-compute the allowed calling codes once at validator
    // construction time — looked up via the country dataset and
    // de-duplicated, since multiple ISO codes share one calling code
    // (US and CA both map to '1'). Order is irrelevant: the check
    // below is a boolean "does the number start with ANY of these
    // codes", not a longest-prefix disambiguation.
    const allowedCallingCodes: string[] | null = countryFilter
        ? Array.from(new Set(
            countryFilter
                .map(code => getCountry(code)?.callingCode)
                .filter((cc): cc is string => cc !== undefined)
        ))
        : null;

    return (value: string): string | null =>
    {
        if (isEmpty(value)) return null;

        // Step 1: strip human punctuation. Whitespace, hyphens,
        // dots, parentheses, and Unicode soft-hyphens all go.
        // We keep `+` and digits only.
        const cleaned = value.replace(/[\s\-().­]/g, '');

        // Step 2: must start with `+` and contain only digits
        // after that. Strict E.164.
        if (!/^\+\d+$/.test(cleaned))
        {
            return message ?? 'Phone must be in E.164 format (e.g. +14155551234)';
        }

        const digits = cleaned.slice(1);

        // Step 3: total digit count between 8 and 15. E.164's
        // strict cap is 15; the practical floor is 7 subscriber
        // digits + at least one country-code digit.
        if (digits.length < 8 || digits.length > 15)
        {
            return message ?? 'Phone must have 8 to 15 digits';
        }

        // Step 4 (optional): the number must start with one of the
        // allowed countries' calling codes. A coarse "from an allowed
        // country?" check — it can't disambiguate a code shared by
        // multiple countries (see the file header).
        if (allowedCallingCodes !== null)
        {
            // Empty list (e.g., user passed only unknown ISO codes)
            // means nothing is allowed — fail every input.
            if (allowedCallingCodes.length === 0)
            {
                return message ?? 'No allowed countries';
            }

            const matches = allowedCallingCodes.some(code =>
                digits.startsWith(code)
            );
            if (!matches)
            {
                return message ?? `Phone must be from one of: ${ countryFilter!.join(', ') }`;
            }
        }

        return null;
    };
}
