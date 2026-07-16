// @vitest-environment node
//
// Full behavioral coverage for the phone() validator (phone.ts): E.164
// acceptance, human-punctuation stripping, the 8-15 digit-count bounds, the
// leading-+ requirement, country-code filtering (including the empty-allowed-set
// rejection and shared-code coarseness), national-format normalization via
// defaultCountry (explicit and auto-inferred), the skip-empty convention, and
// the message override. phone() is a pure synchronous factory.
import { describe, it, expect } from 'vitest';
import { phone } from '@azerothjs/schema';

describe('phone - E.164 acceptance and the leading + requirement', () =>
{
    it('accepts a well-formed E.164 number with 8 to 15 digits', () =>
    {
        const validate = phone();
        expect(validate('+14155551234')).toBeNull(); // 11 digits
        expect(validate('+12345678')).toBeNull(); // 8 digits (floor)
        expect(validate('+123456789012345')).toBeNull(); // 15 digits (cap)
    });

    it('requires the leading + when no defaultCountry is configured', () =>
    {
        const validate = phone();
        expect(validate('14155551234')).toBe('Phone must be in E.164 format (e.g. +14155551234)');
    });

    it('rejects a + followed by anything other than digits', () =>
    {
        const validate = phone();
        expect(validate('+1abc5551234')).toBe('Phone must be in E.164 format (e.g. +14155551234)');
        expect(validate('++14155551234')).toBe('Phone must be in E.164 format (e.g. +14155551234)');
    });
});

describe('phone - punctuation stripping', () =>
{
    it('treats punctuated and bare forms of the same number identically', () =>
    {
        const validate = phone();
        expect(validate('+1 (415) 555-1234')).toBeNull();
        expect(validate('+1.415.555.1234')).toBeNull();
        expect(validate('+1-415-555-1234')).toBeNull();
        // All normalise to the same 11-digit E.164 number.
        expect(validate('+14155551234')).toBeNull();
    });
});

describe('phone - digit-count bounds', () =>
{
    it('rejects fewer than 8 total digits', () =>
    {
        const validate = phone();
        expect(validate('+1234567')).toBe('Phone must have 8 to 15 digits'); // 7 digits
    });

    it('rejects more than 15 total digits', () =>
    {
        const validate = phone();
        expect(validate('+1234567890123456')).toBe('Phone must have 8 to 15 digits'); // 16 digits
    });

    it('accepts exactly the boundary digit counts', () =>
    {
        const validate = phone();
        expect(validate('+12345678')).toBeNull(); // 8
        expect(validate('+123456789012345')).toBeNull(); // 15
    });
});

describe('phone - country-code filtering', () =>
{
    it('accepts numbers whose calling code matches an allowed country', () =>
    {
        const validate = phone({ countries: ['US', 'GB'] });
        expect(validate('+14155551234')).toBeNull(); // +1 -> US
        expect(validate('+442071234567')).toBeNull(); // +44 -> GB
    });

    it('rejects numbers from a country not in the allowed list', () =>
    {
        const validate = phone({ countries: ['US', 'GB'] });
        // +98 (Iran) is not allowed.
        expect(validate('+989170459330')).toBe('Phone must be from one of: US, GB');
    });

    it('rejects everything when only unknown ISO codes are supplied (empty allowed set)', () =>
    {
        const validate = phone({ countries: ['XX', 'ZZ'] });
        expect(validate('+14155551234')).toBe('No allowed countries');
    });

    it('does coarse prefix matching only - a shared calling code admits any NANP number', () =>
    {
        // Documented limitation: phone() cannot disambiguate +1 between US and CA.
        const validate = phone({ countries: ['US'] });
        // A Canadian number also begins with +1, so it passes the US filter.
        expect(validate('+16135551234')).toBeNull();
    });
});

describe('phone - national-format normalization', () =>
{
    it('normalises national input under an explicit defaultCountry, dropping a single trunk 0', () =>
    {
        const validate = phone({ defaultCountry: 'IR' });
        // '09170459330' -> drop trunk 0 -> prepend 98 -> '+989170459330' (12 digits)
        expect(validate('09170459330')).toBeNull();
        // '9170459330' (no trunk 0) -> '+989170459330'
        expect(validate('9170459330')).toBeNull();
    });

    it('leaves an already-E.164 input untouched even when defaultCountry is set', () =>
    {
        const validate = phone({ defaultCountry: 'IR' });
        expect(validate('+989170459330')).toBeNull();
        // A + input is never re-prefixed, so a non-IR + number is judged as-is.
        expect(validate('+14155551234')).toBeNull();
    });

    it('auto-infers defaultCountry when exactly one country is listed', () =>
    {
        const validate = phone({ countries: ['IR'] });
        // National input works because the sole listed country doubles as default.
        expect(validate('09170459330')).toBeNull();
        expect(validate('+989170459330')).toBeNull();
    });

    it('does NOT auto-infer a default when several countries are listed', () =>
    {
        const validate = phone({ countries: ['IR', 'US'] });
        // No default -> national digits-only input fails the leading-+ check
        // (Step 2) before the country filter (Step 4) is ever reached.
        expect(validate('09170459330')).toBe('Phone must be in E.164 format (e.g. +14155551234)');
    });

    it('honours an explicit defaultCountry alongside a multi-country filter', () =>
    {
        const validate = phone({ countries: ['IR', 'US'], defaultCountry: 'IR' });
        // National input is normalised to +98..., which is in the allowed set.
        expect(validate('09170459330')).toBeNull();
    });

    it('normalised national input still passes the country filter', () =>
    {
        const validate = phone({ countries: ['US'] });
        // 10-digit national US number -> '+1' + 10 digits = 11 digits, +1 allowed.
        expect(validate('4155551234')).toBeNull();
    });
});

describe('phone - skip-empty and message override', () =>
{
    it('skips empty values (skip-empty convention)', () =>
    {
        const validate = phone();
        expect(validate('')).toBeNull();
        expect(validate('   ')).toBeNull();
        expect(validate(null as unknown as string)).toBeNull();
        expect(validate(undefined as unknown as string)).toBeNull();
    });

    it('uses the custom message for the missing-+ failure', () =>
    {
        // No defaultCountry, so digits-only input is not normalised and fails.
        expect(phone({ message: 'Bad phone' })('14155551234')).toBe('Bad phone');
    });

    it('uses the custom message for the digit-count failure', () =>
    {
        expect(phone({ message: 'Bad phone' })('+1234567')).toBe('Bad phone');
    });

    it('uses the custom message for the wrong-country failure', () =>
    {
        const validate = phone({ countries: ['US'], message: 'Bad phone' });
        expect(validate('+442071234567')).toBe('Bad phone');
    });

    it('uses the custom message for the empty-allowed-set failure', () =>
    {
        const validate = phone({ countries: ['XX'], message: 'Bad phone' });
        expect(validate('+14155551234')).toBe('Bad phone');
    });
});
