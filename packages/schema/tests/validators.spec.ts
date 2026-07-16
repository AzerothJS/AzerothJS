// @vitest-environment node
//
// Full behavioral coverage for the built-in validators (validators.ts): each
// factory's pass/fail behaviour, custom-message override, the skip-empty
// convention shared by every validator except required(), combine() ordering,
// and oneOf()'s Object.is semantics (NaN). Validators are pure synchronous
// functions, so no reactive root is needed here.
import { describe, it, expect } from 'vitest';
import {
    required,
    minLength,
    maxLength,
    min,
    max,
    pattern,
    email,
    url,
    oneOf,
    combine
} from '@azerothjs/schema';

describe('required', () =>
{
    it('rejects empty string, whitespace-only string, null and undefined', () =>
    {
        const validate = required();
        expect(validate('')).toBe('This field is required');
        expect(validate('   ')).toBe('This field is required');
        expect(validate(null)).toBe('This field is required');
        expect(validate(undefined)).toBe('This field is required');
    });

    it('rejects an empty array', () =>
    {
        expect(required()([])).toBe('This field is required');
    });

    it('accepts a non-empty string, a non-empty array, and the number 0', () =>
    {
        const validate = required();
        expect(validate('hi')).toBeNull();
        expect(validate(['a'])).toBeNull();
        // 0 is a real value, not "missing".
        expect(validate(0)).toBeNull();
        expect(validate(false)).toBeNull();
    });

    it('uses a custom message when supplied', () =>
    {
        expect(required('Name needed')('')).toBe('Name needed');
    });
});

describe('minLength', () =>
{
    it('rejects strings shorter than n and accepts strings of length >= n', () =>
    {
        const validate = minLength(3);
        expect(validate('ab')).toBe('Must be at least 3 characters');
        expect(validate('abc')).toBeNull();
        expect(validate('abcd')).toBeNull();
    });

    it('pluralises the default message: plural for n !== 1', () =>
    {
        expect(minLength(2)('a')).toBe('Must be at least 2 characters');
        expect(minLength(10)('short')).toBe('Must be at least 10 characters');
    });

    it('skips empty values (skip-empty convention)', () =>
    {
        expect(minLength(5)('')).toBeNull();
        expect(minLength(5)('   ')).toBeNull();
        expect(minLength(5)(null as unknown as string)).toBeNull();
        expect(minLength(5)(undefined as unknown as string)).toBeNull();
    });

    it('uses a custom message when supplied', () =>
    {
        expect(minLength(4, 'Too short')('ab')).toBe('Too short');
    });
});

describe('maxLength', () =>
{
    it('rejects strings longer than n and accepts strings of length <= n', () =>
    {
        const validate = maxLength(3);
        expect(validate('abcd')).toBe('Must be at most 3 characters');
        expect(validate('abc')).toBeNull();
        expect(validate('ab')).toBeNull();
    });

    it('skips empty values', () =>
    {
        expect(maxLength(2)('')).toBeNull();
        expect(maxLength(2)(null as unknown as string)).toBeNull();
    });

    it('uses a custom message when supplied', () =>
    {
        expect(maxLength(2, 'Too long')('abc')).toBe('Too long');
    });
});

describe('min', () =>
{
    it('rejects numbers below n and accepts numbers >= n', () =>
    {
        const validate = min(18);
        expect(validate(17)).toBe('Must be at least 18');
        expect(validate(18)).toBeNull();
        expect(validate(19)).toBeNull();
    });

    it('does NOT skip 0 - it is a real numeric value', () =>
    {
        expect(min(1)(0)).toBe('Must be at least 1');
        expect(min(0)(0)).toBeNull();
    });

    it('skips null and undefined only', () =>
    {
        expect(min(5)(null as unknown as number)).toBeNull();
        expect(min(5)(undefined as unknown as number)).toBeNull();
    });

    it('uses a custom message when supplied', () =>
    {
        expect(min(10, 'Need 10+')(3)).toBe('Need 10+');
    });
});

describe('max', () =>
{
    it('rejects numbers above n and accepts numbers <= n', () =>
    {
        const validate = max(5);
        expect(validate(6)).toBe('Must be at most 5');
        expect(validate(5)).toBeNull();
        expect(validate(4)).toBeNull();
    });

    it('skips null and undefined only', () =>
    {
        expect(max(5)(null as unknown as number)).toBeNull();
        expect(max(5)(undefined as unknown as number)).toBeNull();
        // 0 is not skipped: it is below any positive bound but within max bounds.
        expect(max(5)(0)).toBeNull();
    });

    it('uses a custom message when supplied', () =>
    {
        expect(max(5, 'Too big')(9)).toBe('Too big');
    });
});

describe('pattern', () =>
{
    it('passes when the regex matches and fails when it does not', () =>
    {
        const validate = pattern(/^[a-z0-9-]+$/);
        expect(validate('valid-slug-1')).toBeNull();
        expect(validate('Invalid Slug')).toBe('Invalid format');
    });

    it('skips empty values', () =>
    {
        expect(pattern(/^x$/)('')).toBeNull();
        expect(pattern(/^x$/)(null as unknown as string)).toBeNull();
    });

    it('uses a custom message when supplied', () =>
    {
        expect(pattern(/^\d+$/, 'Digits only')('abc')).toBe('Digits only');
    });
});

describe('email', () =>
{
    it('accepts a plausible address and rejects malformed input', () =>
    {
        const validate = email();
        expect(validate('user@example.com')).toBeNull();
        expect(validate('a.b+tag@sub.domain.io')).toBeNull();
        expect(validate('no-at-sign')).toBe('Invalid email address');
        expect(validate('missing@dot')).toBe('Invalid email address');
        expect(validate('with space@example.com')).toBe('Invalid email address');
    });

    it('skips empty values', () =>
    {
        expect(email()('')).toBeNull();
        expect(email()('   ')).toBeNull();
        expect(email()(null as unknown as string)).toBeNull();
    });

    it('uses a custom message when supplied', () =>
    {
        expect(email('Bad email')('nope')).toBe('Bad email');
    });
});

describe('url', () =>
{
    it('accepts URLs the platform parser accepts and rejects the rest', () =>
    {
        const validate = url();
        expect(validate('https://example.com')).toBeNull();
        expect(validate('http://example.com/path?q=1')).toBeNull();
        // new URL() accepts any parseable scheme, including mailto:.
        expect(validate('mailto:a@b.com')).toBeNull();
        expect(validate('not a url')).toBe('Invalid URL');
        expect(validate('example.com')).toBe('Invalid URL'); // no scheme
    });

    it('skips empty values', () =>
    {
        expect(url()('')).toBeNull();
        expect(url()(null as unknown as string)).toBeNull();
    });

    it('uses a custom message when supplied', () =>
    {
        expect(url('Bad URL')('nope')).toBe('Bad URL');
    });
});

describe('oneOf', () =>
{
    it('passes when the value is in the allowed set and fails otherwise', () =>
    {
        const validate = oneOf(['admin', 'editor', 'viewer']);
        expect(validate('admin')).toBeNull();
        expect(validate('viewer')).toBeNull();
        expect(validate('guest')).toBe('Must be one of: admin, editor, viewer');
    });

    it('uses Object.is, so NaN matches NaN (unlike ===)', () =>
    {
        const validate = oneOf([NaN]);
        // === would never match NaN; Object.is does.
        expect(validate(NaN)).toBeNull();
        expect(validate(0)).toBe('Must be one of: NaN');
    });

    it('uses Object.is, so +0 and -0 are distinguished', () =>
    {
        const validate = oneOf([-0]);
        expect(validate(-0)).toBeNull();
        // Object.is(+0, -0) is false, so +0 is rejected.
        expect(validate(0)).toBe('Must be one of: 0');
    });

    it('does NOT skip empty values (it is an exact membership check)', () =>
    {
        // oneOf has no skip-empty convention: '' must be an explicit member.
        expect(oneOf(['a', 'b'])('')).toBe('Must be one of: a, b');
        expect(oneOf(['', 'b'])('')).toBeNull();
    });

    it('uses a custom message when supplied', () =>
    {
        expect(oneOf(['x'], 'Pick x')('y')).toBe('Pick x');
    });
});

describe('combine', () =>
{
    it('returns the first error in declaration order', () =>
    {
        const validate = combine(required(), minLength(3), pattern(/^\d+$/));
        // empty -> required fires first
        expect(validate('')).toBe('This field is required');
        // non-empty but too short -> minLength fires before pattern
        expect(validate('ab')).toBe('Must be at least 3 characters');
        // long enough but not digits -> pattern fires
        expect(validate('abcd')).toBe('Invalid format');
        // satisfies all
        expect(validate('1234')).toBeNull();
    });

    it('reports required on empty and the format error on bad non-empty input', () =>
    {
        const validate = combine(required(), email());
        expect(validate('')).toBe('This field is required');
        expect(validate('bad')).toBe('Invalid email address');
        expect(validate('ok@example.com')).toBeNull();
    });

    it('returns null when every validator passes', () =>
    {
        const validate = combine(minLength(2), maxLength(5));
        expect(validate('abc')).toBeNull();
    });

    it('with no validators always passes', () =>
    {
        expect(combine()('anything')).toBeNull();
    });
});
