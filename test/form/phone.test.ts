import { describe, it, expect } from 'vitest';
import { phone, countries, getCountry } from '@azerothjs/core';

describe('countries dataset', () =>
{
    it('contains a substantial, alphabetised list', () =>
    {
        expect(countries.length).toBeGreaterThan(200);

        // Spot-check a handful of well-known entries.
        const map = new Map(countries.map(c => [c.code, c]));
        expect(map.get('US')?.callingCode).toBe('1');
        expect(map.get('GB')?.callingCode).toBe('44');
        expect(map.get('IR')?.callingCode).toBe('98');
        expect(map.get('JP')?.callingCode).toBe('81');
        expect(map.get('BR')?.callingCode).toBe('55');

        // Alphabetical order by ISO code.
        for (let i = 1; i < countries.length; i++)
        {
            expect(countries[i].code > countries[i - 1].code).toBe(true);
        }
    });

    it('every entry has a non-empty code, name, and callingCode', () =>
    {
        for (const c of countries)
        {
            expect(c.code).toMatch(/^[A-Z]{2}$/);
            expect(c.name.length).toBeGreaterThan(0);
            expect(c.callingCode).toMatch(/^\d+$/);
        }
    });
});

describe('getCountry', () =>
{
    it('looks up by ISO code (case-insensitive)', () =>
    {
        expect(getCountry('US')?.name).toBe('United States');
        expect(getCountry('us')?.name).toBe('United States');
        expect(getCountry('Ir')?.name).toBe('Iran');
    });

    it('looks up by calling code (with or without leading +)', () =>
    {
        expect(getCountry('+98')?.code).toBe('IR');
        expect(getCountry('98')?.code).toBe('IR');
        expect(getCountry('+81')?.code).toBe('JP');
    });

    it('returns undefined for unknown input', () =>
    {
        expect(getCountry('XX')).toBeUndefined();
        expect(getCountry('+99999')).toBeUndefined();
        expect(getCountry('')).toBeUndefined();
    });

    it('returns the FIRST match for shared calling codes', () =>
    {
        // +1 is shared by US, Canada, and many NANP territories.
        // Alphabetical-by-ISO ordering means AG (Antigua) comes
        // before US - that's the documented "first match" semantic.
        const result = getCountry('+1');
        expect(result).not.toBeUndefined();
        expect(result!.callingCode).toBe('1');
    });
});

describe('phone() - default (no countries filter)', () =>
{
    it('skips empty values', () =>
    {
        expect(phone()('')).toBeNull();
        expect(phone()('   ')).toBeNull();
    });

    it('accepts well-formed E.164 numbers', () =>
    {
        const v = phone();
        expect(v('+14155551234')).toBeNull();
        expect(v('+447911123456')).toBeNull();
        expect(v('+989123456789')).toBeNull();
    });

    it('strips human-friendly punctuation before validation', () =>
    {
        const v = phone();
        expect(v('+1 (415) 555-1234')).toBeNull();
        expect(v('+1.415.555.1234')).toBeNull();
        expect(v('+1 415 555 1234')).toBeNull();
    });

    it('rejects numbers without a leading +', () =>
    {
        const v = phone();
        expect(v('14155551234')).toBe('Phone must be in E.164 format (e.g. +14155551234)');
        expect(v('(415) 555-1234')).toBe('Phone must be in E.164 format (e.g. +14155551234)');
    });

    it('rejects letters and non-digit garbage', () =>
    {
        const v = phone();
        expect(v('+1abc4155551234')).not.toBeNull();
        expect(v('+1 four-one-five')).not.toBeNull();
    });

    it('enforces the 8-15 digit total range', () =>
    {
        const v = phone();
        // 7 digits - too short.
        expect(v('+1234567')).toBe('Phone must have 8 to 15 digits');
        // 16 digits - too long.
        expect(v('+1234567890123456')).toBe('Phone must have 8 to 15 digits');

        // Boundaries are inclusive: 8 and 15 both pass.
        expect(v('+12345678')).toBeNull();         // 8 digits
        expect(v('+123456789012345')).toBeNull();  // 15 digits
    });

    it('honours a custom message override for every failure mode', () =>
    {
        const v = phone({ message: 'Bad phone' });
        expect(v('14155551234')).toBe('Bad phone');         // missing +
        expect(v('+1234567')).toBe('Bad phone');             // too short
        expect(v('+1234567890123456')).toBe('Bad phone');    // too long
    });
});

describe('phone() - with countries filter', () =>
{
    it('accepts numbers whose prefix matches a listed country', () =>
    {
        const v = phone({ countries: ['US', 'GB', 'IR'] });
        expect(v('+14155551234')).toBeNull();   // US
        expect(v('+447911123456')).toBeNull();  // GB
        expect(v('+989123456789')).toBeNull();  // IR
    });

    it('rejects numbers whose prefix does not match any listed country', () =>
    {
        const v = phone({ countries: ['US'] });
        expect(v('+447911123456')).toBe('Phone must be from one of: US');
        expect(v('+989123456789')).toBe('Phone must be from one of: US');
    });

    it('treats unknown ISO codes as silently absent', () =>
    {
        // Only 'XX' is listed (which doesn't exist) -> no allowed
        // codes -> reject everything.
        const v = phone({ countries: ['XX'] });
        expect(v('+14155551234')).toBe('No allowed countries');
    });

    it('applies the longest-prefix-first match correctly', () =>
    {
        // 'IN' (91) and 'AF' (93) are both 2-digit codes - neither
        // is a prefix of the other. This test mainly verifies the
        // sort doesn't break correct matches.
        const v = phone({ countries: ['IN', 'AF'] });
        expect(v('+919876543210')).toBeNull();  // IN
        expect(v('+93701234567')).toBeNull();   // AF
        expect(v('+447911123456')).not.toBeNull(); // GB - rejected
    });

    it('accepts shared-code countries when ANY listed country matches the prefix', () =>
    {
        // +1 covers US, Canada, all NANP territories. Listing just
        // 'US' accepts any +1 number - that's the documented
        // calling-code-only matching limitation.
        const v = phone({ countries: ['US'] });
        // This number could be Canadian, but we accept it because
        // it starts with '1'.
        expect(v('+16041234567')).toBeNull();
    });
});

describe('phone() - national format (optional + and country code)', () =>
{
    it('accepts both national and E.164 forms with an explicit defaultCountry', () =>
    {
        const v = phone({ defaultCountry: 'IR' });

        // The user's example: these must be treated identically.
        expect(v('09170459330')).toBeNull();    // national, trunk 0
        expect(v('+989170459330')).toBeNull();  // E.164
        expect(v('9170459330')).toBeNull();      // national, no trunk 0
        expect(v('0917 045 9330')).toBeNull();   // punctuation stripped first
    });

    it('infers the default country from a single-entry countries list', () =>
    {
        const v = phone({ countries: ['IR'] });

        expect(v('09170459330')).toBeNull();
        expect(v('+989170459330')).toBeNull();
    });

    it('still applies the country filter after normalizing national input', () =>
    {
        const v = phone({ countries: ['IR'], defaultCountry: 'IR' });

        // Normalizes to +98... which matches the IR filter.
        expect(v('09170459330')).toBeNull();
        // An explicit non-IR E.164 number is still rejected.
        expect(v('+14155551234')).toBe('Phone must be from one of: IR');
    });

    it('does NOT accept national format without a resolvable default', () =>
    {
        // No countries, no defaultCountry -> strict E.164 only.
        expect(phone()('09170459330'))
            .toBe('Phone must be in E.164 format (e.g. +14155551234)');

        // Ambiguous (more than one country, no explicit default) ->
        // national format is not normalized, so it's rejected.
        const v = phone({ countries: ['IR', 'US'] });
        expect(v('09170459330'))
            .toBe('Phone must be in E.164 format (e.g. +14155551234)');
    });

    it('leaves +-prefixed input untouched even when a default is set', () =>
    {
        const v = phone({ defaultCountry: 'IR' });
        // Already E.164 - must not get a second country code glued on.
        expect(v('+14155551234')).toBeNull();
    });

    it('enforces the digit range on the normalized number', () =>
    {
        const v = phone({ defaultCountry: 'IR' });
        // '0123' -> '123' -> '+98123' -> 5 digits, below the floor of 8.
        expect(v('0123')).toBe('Phone must have 8 to 15 digits');
    });
});
