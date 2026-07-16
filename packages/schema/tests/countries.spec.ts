// @vitest-environment node
//
// Full behavioral coverage for the country dataset and getCountry (countries.ts):
// lookup by ISO code (case-insensitive) and by calling code (with and without a
// leading +), unknown/empty input, shared-calling-code resolution order, and
// dataset integrity (alphabetical by ISO, required well-known members). Pure
// data + a synchronous lookup, so no reactive root is needed.
import { describe, it, expect } from 'vitest';
import { countries, getCountry } from '@azerothjs/schema';

describe('getCountry - by ISO code', () =>
{
    it('resolves a known uppercase ISO code', () =>
    {
        expect(getCountry('US')).toEqual({ code: 'US', name: 'United States', callingCode: '1' });
    });

    it('is case-insensitive on the ISO code', () =>
    {
        expect(getCountry('us')).toEqual(getCountry('US'));
        expect(getCountry('gb')?.code).toBe('GB');
        expect(getCountry('Ir')?.code).toBe('IR');
    });
});

describe('getCountry - by calling code', () =>
{
    it('resolves a calling code with a leading +', () =>
    {
        expect(getCountry('+98')).toEqual({ code: 'IR', name: 'Iran', callingCode: '98' });
    });

    it('resolves a calling code without the leading +', () =>
    {
        expect(getCountry('98')).toEqual(getCountry('+98'));
        expect(getCountry('44')?.callingCode).toBe('44');
    });

    it('tries ISO first, then calling code - an all-letters query never matches a numeric code', () =>
    {
        // 'IR' is an ISO code; it must resolve to Iran, never a calling-code row.
        expect(getCountry('IR')?.code).toBe('IR');
    });
});

describe('getCountry - shared calling codes', () =>
{
    it('resolves a shared calling code to whichever country sorts first by ISO', () =>
    {
        // +1 is shared by many NANP countries; the dataset is ISO-ordered, so the
        // first match is AG (Antigua and Barbuda), the alphabetically-first +1.
        const firstPlusOne = countries.find(c => c.callingCode === '1');
        expect(getCountry('+1')).toEqual(firstPlusOne);
        expect(getCountry('1')?.code).toBe('AG');
    });

    it('still resolves each shared-code country exactly by its ISO code', () =>
    {
        expect(getCountry('US')?.code).toBe('US');
        expect(getCountry('CA')?.code).toBe('CA');
        expect(getCountry('GB')?.code).toBe('GB');
        expect(getCountry('JE')?.code).toBe('JE'); // Jersey, also +44
    });
});

describe('getCountry - unknown and empty input', () =>
{
    it('returns undefined for an unknown ISO code', () =>
    {
        expect(getCountry('XX')).toBeUndefined();
        expect(getCountry('ZZ')).toBeUndefined();
    });

    it('returns undefined for an unknown calling code', () =>
    {
        expect(getCountry('+99999')).toBeUndefined();
        expect(getCountry('00')).toBeUndefined();
    });

    it('returns undefined for empty input', () =>
    {
        expect(getCountry('')).toBeUndefined();
    });
});

describe('countries - dataset integrity', () =>
{
    it('is non-empty and reasonably sized (~245 territories)', () =>
    {
        expect(countries.length).toBeGreaterThan(200);
    });

    it('is sorted alphabetically by ISO code', () =>
    {
        const codes = countries.map(c => c.code);
        const sorted = [...codes].sort();
        expect(codes).toEqual(sorted);
    });

    it('has unique ISO codes', () =>
    {
        const codes = countries.map(c => c.code);
        expect(new Set(codes).size).toBe(codes.length);
    });

    it('contains the well-known members US, GB and IR with correct calling codes', () =>
    {
        const byCode = new Map(countries.map(c => [c.code, c]));
        expect(byCode.get('US')?.callingCode).toBe('1');
        expect(byCode.get('GB')?.callingCode).toBe('44');
        expect(byCode.get('IR')?.callingCode).toBe('98');
    });

    it('stores every ISO code uppercase and every calling code digits-only (no +)', () =>
    {
        for (const c of countries)
        {
            expect(c.code).toBe(c.code.toUpperCase());
            expect(c.code).toMatch(/^[A-Z]{2}$/);
            expect(c.callingCode).toMatch(/^\d+$/);
        }
    });
});
