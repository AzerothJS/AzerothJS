/**
 * MODULE: cron/scheduler - named jobs over the expression engine
 *
 * What a hand-rolled setInterval gets wrong, fixed by construction:
 *
 *   - DRIFT. Every arm computes the NEXT wall-clock occurrence and sets ONE timeout to it -
 *     "daily at midnight" stays midnight, it does not become midnight-plus-accumulated-lag.
 *   - OVERLAP. A slow run cannot stack behind itself: the default policy SKIPS a tick that
 *     fires while the previous run is in flight (and counts it), `concurrent` opts out.
 *   - VISIBILITY. `jobs()` is the printable table - name, expression, timezone, next run,
 *     last run, last outcome, overlaps skipped - the route-table idiom for scheduled work.
 *   - SHUTDOWN. `stop({ drain: true })` disarms every timer and awaits in-flight runs up to
 *     a grace period - built to sit next to @azerothjs/http's shutdown().
 *   - CRASHES. A throwing job reports to the scheduler's onError observer and KEEPS its
 *     schedule; the observer's own throws are swallowed.
 *
 * Registration is loud: a malformed expression, an unknown timezone, a duplicate name, or an
 * expression that can never match throws AT schedule() time, not at 3am. Missed occurrences
 * (the process slept, the laptop lid closed) are SKIPPED, never replayed in a burst - the
 * next arm always computes from the current wall clock.
 */

import { parseExpression, nextOccurrence, localKeyOf, assertTimeZone, type CronFields } from './expression.ts';

/** Options for one job. */
export interface JobOptions
{
    /** IANA timezone the expression is evaluated in (default: the system zone). */
    timeZone?: string;

    /** What a tick does while the previous run is still in flight (default 'skip'). */
    overlap?: 'skip' | 'concurrent';
}

/** One row of the printable job table. */
export interface JobInfo
{
    name: string;

    /** The cron expression, or `every <ms>ms` for interval jobs. */
    expression: string;

    timeZone: string | undefined;

    nextRun: Date | null;

    lastRun: Date | null;

    lastOutcome: 'ok' | 'error' | null;

    /** Ticks dropped because a previous run was still in flight (overlap: 'skip'). */
    overlapsSkipped: number;

    /** Runs currently in flight (0 or 1 under 'skip'; unbounded under 'concurrent'). */
    running: number;
}

export interface SchedulerOptions
{
    /** Called with every job failure. Its own throws are swallowed - watching must not break. */
    onError?: (error: unknown, jobName: string) => void;

    /**
     * Lifecycle visibility: runs at debug, overlap skips at warn, failures at error
     * (in addition to onError - the observer is programmatic, this is for humans).
     * STRUCTURAL on purpose - `@azerothjs/logger` (or anything with these methods)
     * plugs in without this package taking a dependency on it.
     */
    logger?: {
        debug(message: string, fields?: Record<string, unknown>): void;
        warn(message: string, fields?: Record<string, unknown>): void;
        error(message: string, fields?: Record<string, unknown>): void;
    };

    /**
     * Keep the process alive for armed timers (default false: timers are unref'd, so a
     * server exits on its own terms and a scheduler never pins a finished process).
     */
    pin?: boolean;
}

export interface Scheduler
{
    /** Registers a cron job. Validates the expression, timezone, and name HERE - loudly. */
    schedule(name: string, expression: string, fn: () => void | Promise<void>, options?: JobOptions): void;

    /** Registers a fixed-interval job (fixed DELAY between arms, not fixed rate). */
    every(name: string, intervalMs: number, fn: () => void | Promise<void>, options?: Pick<JobOptions, 'overlap'>): void;

    /** Registers a daily job at 'HH:MM' - sugar for `schedule(name, 'MM HH * * *')`. */
    at(name: string, timeOfDay: string, fn: () => void | Promise<void>, options?: JobOptions): void;

    /** Runs a job immediately (respecting its overlap policy). Failures report to onError. */
    runNow(name: string): Promise<void>;

    /** The job table - print it at boot, expose it on a health endpoint. */
    jobs(): JobInfo[];

    /** Re-arms every job after a stop(). Jobs auto-arm at registration; this is the restart. */
    start(): void;

    /** Disarms every timer; with `drain` (default true) awaits in-flight runs up to the grace. */
    stop(options?: { drain?: boolean; gracePeriodMs?: number }): Promise<void>;
}

/** @internal */
interface Job
{
    name: string;
    kind: 'cron' | 'every';
    fields: CronFields | null;
    intervalMs: number;
    timeZone: string | undefined;
    overlap: 'skip' | 'concurrent';
    fn: () => void | Promise<void>;
    timer: ReturnType<typeof setTimeout> | null;
    nextAt: number | null;
    /** The local wall-clock key of the last cron firing (dedupes the DST fall-back twin). */
    lastLocalKey: string | undefined;
    lastRun: Date | null;
    lastOutcome: 'ok' | 'error' | null;
    overlapsSkipped: number;
    running: number;
    inflight: Set<Promise<void>>;
}

/** setTimeout's ceiling; longer spans re-arm at the cap and recompute from the wall clock. */
const MAX_DELAY = 2_147_483_647;

/** Builds a scheduler. Jobs arm as they are registered; see {@link Scheduler}. */
export function createScheduler(options: SchedulerOptions = {}): Scheduler
{
    const jobs = new Map<string, Job>();
    let stopped = false;

    function report(error: unknown, jobName: string): void
    {
        try
        {
            options.onError?.(error, jobName);
        }
        catch
        {
            // The observer must never be able to break the scheduler.
        }
    }

    /** Computes the job's next occurrence from the current wall clock. */
    function computeNext(job: Job): number
    {
        if (job.kind === 'every')
        {
            return Date.now() + job.intervalMs;
        }
        return nextOccurrence(job.fields as CronFields, Date.now(), job.timeZone, job.lastLocalKey);
    }

    function arm(job: Job): void
    {
        if (stopped)
        {
            return;
        }
        job.nextAt = computeNext(job);
        armTimerTo(job);
    }

    /** Sets the single timeout toward job.nextAt, clamped; re-checks the clock on fire. */
    function armTimerTo(job: Job): void
    {
        const delay = Math.min(Math.max(0, (job.nextAt as number) - Date.now()), MAX_DELAY);
        job.timer = setTimeout(() => fire(job), delay);
        if (options.pin !== true)
        {
            (job.timer as { unref?: () => void }).unref?.();
        }
    }

    function fire(job: Job): void
    {
        job.timer = null;
        if (stopped)
        {
            return;
        }
        // A clamped long span (or a backwards clock jump) can fire before the occurrence:
        // re-arm toward it without running. Occurrences MISSED while asleep are skipped by
        // construction - the next arm computes from the wall clock, never replays a backlog.
        if (job.nextAt !== null && Date.now() < job.nextAt - 500)
        {
            armTimerTo(job);
            return;
        }
        if (job.kind === 'cron' && job.nextAt !== null)
        {
            job.lastLocalKey = localKeyOf(job.timeZone, job.nextAt);
        }
        if (job.running > 0 && job.overlap === 'skip')
        {
            job.overlapsSkipped++;
            options.logger?.warn('cron overlap skipped', { job: job.name, skipped: job.overlapsSkipped });
        }
        else
        {
            // Deliberately not awaited: run() handles both outcomes internally (it can
            // never reject) and registers itself in job.inflight for stop({ drain }).
            void run(job);
        }
        arm(job);
    }

    /** Executes one run, isolating failures and tracking the in-flight set for drain. */
    function run(job: Job): Promise<void>
    {
        job.running++;
        job.lastRun = new Date();
        const startedAt = performance.now();
        options.logger?.debug('cron run', { job: job.name });
        const promise = Promise.resolve()
            .then(() => job.fn())
            .then(
                () =>
                {
                    job.lastOutcome = 'ok';
                    options.logger?.debug('cron ok', { job: job.name, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 });
                },
                (error: unknown) =>
                {
                    job.lastOutcome = 'error';
                    options.logger?.error('cron failed', { job: job.name, durationMs: Math.round((performance.now() - startedAt) * 100) / 100, error });
                    report(error, job.name);
                }
            )
            .finally(() =>
            {
                job.running--;
                job.inflight.delete(promise);
            });
        job.inflight.add(promise);
        return promise;
    }

    function register(job: Job): void
    {
        if (jobs.has(job.name))
        {
            throw new Error(`Scheduler already has a job named "${ job.name }".`);
        }
        // Validate that the schedule can actually produce an occurrence - a never-matching
        // expression (e.g. "0 0 31 2 *") fails HERE, at the boot, with its name attached.
        computeNext(job);
        jobs.set(job.name, job);
        arm(job);
    }

    return {
        schedule(name, expression, fn, jobOptions = {}): void
        {
            if (jobOptions.timeZone !== undefined)
            {
                assertTimeZone(jobOptions.timeZone);
            }
            register({
                name,
                kind: 'cron',
                fields: parseExpression(expression),
                intervalMs: 0,
                timeZone: jobOptions.timeZone,
                overlap: jobOptions.overlap ?? 'skip',
                fn,
                timer: null,
                nextAt: null,
                lastLocalKey: undefined,
                lastRun: null,
                lastOutcome: null,
                overlapsSkipped: 0,
                running: 0,
                inflight: new Set()
            });
        },

        every(name, intervalMs, fn, jobOptions = {}): void
        {
            if (!Number.isInteger(intervalMs) || intervalMs <= 0)
            {
                throw new Error(`Job "${ name }": every() needs a positive integer interval, got ${ intervalMs }.`);
            }
            register({
                name,
                kind: 'every',
                fields: null,
                intervalMs,
                timeZone: undefined,
                overlap: jobOptions.overlap ?? 'skip',
                fn,
                timer: null,
                nextAt: null,
                lastLocalKey: undefined,
                lastRun: null,
                lastOutcome: null,
                overlapsSkipped: 0,
                running: 0,
                inflight: new Set()
            });
        },

        at(name, timeOfDay, fn, jobOptions = {}): void
        {
            const match = timeOfDay.match(/^(\d{1,2}):(\d{2})$/);
            if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
            {
                throw new Error(`Job "${ name }": at() needs 'HH:MM' (00:00-23:59), got "${ timeOfDay }".`);
            }
            this.schedule(name, `${ Number(match[2]) } ${ Number(match[1]) } * * *`, fn, jobOptions);
        },

        async runNow(name): Promise<void>
        {
            const job = jobs.get(name);
            if (job === undefined)
            {
                throw new Error(`Scheduler has no job named "${ name }".`);
            }
            if (job.running > 0 && job.overlap === 'skip')
            {
                job.overlapsSkipped++;
                options.logger?.warn('cron overlap skipped', { job: job.name, skipped: job.overlapsSkipped });
                return;
            }
            await run(job);
        },

        jobs(): JobInfo[]
        {
            return [...jobs.values()].map((job) => ({
                name: job.name,
                expression: job.kind === 'every' ? `every ${ job.intervalMs }ms` : (job.fields as CronFields).source,
                timeZone: job.timeZone,
                nextRun: job.nextAt !== null && job.timer !== null ? new Date(job.nextAt) : null,
                lastRun: job.lastRun,
                lastOutcome: job.lastOutcome,
                overlapsSkipped: job.overlapsSkipped,
                running: job.running
            }));
        },

        start(): void
        {
            if (!stopped)
            {
                return;
            }
            stopped = false;
            for (const job of jobs.values())
            {
                arm(job);
            }
        },

        async stop({ drain = true, gracePeriodMs = 10_000 } = {}): Promise<void>
        {
            stopped = true;
            const pending: Promise<void>[] = [];
            for (const job of jobs.values())
            {
                if (job.timer !== null)
                {
                    clearTimeout(job.timer);
                    job.timer = null;
                }
                if (drain)
                {
                    pending.push(...job.inflight);
                }
            }
            if (pending.length > 0)
            {
                await Promise.race([
                    Promise.allSettled(pending).then(() => undefined),
                    new Promise<void>((resolve) =>
                    {
                        const cap = setTimeout(resolve, gracePeriodMs);
                        (cap as { unref?: () => void }).unref?.();
                    })
                ]);
            }
        }
    };
}
