// @vitest-environment node
//
// The scheduler under fake timers: drift-free minute alignment across many ticks, overlap
// skip vs concurrent, error isolation (a throwing job keeps its schedule), the drain on
// stop(), runNow, the job table, and loud registration failures.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createScheduler } from '@azerothjs/cron';

beforeEach(() =>
{
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:30.000Z'));
});

afterEach(() =>
{
    vi.useRealTimers();
});

describe('scheduling and drift', () =>
{
    it('an every-minute job stays aligned to the minute across 1000 ticks', async () =>
    {
        const scheduler = createScheduler();
        const firedAt: number[] = [];
        scheduler.schedule('tick', '* * * * *', () =>
        {
            firedAt.push(Date.now());
        }, { timeZone: 'UTC' });

        await vi.advanceTimersByTimeAsync(1000 * 60_000);
        expect(firedAt.length).toBe(1000);
        expect(firedAt.every((t) => t % 60_000 === 0)).toBe(true); // every fire on the exact minute
        await scheduler.stop({ drain: false });
    });

    it('every() runs on its interval and at() lowers onto a daily cron', async () =>
    {
        const scheduler = createScheduler();
        let ticks = 0;
        scheduler.every('pulse', 10_000, () =>
        {
            ticks++;
        });
        scheduler.at('daily', '03:00', () => undefined, { timeZone: 'UTC' });

        await vi.advanceTimersByTimeAsync(35_000);
        expect(ticks).toBe(3);
        const daily = scheduler.jobs().find((job) => job.name === 'daily');
        expect(daily?.expression).toBe('0 3 * * *');
        await scheduler.stop({ drain: false });
    });
});

describe('overlap policy', () =>
{
    it('skip (the default) drops ticks while a run is in flight, and counts them', async () =>
    {
        const scheduler = createScheduler();
        let started = 0;
        scheduler.schedule('slow', '* * * * *', async () =>
        {
            started++;
            await new Promise((resolve) => setTimeout(resolve, 150_000)); // 2.5 minutes
        }, { timeZone: 'UTC' });

        await vi.advanceTimersByTimeAsync(5 * 60_000);
        const info = scheduler.jobs().find((job) => job.name === 'slow');
        expect(started).toBe(2);                       // the 1st run, then the next AFTER it finished
        expect(info?.overlapsSkipped).toBeGreaterThanOrEqual(2); // the ticks that fired mid-run
        await scheduler.stop({ drain: false });
    });

    it('concurrent lets runs stack', async () =>
    {
        const scheduler = createScheduler();
        let started = 0;
        scheduler.schedule('parallel', '* * * * *', async () =>
        {
            started++;
            await new Promise((resolve) => setTimeout(resolve, 150_000));
        }, { timeZone: 'UTC', overlap: 'concurrent' });

        await vi.advanceTimersByTimeAsync(4 * 60_000);
        expect(started).toBe(4);
        await scheduler.stop({ drain: false });
    });
});

describe('failure isolation and lifecycle', () =>
{
    it('a throwing job reports to onError and keeps its schedule', async () =>
    {
        const onError = vi.fn();
        const scheduler = createScheduler({ onError });
        scheduler.schedule('flaky', '* * * * *', () =>
        {
            throw new Error('boom');
        }, { timeZone: 'UTC' });

        await vi.advanceTimersByTimeAsync(3 * 60_000);
        expect(onError).toHaveBeenCalledTimes(3);
        expect(onError).toHaveBeenCalledWith(expect.any(Error), 'flaky');
        expect(scheduler.jobs()[0]?.lastOutcome).toBe('error');
        await scheduler.stop({ drain: false });
    });

    it('an onError observer that itself throws cannot break the scheduler', async () =>
    {
        const scheduler = createScheduler({ onError: () =>
        {
            throw new Error('observer bug');
        } });
        let ran = 0;
        scheduler.schedule('a', '* * * * *', () =>
        {
            ran++;
            throw new Error('job bug');
        }, { timeZone: 'UTC' });

        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(ran).toBe(2);
        await scheduler.stop({ drain: false });
    });

    it('stop({ drain: true }) awaits the in-flight run; nothing fires afterwards', async () =>
    {
        const scheduler = createScheduler();
        let finished = false;
        let started = 0;
        scheduler.schedule('worker', '* * * * *', async () =>
        {
            started++;
            await new Promise((resolve) => setTimeout(resolve, 40_000));
            finished = true;
        }, { timeZone: 'UTC' });

        await vi.advanceTimersByTimeAsync(60_000); // the first run starts (at :00) and is in flight
        expect(started).toBe(1);

        const stopping = scheduler.stop({ drain: true, gracePeriodMs: 300_000 });
        await vi.advanceTimersByTimeAsync(45_000);
        await stopping;
        expect(finished).toBe(true);

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(started).toBe(1); // disarmed: no further runs

        // start() re-arms.
        scheduler.start();
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(started).toBeGreaterThan(1);
        await scheduler.stop({ drain: false });
    });

    it('runNow triggers immediately, respects skip, and never rejects', async () =>
    {
        const onError = vi.fn();
        const scheduler = createScheduler({ onError });
        let ran = 0;
        scheduler.schedule('manual', '0 0 1 1 *', () =>
        {
            ran++;
            throw new Error('still reported');
        }, { timeZone: 'UTC' });

        await scheduler.runNow('manual');
        expect(ran).toBe(1);
        expect(onError).toHaveBeenCalledTimes(1);
        await expect(scheduler.runNow('nope')).rejects.toThrow(/no job named/);
        await scheduler.stop({ drain: false });
    });

    it('the job table reports name, expression, timezone, next/last run, and outcome', async () =>
    {
        const scheduler = createScheduler();
        scheduler.schedule('report', '0 3 * * *', () => undefined, { timeZone: 'UTC' });
        const before = scheduler.jobs()[0];
        expect(before).toMatchObject({ name: 'report', expression: '0 3 * * *', timeZone: 'UTC', lastRun: null, lastOutcome: null, overlapsSkipped: 0, running: 0 });
        expect(before?.nextRun?.toISOString()).toBe('2026-07-10T03:00:00.000Z');

        await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
        const after = scheduler.jobs()[0];
        expect(after?.lastOutcome).toBe('ok');
        expect(after?.nextRun?.toISOString()).toBe('2026-07-11T03:00:00.000Z');
        await scheduler.stop({ drain: false });
    });
});

describe('loud registration', () =>
{
    it('rejects malformed expressions, bad timezones, bad intervals, and duplicates at schedule()', () =>
    {
        const scheduler = createScheduler();
        expect(() => scheduler.schedule('bad', 'not a cron', () => undefined)).toThrow(/expected 5 fields/);
        expect(() => scheduler.schedule('tz', '* * * * *', () => undefined, { timeZone: 'Azeroth/Orgrimmar' })).toThrow();
        expect(() => scheduler.every('neg', -5, () => undefined)).toThrow(/positive integer/);
        expect(() => scheduler.at('when', '25:00', () => undefined)).toThrow(/HH:MM/);
        expect(() => scheduler.schedule('never', '0 0 31 2 *', () => undefined, { timeZone: 'UTC' })).toThrow(/never matches/);

        scheduler.schedule('once', '* * * * *', () => undefined, { timeZone: 'UTC' });
        expect(() => scheduler.schedule('once', '* * * * *', () => undefined)).toThrow(/already has a job/);
        void scheduler.stop({ drain: false });
    });
});

describe('logger seam', () =>
{
    it('reports runs, outcomes, overlap skips, and failures through a structural logger', async () =>
    {
        const events: Array<{ level: string; message: string; fields?: Record<string, unknown> | undefined }> = [];
        const logger = {
            debug: (message: string, fields?: Record<string, unknown>) => events.push({ level: 'debug', message, fields }),
            warn: (message: string, fields?: Record<string, unknown>) => events.push({ level: 'warn', message, fields }),
            error: (message: string, fields?: Record<string, unknown>) => events.push({ level: 'error', message, fields })
        };
        const scheduler = createScheduler({ logger, onError: () => undefined });

        let release: () => void = () => undefined;
        scheduler.every('slow', 60_000, () => new Promise<void>((resolve) =>
        {
            release = resolve;
        }));
        scheduler.every('boom', 60_000, () =>
        {
            throw new Error('job exploded');
        });

        const first = scheduler.runNow('slow');
        await scheduler.runNow('slow'); // overlap: previous run still in flight -> skip + warn
        release();
        await first;
        await scheduler.runNow('boom');
        await scheduler.stop({ drain: true });

        expect(events.some((e) => e.level === 'debug' && e.message === 'cron run' && e.fields?.job === 'slow')).toBe(true);
        expect(events.some((e) => e.level === 'debug' && e.message === 'cron ok' && e.fields?.job === 'slow')).toBe(true);
        expect(events.some((e) => e.level === 'warn' && e.message === 'cron overlap skipped' && e.fields?.job === 'slow')).toBe(true);
        const failure = events.find((e) => e.level === 'error' && e.message === 'cron failed');
        expect(failure?.fields?.job).toBe('boom');
        expect(typeof failure?.fields?.durationMs).toBe('number');
    });
});
