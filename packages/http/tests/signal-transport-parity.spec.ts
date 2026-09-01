// @vitest-environment node
//
// `request.signal` must mean "the client went away", on both transports.
//
// On h2 `incoming.socket` is a PER-STREAM proxy rather than the connection, so its `close`
// fires on a normal end exactly as on a reset - and every completed h2c request therefore
// reported that its client had hung up. That value is load-bearing in four places now
// (`clientGone`, the log de-escalation, the stream-fault exclusions, and SSE's abort-to-end),
// so a lie there is expensive.
//
// The arms read the signal AFTER the response settles, which is the only place the defect is
// observable and precisely what user cleanup code does.
import { connect as connectH2, constants } from 'node:http2';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../src/app.ts';
import { text } from '../src/respond.ts';
import { serve, serveH2c, type Served } from './support/serve.ts';

const openServers: Array<Served<never>> = [];

afterEach(async () =>
{
    while (openServers.length > 0)
    {
        await openServers.pop()?.shutdown({ gracePeriodMs: 500 });
    }
});

interface Reading
{
    duringRequest: boolean;
    afterSettled: boolean;
}

/** `text()` is a PayloadResponse, so the kernel does not take the streaming path for it. */
function readingApp(reading: Reading): App
{
    const app = new App();
    app.get('/x', (context) =>
    {
        reading.duringRequest = context.request.signal.aborted;
        setTimeout(() =>
        {
            reading.afterSettled = context.request.signal.aborted;
        }, 120);
        return text('hello');
    });
    return app;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 260));

describe('a request that COMPLETED is never reported as aborted', () =>
{
    it('h2c: the transport whose stream close used to look like a disconnect', async () =>
    {
        const reading: Reading = { duringRequest: true, afterSettled: true };
        const served = await serveH2c(readingApp(reading), { port: 0 });
        openServers.push(served as unknown as Served<never>);

        const client = connectH2(`http://127.0.0.1:${ served.port }`);
        try
        {
            await new Promise<void>((resolve) =>
            {
                const request = client.request({ ':path': '/x' });
                request.on('data', () => undefined);
                request.on('end', () => resolve());
                request.on('error', () => resolve());
                request.end();
            });
            await settle();
        }
        finally
        {
            client.destroy();
        }

        expect(reading.duringRequest).toBe(false);
        expect(reading.afterSettled).toBe(false);
    });

    it('CONTROL: http1 was always right, and stays untouched', async () =>
    {
        const reading: Reading = { duringRequest: true, afterSettled: true };
        const served = await serve(readingApp(reading), { port: 0 });
        openServers.push(served as unknown as Served<never>);

        await (await fetch(`http://127.0.0.1:${ served.port }/x`)).text();
        await settle();

        expect(reading.duringRequest).toBe(false);
        expect(reading.afterSettled).toBe(false);
    });
});

describe('a client that really does go away still aborts', () =>
{
    it('h2c: a reset DURING the response - the abort that must not be lost', async () =>
    {
        // The regression that would matter most. Losing this re-opens the leak where an h2c
        // disconnect never settled its request root at all.
        let abortedAt = -1;
        const started = Date.now();
        const app = new App();
        app.get('/live', (context) =>
        {
            context.request.signal.addEventListener('abort', () =>
            {
                abortedAt = Date.now() - started;
            });
            return new Response(new ReadableStream<Uint8Array>({
                start(controller)
                {
                    controller.enqueue(new TextEncoder().encode('open\n'));
                },
                pull(controller)
                {
                    controller.enqueue(new TextEncoder().encode('x'.repeat(4096)));
                }
            }), { headers: { 'content-type': 'text/plain' } });
        });
        const served = await serveH2c(app, { port: 0 });
        openServers.push(served as unknown as Served<never>);

        const client = connectH2(`http://127.0.0.1:${ served.port }`);
        try
        {
            await new Promise<void>((resolve) =>
            {
                const request = client.request({ ':path': '/live' });
                let seen = false;
                request.on('data', () =>
                {
                    if (seen)
                    {
                        return;
                    }
                    seen = true;
                    request.close(constants.NGHTTP2_NO_ERROR);
                    resolve();
                });
                request.on('error', () => resolve());
                request.end();
            });
            await settle();
        }
        finally
        {
            client.destroy();
        }

        expect(abortedAt).toBeGreaterThanOrEqual(0);
    });
});
