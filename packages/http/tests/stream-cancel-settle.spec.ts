// @vitest-environment node
//
// Who settles the request when a streaming client disconnects?
//
// Cancelling a monitored body runs the cancel algorithm, whose `reader.cancel` resolves the
// PENDING inner read with `done: true`. The pull then wakes and, without a latch, calls
// `close()` on a controller the consumer already closed - which throws into the pull's catch.
// The catch then runs the request's cleanups immediately, WHILE the source's own `cancel()` is
// still unwinding. That inverts the contract the wrapper exists to enforce: teardown that
// releases a pooled connection, transaction, or lock must not fire while the stream is still
// pulling through it.
//
// The oracle is timing, because both branches run the same cleanups and only their ORDER
// differs. A deliberately slow source cancel separates them.
import { describe, expect, it } from 'vitest';

import { App } from '../src/app.ts';
import { onWorkUnitCleanup } from '../src/request-root.ts';

const SLOW_CANCEL_MS = 200;

interface Run
{
    cleanupAt: number;
    cancelEndAt: number;
    events: string[];
}

async function cancelDuringPull(app: App, path: string): Promise<Run>
{
    const response = await app.handle(new Request(`http://local${ path }`));
    const reader = response.body!.getReader();
    await reader.read();                      // leaves a pull in flight
    void reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, SLOW_CANCEL_MS + 200));
    return (app as unknown as { __run: Run }).__run;
}

function rig(): App
{
    const run: Run = { cleanupAt: -1, cancelEndAt: -1, events: [] };
    const app = new App();
    (app as unknown as { __run: Run }).__run = run;
    let t0 = 0;

    app.get('/live', () =>
    {
        t0 = Date.now();
        onWorkUnitCleanup(() =>
        {
            run.cleanupAt = Date.now() - t0;
            run.events.push('cleanup');
        });
        return new Response(new ReadableStream<Uint8Array>({
            pull(controller)
            {
                controller.enqueue(new TextEncoder().encode('x'));
                // Never settles by itself: the consumer's cancel is what ends this pull.
                return new Promise<void>(() =>
                {});
            },
            cancel()
            {
                run.events.push('source-cancel-start');
                return new Promise<void>((resolve) => setTimeout(() =>
                {
                    run.cancelEndAt = Date.now() - t0;
                    run.events.push('source-cancel-end');
                    resolve();
                }, SLOW_CANCEL_MS));
            }
        }));
    });
    return app;
}

describe('a consumer cancel owns the request settle', () =>
{
    it('runs cleanups AFTER the source finished unwinding, not while it still is', async () =>
    {
        const run = await cancelDuringPull(rig(), '/live');

        expect(run.cleanupAt).toBeGreaterThanOrEqual(0);
        expect(run.cancelEndAt).toBeGreaterThanOrEqual(SLOW_CANCEL_MS);
        // The assertion that bites: teardown must not precede the source's own cancel. Before
        // the latch this was cleanup at ~1ms against a cancel ending at ~201ms.
        expect(run.cleanupAt).toBeGreaterThanOrEqual(run.cancelEndAt);
        expect(run.events).toEqual(['source-cancel-start', 'source-cancel-end', 'cleanup']);
    });

    it('CONTROL: a stream that ENDS normally still settles from the pull, immediately', async () =>
    {
        // The latch must not disturb the ordinary path, where the pull is the correct settler
        // and there is no cancel at all.
        let cleanupRan = false;
        let closed = false;
        const app = new App();
        app.get('/short', () =>
        {
            onWorkUnitCleanup(() =>
            {
                cleanupRan = true;
            });
            let sent = false;
            return new Response(new ReadableStream<Uint8Array>({
                pull(controller)
                {
                    if (sent)
                    {
                        closed = true;
                        controller.close();
                        return;
                    }
                    sent = true;
                    controller.enqueue(new TextEncoder().encode('done'));
                }
            }));
        });

        const response = await app.handle(new Request('http://local/short'));
        expect(await response.text()).toBe('done');
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(closed).toBe(true);
        expect(cleanupRan).toBe(true);
    });

    it('a source whose own cancel() REJECTS still gets its request torn down', async () =>
    {
        // Ordinary code: a rollback that failed, a pool release that threw. Before the finally,
        // that rejection skipped runCleanups entirely and every onWorkUnitCleanup - the pooled
        // connection, the transaction, the advisory lock - leaked for the process lifetime.
        let cleanupRan = false;
        const app = new App();
        app.get('/live', () =>
        {
            onWorkUnitCleanup(() =>
            {
                cleanupRan = true;
            });
            return new Response(new ReadableStream<Uint8Array>({
                pull(controller)
                {
                    controller.enqueue(new TextEncoder().encode('x'));
                },
                cancel()
                {
                    throw new Error('rollback failed');
                }
            }));
        });

        const response = await app.handle(new Request('http://local/live'));
        const reader = response.body!.getReader();
        await reader.read();
        // The rejection still reaches whoever cancelled - it is not swallowed, only prevented
        // from taking the teardown with it.
        await expect(reader.cancel()).rejects.toThrow('rollback failed');
        await new Promise((resolve) => setTimeout(resolve, 60));

        expect(cleanupRan).toBe(true);
    });

    it('CONTROL: a genuine PRODUCER failure still errors the consumer and settles', async () =>
    {
        // The latch must not swallow a real fault - only a cancel-driven wake.
        let cleanupRan = false;
        const app = new App();
        app.get('/broken', () =>
        {
            onWorkUnitCleanup(() =>
            {
                cleanupRan = true;
            });
            let sent = false;
            return new Response(new ReadableStream<Uint8Array>({
                pull(controller)
                {
                    if (sent)
                    {
                        throw new Error('upstream died mid-stream');
                    }
                    sent = true;
                    controller.enqueue(new TextEncoder().encode('first'));
                }
            }));
        });

        const response = await app.handle(new Request('http://local/broken'));
        await expect(response.text()).rejects.toThrow('upstream died mid-stream');
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(cleanupRan).toBe(true);
    });
});

// -----------------------------------------------------------------------------------------
// The arms above drive app.handle() with NO socket, which is exactly why they could not see
// the following. Over a real socket the client's disconnect ALSO aborts request.signal, and the
// request root's abort-as-settle listener runs teardown directly - beating the cancel branch it
// is supposed to defer to. This arm exists so that axis is measured rather than assumed, and it
// pins the CURRENT behaviour as a KNOWN GAP: when the abort listener learns to wait for an
// in-flight source cancel, this assertion flips and the comment goes with it.
describe('the same question over a REAL socket', () =>
{
    it('KNOWN GAP: an abort still settles the root ahead of the source unwinding', async () =>
    {
        const { serve } = await import('./support/serve.ts');
        const { connect } = await import('node:net');

        const marks: Array<[string, number]> = [];
        let t0 = 0;
        const app = new App();
        app.get('/live', () =>
        {
            onWorkUnitCleanup(() => void marks.push(['cleanup', Date.now() - t0]));
            return new Response(new ReadableStream<Uint8Array>({
                start(controller)
                {
                    controller.enqueue(new TextEncoder().encode('open\n'));
                },
                pull(controller)
                {
                    // Keeps producing, so the adapter's loop notices the dead socket and
                    // cancels - the path where the cancel branch actually runs.
                    controller.enqueue(new TextEncoder().encode('x'.repeat(64)));
                },
                cancel()
                {
                    return new Promise<void>((resolve) => setTimeout(() =>
                    {
                        marks.push(['source-cancel-end', Date.now() - t0]);
                        resolve();
                    }, SLOW_CANCEL_MS));
                }
            }), { headers: { 'content-type': 'text/plain' } });
        });

        const served = await serve(app, { port: 0 });
        try
        {
            await new Promise<void>((resolve) =>
            {
                const socket = connect(served.port, '127.0.0.1', () =>
                    socket.write('GET /live HTTP/1.1\r\nHost: local\r\nConnection: close\r\n\r\n'));
                socket.on('data', () =>
                {
                    t0 = Date.now();
                    setTimeout(() =>
                    {
                        socket.resetAndDestroy();
                        resolve();
                    }, 10);
                });
                socket.on('error', () => resolve());
            });
            await new Promise((resolve) => setTimeout(resolve, SLOW_CANCEL_MS + 300));
        }
        finally
        {
            await served.shutdown({ gracePeriodMs: 500 });
        }

        const cleanupAt = marks.find((mark) => mark[0] === 'cleanup')?.[1] ?? -1;
        const cancelEndAt = marks.find((mark) => mark[0] === 'source-cancel-end')?.[1] ?? -1;
        expect(cleanupAt).toBeGreaterThanOrEqual(0);
        expect(cancelEndAt).toBeGreaterThanOrEqual(SLOW_CANCEL_MS);
        // The gap, asserted so it cannot regress further and so the eventual fix has a target:
        // teardown currently precedes the source finishing.
        expect(cleanupAt).toBeLessThan(cancelEndAt);
    });
});
