// @vitest-environment node
//
// date(): the Date wire codec. One schema owns both directions - an ISO 8601 string (the
// only shape JSON can carry) parses OUT as a Date instance, a Date instance passes through,
// and everything else is a type failure. min/max compare instants, not strings.

import { describe, it, expect, expectTypeOf } from 'vitest';
import { date, object, SchemaError, type Infer } from '@azerothjs/schema';

describe('date(): acceptance', () =>
{
    it('parses an ISO 8601 string into a Date instance', () =>
    {
        const parsed = date().parse('2026-08-07T12:30:00Z');
        expect(parsed).toBeInstanceOf(Date);
        expect(parsed.toISOString()).toBe('2026-08-07T12:30:00.000Z');
    });

    it('passes a valid Date instance through unchanged', () =>
    {
        const instant = new Date('2026-01-02T03:04:05.678Z');
        const parsed = date().parse(instant);
        expect(parsed).toBe(instant);
    });

    it('accepts offset and fractional-second forms', () =>
    {
        expect(date().safeParse('2026-08-07T12:30:00.123+03:30').ok).toBe(true);
        expect(date().safeParse('2026-08-07T12:30:00').ok).toBe(true);
    });

    it('infers Date as the schema type', () =>
    {
        const schema = object({ at: date() });
        expectTypeOf<Infer<typeof schema>>().toEqualTypeOf<{ at: Date }>();
        expect(schema.safeParse({ at: '2026-08-07T00:00:00Z' }).ok).toBe(true);
    });
});

describe('date(): rejection', () =>
{
    it('rejects an invalid Date instance as a type failure', () =>
    {
        const result = date().safeParse(new Date(NaN));
        expect(result.ok).toBe(false);
        if (!result.ok)
        {
            expect(result.issues[0]?.code).toBe('type');
        }
    });

    it('rejects a non-ISO string Date.parse would accept', () =>
    {
        // 'Jan 1 2026' round trips through Date.parse but is not a wire shape - the
        // pattern gate rejects it before leniency can leak in.
        const result = date().safeParse('Jan 1 2026');
        expect(result.ok).toBe(false);
        if (!result.ok)
        {
            expect(result.issues[0]?.code).toBe('format');
        }
    });

    it('rejects an ISO-shaped string naming an impossible instant', () =>
    {
        const result = date().safeParse('2026-13-99T00:00:00Z');
        expect(result.ok).toBe(false);
        if (!result.ok)
        {
            expect(result.issues[0]?.code).toBe('format');
        }
    });

    it('rejects numbers, missing values, and objects', () =>
    {
        expect(date().safeParse(1754500000000).ok).toBe(false);
        expect(date().safeParse(undefined).ok).toBe(false);
        expect(date().safeParse(null).ok).toBe(false);
        expect(date().safeParse({}).ok).toBe(false);
        const missing = date().safeParse(undefined);
        if (!missing.ok)
        {
            expect(missing.issues[0]?.code).toBe('required');
        }
    });
});

describe('date(): bounds', () =>
{
    it('min and max compare instants with the min/max codes', () =>
    {
        const schema = date({ min: new Date('2026-01-01T00:00:00Z'), max: new Date('2026-12-31T00:00:00Z') });
        const early = schema.safeParse('2025-06-01T00:00:00Z');
        expect(early.ok).toBe(false);
        if (!early.ok)
        {
            expect(early.issues[0]?.code).toBe('min');
        }
        const late = schema.safeParse('2027-06-01T00:00:00Z');
        expect(late.ok).toBe(false);
        if (!late.ok)
        {
            expect(late.issues[0]?.code).toBe('max');
        }
        expect(schema.safeParse('2026-06-01T00:00:00Z').ok).toBe(true);
    });

    it('honors code overrides like every other node', () =>
    {
        const schema = date({ codes: { format: 'bad-date' } });
        const result = schema.safeParse('nope');
        expect(result.ok).toBe(false);
        if (!result.ok)
        {
            expect(result.issues[0]?.code).toBe('bad-date');
        }
    });
});

describe('date(): chains and interop', () =>
{
    it('optional, nullable, and refine derive as usual', () =>
    {
        expect(date().optional().safeParse(undefined).ok).toBe(true);
        expect(date().nullable().safeParse(null).ok).toBe(true);
        const weekday = date().refine((value) => (value.getUTCDay() === 0 ? 'No Sundays' : null));
        const sunday = weekday.safeParse('2026-08-09T00:00:00Z');
        expect(sunday.ok).toBe(false);
        expect(weekday.safeParse('2026-08-07T00:00:00Z').ok).toBe(true);
    });

    it('carries meta kind date for compile-from-declaration consumers', () =>
    {
        expect(date().meta?.kind).toBe('date');
        expect(date().optional().meta?.optional).toBe(true);
    });

    it('speaks Standard Schema v1', () =>
    {
        const outcome = date()['~standard'].validate('2026-08-07T00:00:00Z');
        expect(outcome).toHaveProperty('value');
    });

    it('parse throws SchemaError on failure', () =>
    {
        expect(() => date().parse('nope')).toThrow(SchemaError);
    });

    it('a dotted path names the failing field inside an object', () =>
    {
        const schema = object({ meta: object({ at: date() }) });
        const result = schema.safeParse({ meta: { at: 'nope' } });
        expect(result.ok).toBe(false);
        if (!result.ok)
        {
            expect(result.issues[0]?.path).toBe('meta.at');
        }
    });
});
