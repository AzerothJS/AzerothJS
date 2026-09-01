// @vitest-environment node
//
// SOCKET TWINS for the streaming-teardown contracts.
//
// Every such contract in this package was pinned through `app.handle(new Request(...))`, which
// has no socket and therefore no `request.signal` abort. That blind spot shipped two defects in
// one session: a reporter that fired for every disconnected SSE slow client, and a claim that
// the cancel branch owned the settle - false the moment a real close also aborted the request.
// Both passed their socketless arms the whole time.
//
// So these drive REAL sockets, and they cover BOTH transports on purpose: h2c behaves
// differently from http1 at every point measured during that investigation, and the suite had no
// h2c streaming-disconnect coverage at all.
import { connect as connectH2 } from 'node:http2';
import { connect as connectTcp } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../src/app.ts';
import { onWorkUnitCleanup } from '../src/request-root.ts';
import { serve, serveH2c, type Served } from './support/serve.ts';

const open: Array<Served<never>> = [];

afterEach(async () =>
{
    while (open.length > 0)
    {
        await open.pop()?.shutdown({ gracePeriodMs: 500 });
    }
});

interface Observed
{
    streamFaults: string[];
    cleanupRan: boolean;
}

/** A route that streams forever, so a disconnect is the only way it ends. */
function endlessApp(observed: Observed): App
{
    const app = new App({
        onStreamError: (error) => void observed.streamFaults.push((error as Error).message)
    });
    app.get('/live', () =>
    {
        onWorkUnitCleanup(() =>
        {
            observed.cleanupRan = true;
        });
        return new Response(new ReadableStream<Uint8Array>({
            start(controller)
            {
                controller.enqueue(new TextEncoder().encode('open\n'));
            },
            pull(controller)
            {
                controller.enqueue(new TextEncoder().encode('x'.repeat(64)));
            }
        }), { headers: { 'content-type': 'text/plain' } });
    });
    return app;
}

const settle = (ms = 300): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('a real HTTP/1.1 client that disconnects mid-stream', () =>
{
    it('is not a server fault, and still tears the request down', async () =>
    {
        const observed: Observed = { streamFaults: [], cleanupRan: false };
        const served = await serve(endlessApp(observed), { port: 0 });
        open.push(served as unknown as Served<never>);

        await new Promise<void>((resolve) =>
        {
            const socket = connectTcp(served.port, '127.0.0.1', () =>
                socket.write('GET /live HTTP/1.1\r\nHost: local\r\nConnection: close\r\n\r\n'));
            socket.on('data', () =>
            {
                // Bytes are flowing; vanish the way a real client does.
                socket.resetAndDestroy();
                resolve();
            });
            socket.on('error', () => resolve());
        });
        await settle();

        // The defect that shipped: a disconnect reported as a server stream fault.
        expect(observed.streamFaults).toEqual([]);
        // And the request must not leak just because nobody read the end of it.
        expect(observed.cleanupRan).toBe(true);
    });
});

describe('a real h2c client that cancels its stream mid-body', () =>
{
    it('is not a server fault, and still tears the request down', async () =>
    {
        // h2c differed from http1 at every point measured in this area, and had no coverage.
        const observed: Observed = { streamFaults: [], cleanupRan: false };
        const served = await serveH2c(endlessApp(observed), { port: 0 });
        open.push(served as unknown as Served<never>);

        const client = connectH2(`http://127.0.0.1:${ served.port }`);
        try
        {
            await new Promise<void>((resolve, reject) =>
            {
                const request = client.request({ ':path': '/live' });
                request.on('data', () =>
                {
                    // RST_STREAM: the h2 equivalent of hanging up.
                    request.close();
                    resolve();
                });
                request.on('error', () => resolve());
                client.on('error', reject);
                request.end();
            });
            await settle();
        }
        finally
        {
            client.close();
        }

        expect(observed.streamFaults).toEqual([]);
        expect(observed.cleanupRan).toBe(true);
    });
});
