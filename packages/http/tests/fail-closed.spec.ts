// @vitest-environment node
//
// On a marked server the data cache fails closed at the default scope, so an unwrapped
// WebSocket handler, cron body, or module-level read gets correct data with NO
// cross-identity sharing - and pays fresh fetches for it.
//
// Ordering in this file is LOAD-BEARING: the server mark is construction-onward and
// process-global, so the pre-mark control MUST run before anything marks, and each
// entry-point arm resets the mark to supply its own evidence.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cached } from 'azerothjs';
import { latchServerData, resetDataCache } from 'azerothjs/internal';
import { App, runInRequestRoot, toFetchHandler } from '@azerothjs/http';
import { serve, serveH2c } from '@azerothjs/http/node';
import { attachWebSockets } from '@azerothjs/ws';
import { createScheduler } from '@azerothjs/cron';

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

afterAll(() =>
{
    resetDataCache();
});

describe('the fail-closed admission rule (order-dependent)', () =>
{
    it('caches at the default scope BEFORE any http entry point runs (construction-onward)', async () =>
    {
        const { family, fetches } = countingFamily('pre-mark');
        expect(await family('k')).toBe('pre-mark:k');
        await family('k');
        expect(fetches()).toBe(1);
    });

    it('refuses the default scope after App construction: no reuse, no single-flight, one diagnostic naming both remedies', async () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            new App();
            const { family, fetches } = countingFamily('marked-app');
            expect(await family('k')).toBe('marked-app:k');
            await family('k');
            expect(fetches()).toBe(2);
            const [first, second] = await Promise.all([family('c'), family('c')]);
            expect(first).toBe('marked-app:c');
            expect(second).toBe('marked-app:c');
            expect(fetches()).toBe(4);
            const remedies = warn.mock.calls
                .map((call) => String(call[0]))
                .filter((line) => line.includes('runInRequestRoot') && line.includes('runInWorkUnit'));
            expect(remedies).toHaveLength(1);
        }
        finally
        {
            warn.mockRestore();
        }
    });

    it('leaves the HTTP request path untouched on a marked process', async () =>
    {
        const { family, fetches } = countingFamily('per-request');
        const app = new App();
        app.get('/r', async () =>
        {
            await family('k');
            await family('k');
            return new Response('ok');
        });
        const response = await app.handle(new Request('http://local/r'));
        await response.text();
        expect(fetches()).toBe(1);
    });

    it('refuses identically when the process is ALSO latched (latch independence)', async () =>
    {
        latchServerData();
        const { family, fetches } = countingFamily('latched-marked');
        await family('k');
        await family('k');
        expect(fetches()).toBe(2);
    });

    it('resetDataCache clears the mark: default-scope caching returns', async () =>
    {
        resetDataCache();
        const { family, fetches } = countingFamily('after-reset');
        await family('k');
        await family('k');
        expect(fetches()).toBe(1);
    });

    it('is marked by runInRequestRoot and toFetchHandler, each proven from an unmarked baseline', async () =>
    {
        resetDataCache();
        {
            const { family, fetches } = countingFamily('entry-root');
            await family('k');
            await family('k');
            expect(fetches()).toBe(1);
            await runInRequestRoot(() => 'ok', undefined);
            await family('k');
            await family('k');
            expect(fetches()).toBe(3);
        }
        resetDataCache();
        {
            const { family, fetches } = countingFamily('entry-fetch');
            await family('k');
            expect(fetches()).toBe(1);
            toFetchHandler(() => new Response('ok'));
            await family('k');
            await family('k');
            expect(fetches()).toBe(3);
        }
    });

    it('is marked by serve and serveH2c', async () =>
    {
        resetDataCache();
        {
            const { family, fetches } = countingFamily('entry-serve');
            await family('k');
            expect(fetches()).toBe(1);
            const served = await serve({ handle: async () => new Response('ok') }, { banner: false });
            try
            {
                await family('k');
                await family('k');
                expect(fetches()).toBe(3);
            }
            finally
            {
                await served.shutdown({ gracePeriodMs: 500 });
            }
        }
        resetDataCache();
        {
            const { family, fetches } = countingFamily('entry-h2c');
            await family('k');
            expect(fetches()).toBe(1);
            const served = await serveH2c({ handle: async () => new Response('ok') });
            try
            {
                await family('k');
                await family('k');
                expect(fetches()).toBe(3);
            }
            finally
            {
                await served.shutdown({ gracePeriodMs: 500 });
            }
        }
    });

    it('two ws clients on a marked server each pay their own fetch instead of sharing one cache', async () =>
    {
        const { family, fetches } = countingFamily('ws-clients');
        const app = new App();
        app.get('/health', () => new Response('ok'));
        const served = await serve(app, { banner: false });
        const detach = attachWebSockets(served.server, {
            path: '/ws',
            onConnection: (socket) =>
            {
                socket.onMessage = () =>
                {
                    void family('shared').then((value) => socket.send(value));
                };
            }
        });
        const readOnce = (): Promise<string> => new Promise((resolve, reject) =>
        {
            const client = new WebSocket(`ws://127.0.0.1:${ served.port }/ws`);
            client.addEventListener('open', () => client.send('go'));
            client.addEventListener('message', (event) =>
            {
                client.close();
                resolve(String(event.data));
            });
            client.addEventListener('error', () => reject(new Error('ws client error')));
        });
        try
        {
            expect(await readOnce()).toBe('ws-clients:shared');
            expect(await readOnce()).toBe('ws-clients:shared');
            expect(fetches()).toBe(2);
        }
        finally
        {
            detach();
            await served.shutdown({ gracePeriodMs: 500 });
        }
    });

    it('cron runs on a marked process do not share a cache', async () =>
    {
        const { family, fetches } = countingFamily('cron-runs');
        const scheduler = createScheduler();
        scheduler.every('read', 3_600_000, async () =>
        {
            await family('shared');
        });
        try
        {
            await scheduler.runNow('read');
            await scheduler.runNow('read');
            expect(fetches()).toBe(2);
        }
        finally
        {
            await scheduler.stop();
        }
    });
});
