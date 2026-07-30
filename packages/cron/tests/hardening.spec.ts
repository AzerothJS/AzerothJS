// @vitest-environment node
//
// Two costs a scheduler must never impose on the process it lives in: a logger call that can
// end it (the calls run inside a timer callback and inside promise handlers, where a throw is
// an uncaughtException or an unhandled rejection - and the failure being described is lost with
// it), and a calendar-impossible expression that pays for its verdict with a ~400000-candidate
// Intl scan at registration.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createScheduler, parseExpression, nextOccurrence } from '@azerothjs/cron';

/** A logger that fails at every level - the shape a broken sink or a bad field value produces. */
function brokenLogger(): { debug: () => never; warn: () => never; error: () => never }
{
    const boom = (): never =>
    {
        throw new Error('logger down');
    };
    return { debug: boom, warn: boom, error: boom };
}

describe('the logger seam cannot break the scheduler', () =>
{
    beforeEach(() =>
    {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-10T00:00:30.000Z'));
    });

    afterEach(() =>
    {
        vi.useRealTimers();
    });

    it('a throwing debug logger does not stop an armed job from running and re-arming', async () =>
    {
        const scheduler = createScheduler({ logger: brokenLogger() });
        let ran = 0;
        scheduler.schedule('tick', '* * * * *', () =>
        {
            ran++;
        }, { timeZone: 'UTC' });

        await vi.advanceTimersByTimeAsync(3 * 60_000);
        expect(ran).toBe(3);
        await scheduler.stop({ drain: false });
    });

    it('a throwing error logger still lets onError see the failure', async () =>
    {
        const onError = vi.fn();
        const scheduler = createScheduler({ logger: brokenLogger(), onError });
        let ran = 0;
        scheduler.schedule('flaky', '* * * * *', () =>
        {
            ran++;
            throw new Error('job boom');
        }, { timeZone: 'UTC' });

        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(ran).toBe(2);
        expect(onError).toHaveBeenCalledTimes(2);
        expect(onError).toHaveBeenCalledWith(expect.any(Error), 'flaky');
        expect(scheduler.jobs()[0]?.lastOutcome).toBe('error');
        await scheduler.stop({ drain: false });
    });

    it('a throwing warn logger does not break the overlap-skip path', async () =>
    {
        const scheduler = createScheduler({ logger: brokenLogger() });
        let release: () => void = () => undefined;
        scheduler.every('slow', 60_000, () => new Promise<void>((resolve) =>
        {
            release = resolve;
        }));

        const first = scheduler.runNow('slow');
        await scheduler.runNow('slow'); // previous run in flight: skip + warn
        release();
        await first;
        expect(scheduler.jobs()[0]?.overlapsSkipped).toBe(1);
        await scheduler.stop({ drain: false });
    });

    it('the observer runs BEFORE the log line, so a broken logger cannot hide a failure', async () =>
    {
        const order: string[] = [];
        const scheduler = createScheduler({
            logger: {
                debug: () => undefined,
                warn: () => undefined,
                error: () =>
                {
                    order.push('logger');
                    throw new Error('logger down');
                }
            },
            onError: () => order.push('onError')
        });
        scheduler.every('boom', 60_000, () =>
        {
            throw new Error('job boom');
        });

        await scheduler.runNow('boom');
        expect(order).toEqual(['onError', 'logger']);
        await scheduler.stop({ drain: false });
    });
});

describe('calendar-impossible expressions fail by arithmetic, not by scanning', () =>
{
    const impossible = ['0 0 30 2 *', '0 0 31 2 *', '0 0 31 4 *', '0 0 31 6 *', '0 0 31 9 *', '0 0 31 11 *', '0 0 30,31 2 *'];

    it('parseExpression refuses every one of them in milliseconds', () =>
    {
        const startedAt = performance.now();
        for (const expression of impossible)
        {
            expect(() => parseExpression(expression)).toThrow(/never matches a real date/);
        }
        // Each one used to burn the whole 400000-candidate scan (~0.9 s) before failing.
        expect(performance.now() - startedAt).toBeLessThan(200);
    });

    it('nextOccurrence refuses hand-built fields the same way', () =>
    {
        const fields = parseExpression('0 0 31 1 *');
        fields.months = new Set([2]);
        const startedAt = performance.now();
        expect(() => nextOccurrence(fields, Date.parse('2026-01-01T00:00:00Z'), 'UTC')).toThrow(/never matches a real date/);
        expect(performance.now() - startedAt).toBeLessThan(200);
    });

    it('registering ten of them costs milliseconds, not seconds', () =>
    {
        const scheduler = createScheduler();
        const startedAt = performance.now();
        for (let index = 0; index < 10; index++)
        {
            expect(() => scheduler.schedule(`impossible-${ index }`, '0 0 31 2 *', () => undefined, { timeZone: 'UTC' }))
                .toThrow(/never matches/);
        }
        expect(performance.now() - startedAt).toBeLessThan(500);
    });

    it('keeps accepting the rare-but-real ones', () =>
    {
        expect([...parseExpression('0 0 29 2 *').daysOfMonth]).toEqual([29]);       // the leap day
        expect([...parseExpression('0 0 31 * *').daysOfMonth]).toEqual([31]);       // 31-day months
        expect([...parseExpression('0 0 31 2 1').daysOfWeek]).toEqual([1]);         // OR-rule: Mondays match
        expect([...parseExpression('0 0 30,31 2,3 *').daysOfMonth]).toEqual([30, 31]); // March allows both
        expect(new Date(nextOccurrence(parseExpression('0 0 29 2 *'), Date.parse('2026-01-01T00:00:00Z'), 'UTC')).toISOString())
            .toBe('2028-02-29T00:00:00.000Z');
    });
});
