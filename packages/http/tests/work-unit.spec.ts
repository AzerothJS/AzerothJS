// @vitest-environment node
//
// The work-unit primitives: runInWorkUnit owns a scope and a cleanup registry released at
// settle; createWorkUnitInterceptor packages that root in the shape ws and cron accept;
// and the store-scope resolver slot is single-writer with same-function idempotence, so
// http survives a consumer's uninstall-reinstall cycle instead of silently collapsing
// every later request onto the default scope.
import { describe, expect, it } from 'vitest';
import { cached } from 'azerothjs';
import { resetDataCache, setStoreScopeResolver } from 'azerothjs/internal';
import { App, createWorkUnitInterceptor, onWorkUnitCleanup, runInWorkUnit } from '@azerothjs/http';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function countingFamily(name: string): { family: (key: string) => Promise<string>; fetches: () => number }
{
    let count = 0;
    const family = cached(name, (key: string) =>
    {
        count++;
        return Promise.resolve(`${ name }:${ key }`);
    });
    return { family, fetches: () => count };
}

describe('the resolver slot is single-writer', () =>
{
    it('refuses a second, different registrant loudly; same-function re-registration is a no-op; null uninstalls', () =>
    {
        const first = (): object | undefined => undefined;
        const second = (): object | undefined => undefined;
        setStoreScopeResolver(null);
        try
        {
            setStoreScopeResolver(first);
            expect(() => setStoreScopeResolver(first)).not.toThrow();
            expect(() => setStoreScopeResolver(second)).toThrow(/already installed/);
            setStoreScopeResolver(null);
            expect(() => setStoreScopeResolver(second)).not.toThrow();
        }
        finally
        {
            setStoreScopeResolver(null);
        }
    });

    it('http re-installs its resolver after a consumer uninstall - the one-shot collapse is gone', async () =>
    {
        const { family, fetches } = countingFamily('reinstall');
        const app = new App();
        app.get('/r', async () =>
        {
            await family('k');
            await family('k');
            return new Response('ok');
        });
        await (await app.handle(new Request('http://local/r'))).text();
        expect(fetches()).toBe(1);
        setStoreScopeResolver(null);
        await (await app.handle(new Request('http://local/r'))).text();
        expect(fetches()).toBe(2);
    });
});

describe('runInWorkUnit', () =>
{
    it('a unit owns a scope: reads reuse inside it, isolate across units, and cleanups run LIFO at settle', async () =>
    {
        const { family, fetches } = countingFamily('unit-scope');
        const order: string[] = [];
        await runInWorkUnit(async () =>
        {
            onWorkUnitCleanup(() => void order.push('first-registered'));
            onWorkUnitCleanup(() => void order.push('second-registered'));
            await family('k');
            await family('k');
        });
        expect(fetches()).toBe(1);
        expect(order).toEqual(['second-registered', 'first-registered']);
        await runInWorkUnit(async () =>
        {
            await family('k');
        });
        expect(fetches()).toBe(2);
    });

    it('nests innermost-wins: a unit inside a unit isolates on the inner scope', async () =>
    {
        const { family, fetches } = countingFamily('unit-nested');
        await runInWorkUnit(async () =>
        {
            await family('k');
            await runInWorkUnit(async () =>
            {
                await family('k');
            });
            await family('k');
        });
        expect(fetches()).toBe(2);
    });

    it('onWorkUnitCleanup outside any unit throws the unit-shaped error', () =>
    {
        expect(() => onWorkUnitCleanup(() => undefined)).toThrow(/outside a work unit/);
    });
});

describe('createWorkUnitInterceptor', () =>
{
    it('two intercepted units isolate; a sync throw and an async rejection both report and never escape', async () =>
    {
        const reported: unknown[] = [];
        const intercept = createWorkUnitInterceptor();
        const report = (error: unknown): void => void reported.push(error);
        const { family, fetches } = countingFamily('intercepted');
        await intercept(async () =>
        {
            await family('k');
            await family('k');
        }, report);
        await intercept(() => family('k'), report);
        expect(fetches()).toBe(2);
        expect(() => intercept(() =>
        {
            throw new Error('sync-boom');
        }, report)).not.toThrow();
        await intercept(() => Promise.reject(new Error('async-boom')), report);
        expect(reported.map((error) => (error as Error).message)).toEqual(['sync-boom', 'async-boom']);
    });

    it('a deadline releases the scope and reports, and the still-running unit keeps reading correct data', async () =>
    {
        const reported: unknown[] = [];
        const intercept = createWorkUnitInterceptor({ deadlineMs: 30 });
        const { family, fetches } = countingFamily('deadline');
        const cleaned: string[] = [];
        let lateValue: string | null = null;
        await intercept(async () =>
        {
            onWorkUnitCleanup(() => void cleaned.push('ran'));
            await family('k');
            await sleep(100);
            lateValue = await family('k');
        }, (error) => void reported.push(error));
        expect(reported).toHaveLength(1);
        expect(String(reported[0])).toMatch(/deadline/);
        expect(lateValue).toBe('deadline:k');
        expect(fetches()).toBe(2);
        expect(cleaned).toEqual(['ran']);
    });

    it('the interceptor marks the process a server (the factory is an http entry point)', async () =>
    {
        resetDataCache();
        const { family, fetches } = countingFamily('factory-marks');
        await family('k');
        expect(fetches()).toBe(1);
        createWorkUnitInterceptor();
        await family('k');
        await family('k');
        expect(fetches()).toBe(3);
    });
});
