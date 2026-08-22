// @vitest-environment node
//
// Each cron run as one work unit: concurrent runs isolate their cache scopes through the
// real interceptor, failure reporting keeps flowing to onError with the job's name, and
// the structural `intercept` option is mutually assignable with http's exported
// interceptor type - pinned at the type level, whose failure channel is `npm run
// typecheck` (vitest alone typechecks nothing).
import { describe, expect, expectTypeOf, it } from 'vitest';
import { cached } from 'azerothjs';
import { createWorkUnitInterceptor, type WorkUnitInterceptor } from '@azerothjs/http';
import { createScheduler, type SchedulerOptions } from '@azerothjs/cron';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('cron runs as work units', () =>
{
    it('two concurrent runs each own a scope: reads reuse within a run, never across', async () =>
    {
        let count = 0;
        const family = cached('cron-unit', (key: string) =>
        {
            count++;
            return Promise.resolve(`v:${ key }`);
        });
        let releaseBarrier!: () => void;
        const barrier = new Promise<void>((resolve) =>
        {
            releaseBarrier = resolve;
        });
        let started = 0;
        const scheduler = createScheduler({ intercept: createWorkUnitInterceptor() });
        scheduler.every('read', 3_600_000, async () =>
        {
            started++;
            await barrier;
            await family('k');
            await family('k');
        }, { overlap: 'concurrent' });
        try
        {
            const first = scheduler.runNow('read');
            const second = scheduler.runNow('read');
            while (started < 2)
            {
                await sleep(5);
            }
            releaseBarrier();
            await Promise.all([first, second]);
            expect(count).toBe(2);
        }
        finally
        {
            await scheduler.stop();
        }
    });

    it('a throwing job still reports to onError with its name under the interceptor', async () =>
    {
        const failures: Array<[string, string]> = [];
        const scheduler = createScheduler({
            intercept: createWorkUnitInterceptor(),
            onError: (error, jobName) => void failures.push([jobName, String(error)])
        });
        scheduler.every('boom', 3_600_000, () =>
        {
            throw new Error('job failure');
        });
        try
        {
            await scheduler.runNow('boom');
            expect(failures).toHaveLength(1);
            expect(failures[0]?.[0]).toBe('boom');
            expect(failures[0]?.[1]).toMatch(/job failure/);
        }
        finally
        {
            await scheduler.stop();
        }
    });

    it('a user interceptor whose returned promise rejects reports to onError, and runNow still resolves', async () =>
    {
        const failures: Array<[string, string]> = [];
        const scheduler = createScheduler({
            intercept: () => Promise.reject(new Error('interceptor rejected')),
            onError: (error, jobName) => void failures.push([jobName, String(error)])
        });
        scheduler.every('quiet', 3_600_000, () => undefined);
        try
        {
            await expect(scheduler.runNow('quiet')).resolves.toBeUndefined();
            expect(failures).toHaveLength(1);
            expect(failures[0]?.[0]).toBe('quiet');
            expect(failures[0]?.[1]).toMatch(/interceptor rejected/);
        }
        finally
        {
            await scheduler.stop();
        }
    });

    it('a run-then-throw interceptor executes the job ONCE: the lost-run fallback does not double it', async () =>
    {
        let runs = 0;
        const failures: string[] = [];
        const scheduler = createScheduler({
            intercept: (unit) =>
            {
                void unit();
                throw new Error('post-run throw');
            },
            onError: (error) => void failures.push(String(error))
        });
        scheduler.every('once', 3_600_000, () => void runs++);
        try
        {
            await scheduler.runNow('once');
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(runs).toBe(1);
            expect(failures).toHaveLength(1);
            expect(failures[0]).toMatch(/post-run throw/);
        }
        finally
        {
            await scheduler.stop();
        }
    });

    it('the structural intercept option and http\'s WorkUnitInterceptor are mutually assignable', () =>
    {
        expectTypeOf<WorkUnitInterceptor>().toExtend<NonNullable<SchedulerOptions['intercept']>>();
        expectTypeOf<NonNullable<SchedulerOptions['intercept']>>().toExtend<WorkUnitInterceptor>();
    });
});
