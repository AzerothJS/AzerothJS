// @vitest-environment node
//
// The expression engine: the parser's accept/reject matrix, and next-occurrence golden cases
// including the two DST behaviors the scheduler promises - a nonexistent local time is
// skipped, a repeated one fires once. DST cases pin a real IANA zone (America/New_York:
// spring forward 2026-03-08 02:00 -> 03:00, fall back 2026-11-01 02:00 -> 01:00).

import { describe, it, expect } from 'vitest';
import { parseExpression, nextOccurrence, localKeyOf } from '@azerothjs/cron';

const utc = (iso: string): number => Date.parse(iso);

/** Next occurrence as a UTC ISO string, for readable assertions. */
function next(expression: string, afterIso: string, timeZone?: string, skipKey?: string): string
{
    return new Date(nextOccurrence(parseExpression(expression), utc(afterIso), timeZone, skipKey)).toISOString();
}

describe('parser: accept matrix', () =>
{
    it('parses stars, values, ranges, steps, lists, and names', () =>
    {
        const fields = parseExpression('*/15 9-17 1,15 jan-mar,dec mon-fri');
        expect([...fields.minutes]).toEqual([0, 15, 30, 45]);
        expect(fields.hours.size).toBe(9);
        expect([...fields.daysOfMonth]).toEqual([1, 15]);
        expect([...fields.months]).toEqual([1, 2, 3, 12]);
        expect([...fields.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    });

    it('day-of-week 7 normalizes to Sunday (0) and names are case-insensitive', () =>
    {
        expect([...parseExpression('0 0 * * 7').daysOfWeek]).toEqual([0]);
        expect([...parseExpression('0 0 * * SUN').daysOfWeek]).toEqual([0]);
    });

    it('the vixie value/step form runs from the value to the max', () =>
    {
        expect([...parseExpression('50/5 * * * *').minutes]).toEqual([50, 55]);
    });

    it('@aliases resolve and keep their source for the table', () =>
    {
        const daily = parseExpression('@daily');
        expect([...daily.minutes]).toEqual([0]);
        expect([...daily.hours]).toEqual([0]);
        expect(daily.source).toBe('@daily');
    });
});

describe('parser: rejection matrix', () =>
{
    const bad: Array<[string, RegExp]> =
    [
        ['0 0 * *', /expected 5 fields/],
        ['0 0 * * * *', /expected 5 fields/],
        ['60 * * * *', /minute value 60/],
        ['* 24 * * *', /hour value 24/],
        ['* * 0 * *', /day-of-month value 0/],
        ['* * * 13 *', /month value 13/],
        ['* * * foo *', /not a valid month/],
        ['5-1 * * * *', /runs backwards/],
        ['*/0 * * * *', /positive integer/],
        ['1//2 * * * *', /more than one/],
        ['1,,2 * * * *', /empty minute term/],
        ['@fortnightly', /unknown alias/]
    ];
    for (const [expression, message] of bad)
    {
        it(`rejects "${ expression }"`, () =>
        {
            expect(() => parseExpression(expression)).toThrow(message);
        });
    }
});

describe('next occurrence: golden cases (UTC)', () =>
{
    it('simple minute and hour stepping', () =>
    {
        expect(next('*/15 * * * *', '2026-07-10T12:07:00Z', 'UTC')).toBe('2026-07-10T12:15:00.000Z');
        expect(next('30 9 * * *', '2026-07-10T10:00:00Z', 'UTC')).toBe('2026-07-11T09:30:00.000Z');
    });

    it('is strictly AFTER the reference instant', () =>
    {
        expect(next('0 12 * * *', '2026-07-10T12:00:00Z', 'UTC')).toBe('2026-07-11T12:00:00.000Z');
    });

    it('month boundaries: day 31 only lands in 31-day months', () =>
    {
        expect(next('0 0 31 * *', '2026-02-10T00:00:00Z', 'UTC')).toBe('2026-03-31T00:00:00.000Z');
    });

    it('leap day: Feb 29 waits for 2028', () =>
    {
        expect(next('0 0 29 2 *', '2026-01-01T00:00:00Z', 'UTC')).toBe('2028-02-29T00:00:00.000Z');
    });

    it('dom/dow BOTH restricted is an OR (the vixie rule)', () =>
    {
        // "the 13th, or any Friday" after Wed 2026-01-07: Friday the 9th comes first...
        expect(next('0 0 13 * 5', '2026-01-07T12:00:00Z', 'UTC')).toBe('2026-01-09T00:00:00.000Z');
        // ...and after that Friday, the 13th (a Tuesday) comes before the next Friday.
        expect(next('0 0 13 * 5', '2026-01-09T12:00:00Z', 'UTC')).toBe('2026-01-13T00:00:00.000Z');
    });

    it('only dow restricted: plain weekday scheduling', () =>
    {
        expect(next('0 9 * * mon', '2026-07-10T00:00:00Z', 'UTC')).toBe('2026-07-13T09:00:00.000Z');
    });

    it('a never-matching expression throws instead of hanging', () =>
    {
        expect(() => next('0 0 31 2 *', '2026-01-01T00:00:00Z', 'UTC')).toThrow(/never matches/);
    });
});

describe('next occurrence: DST semantics (America/New_York)', () =>
{
    const NY = 'America/New_York';

    it('a nonexistent local time (spring forward) is skipped, not shifted', () =>
    {
        // 02:30 EST on Mar 7 = 07:30Z; Mar 8 02:30 does not exist; next is Mar 9 02:30 EDT = 06:30Z.
        expect(next('30 2 * * *', '2026-03-06T12:00:00Z', NY)).toBe('2026-03-07T07:30:00.000Z');
        expect(next('30 2 * * *', '2026-03-07T12:00:00Z', NY)).toBe('2026-03-09T06:30:00.000Z');
    });

    it('a repeated local time (fall back) fires once via the local-key dedupe', () =>
    {
        // 01:30 local occurs twice on Nov 1: 01:30 EDT (05:30Z) and 01:30 EST (06:30Z).
        const firstEpoch = nextOccurrence(parseExpression('30 1 * * *'), utc('2026-10-31T12:00:00Z'), NY);
        expect(new Date(firstEpoch).toISOString()).toBe('2026-11-01T05:30:00.000Z');

        // Without the dedupe key the twin an hour later matches again...
        expect(next('30 1 * * *', new Date(firstEpoch).toISOString(), NY)).toBe('2026-11-01T06:30:00.000Z');

        // ...with the fired occurrence's key, the twin is skipped: next is Nov 2, 01:30 EST.
        const firedKey = localKeyOf(NY, firstEpoch);
        expect(next('30 1 * * *', new Date(firstEpoch).toISOString(), NY, firedKey)).toBe('2026-11-02T06:30:00.000Z');
    });

    it('timezone changes the wall clock the expression means', () =>
    {
        // Midnight in New York on 2026-07-11 is 04:00Z (EDT).
        expect(next('0 0 * * *', '2026-07-10T12:00:00Z', NY)).toBe('2026-07-11T04:00:00.000Z');
    });
});
