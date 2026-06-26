/**
 * MODULE: form/phone
 *
 * phone() validator: checks phone numbers in E.164 international format. Pragmatic scope - starts
 * with `+`, total digit count 8-15, and (optionally) the calling-code prefix matches one of a
 * supplied country list.
 *
 * WHAT IT DOES:
 *   - Strips human punctuation (spaces, hyphens, dots, parentheses) so `+1 (415) 555-1234` and
 *     `+14155551234` are treated identically.
 *   - Requires the leading `+` (strict E.164) UNLESS defaultCountry is set, in which case national
 *     input (no `+`, optional leading trunk `0`) is normalized to E.164 first - `09170459330`
 *     validates like `+989170459330`.
 *   - Requires 8-15 total digits (E.164 caps at 15; 7 subscriber digits + >=1 country-code digit is
 *     the realistic floor).
 *   - With countries:[...], checks that the digits start with one of those countries' calling codes.
 *
 * WHAT IT DOES NOT DO: per-country length validation, mobile/landline/special-service distinction,
 * carrier-code validation, or disambiguation between countries sharing a calling code (+1 accepts any
 * NANP number, not just genuine US). For any of those, chain libphonenumber-js as a
 * FieldValidator<string> via combine() - we deliberately don't ship its ~70 KB metadata.
 *
 * Like every other validator, phone() passes silently on empty/null/undefined; pair with required()
 * when the field is mandatory.
 */

import type { FieldValidator } from './create-form.ts';
import { getCountry } from './countries.ts';
import { isEmpty } from './validators.ts';

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
     * If the array is empty or `undefined`, any valid E.164 number passes.
     * Unknown ISO codes are silently ignored - they won't accept anything (or
     * reject anything specific).
     */
    countries?: string[];

    /**
     * Accept local/national format too - numbers written without a leading `+`
     * and country code. ISO 3166-1 alpha-2 code of the country to assume for
     * such input (e.g. `'IR'`).
     *
     * When set, an all-digits input with no `+` is normalized to E.164 before
     * validation: a single leading national-trunk `0` is dropped and the
     * country's calling code is prepended. So with `defaultCountry: 'IR'`:
     *
     *   '09170459330'    -> '+989170459330'   (trunk 0 dropped)
     *   '9170459330'     -> '+989170459330'   (no trunk 0)
     *   '+989170459330'  -> unchanged         (already E.164)
     *
     * If omitted but exactly one country is listed in `countries`, that country
     * is used as the default automatically (it's unambiguous). Inputs that
     * already start with `+` are never touched.
     */
    defaultCountry?: string;

    /**
     * Override the default error message. The same message is used for every
     * kind of failure (missing `+`, wrong digit count, country mismatch); for
     * granular messages, build your own validator with the country dataset
     * directly.
     */
    message?: string;
}

/**
 * phone
 *
 * PURPOSE:
 * Validator factory: returns a FieldValidator<string> that accepts E.164 phone numbers, optionally
 * restricted to (and normalized for) a list of countries.
 *
 * WHY IT EXISTS:
 * Forms commonly need phone validation, but bundling full libphonenumber metadata (~70 KB) is overkill
 * for "looks like a valid international number". phone() covers the common case with zero dependencies,
 * and composes with libphonenumber-js via combine() when exact rules are required.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, form; a validator factory for createForm's `validate` map, built on the country dataset
 * (getCountry) to resolve calling codes.
 *
 * INPUT CONTRACT:
 * - options?: { countries?, defaultCountry?, message? } - all optional (see {@link PhoneOptions}).
 *
 * OUTPUT CONTRACT:
 * - A FieldValidator<string>: value -> error message | null. Allowed calling codes and the default
 *   calling code are precomputed once at construction, not per call.
 *
 * WHY THIS DESIGN:
 * Calling codes are resolved + de-duplicated at construction (US/CA both map to '1'), so each call is
 * cheap. National-format normalization (drop a leading trunk '0', prepend the calling code) lets users
 * type local numbers. The country check is a coarse prefix match, NOT longest-prefix disambiguation -
 * deliberate, to stay dependency-free.
 *
 * WHEN TO USE:
 * Lightweight phone validation in forms, with optional country restriction.
 *
 * WHEN NOT TO USE:
 * Exact per-country length, mobile-vs-landline, or carrier rules - chain libphonenumber-js instead.
 *
 * EDGE CASES:
 * - Skips empty values (pair with required()).
 * - An empty allowed-codes list (only unknown ISO codes passed) rejects every input.
 * - Shared calling codes are not disambiguated (+1 accepts any NANP number).
 * - defaultCountry is auto-inferred when exactly one country is listed.
 *
 * PERFORMANCE NOTES:
 * Country lookups + de-dup run once at construction; per-call work is a couple of regex tests plus a
 * prefix scan over the (small) allowed-codes array.
 *
 * DEVELOPER WARNING:
 * This is FORMAT/PREFIX validation, not real-number validation - it does not prove a number is
 * assigned or dialable. Don't rely on it for that.
 *
 * Skips empty values - pair with `required()` to enforce both:
 *
 * ```ts
 * validate: { phone: combine(required(), phone({ countries: ['US', 'GB'] })) }
 * ```
 *
 * @param options - Optional `{ countries, defaultCountry, message }` configuration
 * @returns A `FieldValidator<string>` ready to slot into a form's `validate` map
 * @see {@link PhoneOptions}
 * @see {@link combine}
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
 * // Accept national format too (optional + and country code).
 * // With one country, it doubles as the default - both
 * // '09170459330' and '+989170459330' pass:
 * createForm({
 *     initial: { phone: '' },
 *     validate: { phone: phone({ countries: ['IR'] }) }
 * });
 * // Or set it explicitly while allowing several countries:
 * phone({ countries: ['IR', 'US'], defaultCountry: 'IR' });
 *
 * // Inputs all parse the same way after stripping punctuation:
 * //   '+1 (415) 555-1234'  OK
 * //   '+14155551234'       OK
 * //   '+1.415.555.1234'    OK
 * //   '4155551234'         no (no leading +)
 * //   '+98 21 1234567'     OK if 'IR' is in countries
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

    // Pre-compute the allowed calling codes once at validator construction
    // time - looked up via the country dataset and de-duplicated, since multiple
    // ISO codes share one calling code (US and CA both map to '1'). Order is
    // irrelevant: the check below is a boolean "does the number start with any
    // of these codes", not a longest-prefix disambiguation.
    const allowedCallingCodes: string[] | null = countryFilter
        ? Array.from(new Set(
            countryFilter
                .map(code => getCountry(code)?.callingCode)
                .filter((cc): cc is string => cc !== undefined)
        ))
        : null;

    // Resolve the calling code used to normalize national-format input (numbers
    // without a leading `+`). Explicit defaultCountry wins; otherwise fall back
    // to the sole countries entry when there's exactly one (unambiguous). null
    // means no national support.
    const defaultCountry =
        options?.defaultCountry ??
        (countryFilter && countryFilter.length === 1 ? countryFilter[0] : undefined);
    const defaultCallingCode = defaultCountry
        ? getCountry(defaultCountry)?.callingCode ?? null
        : null;

    return (value: string): string | null =>
    {
        if (isEmpty(value))
        {
            return null;
        }

        // Step 1: strip human punctuation. Whitespace, hyphens, dots,
        // parentheses, and Unicode soft-hyphens all go. Keep `+` and digits only.
        let cleaned = value.replace(/[\s\-().­]/g, '');

        // Step 1b (optional): national-format normalization. If the input is
        // all digits with no `+` and a default country is configured, convert it
        // to E.164 - drop a single leading national-trunk `0`, then prepend
        // `+<callingCode>`. This is what lets '09170459330' validate the same as
        // '+989170459330' under `defaultCountry: 'IR'`.
        if (defaultCallingCode !== null && /^\d+$/.test(cleaned))
        {
            const national = cleaned.startsWith('0') ? cleaned.slice(1) : cleaned;
            cleaned = '+' + defaultCallingCode + national;
        }

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

        // Step 4 (optional): the number must start with one of the allowed
        // countries' calling codes. A coarse "from an allowed country?" check -
        // it can't disambiguate a code shared by multiple countries (see the
        // file header).
        if (allowedCallingCodes !== null)
        {
            // Empty list (e.g. only unknown ISO codes were passed) means
            // nothing is allowed - fail every input.
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
