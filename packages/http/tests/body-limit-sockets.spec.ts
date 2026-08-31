// @vitest-environment node
//
// The body-limit branch had NO real-socket coverage: the existing arms stub the fast lane or
// call it by hand, so a change that removed the h2c 413 entirely would ship green. These drive
// real uploads over both transports.
//
// What is pinned here is what the SERVER records. On http1 the client receives no response at
// all either way - `destroy()` resets the connection - so the fix is about the fault the server
// names, not about what the client is told. That distinction is the whole point of the arm: a
// 413 tells an operator "this endpoint's limit did its job", while "the request body was not
// fully received" points them at a network problem that never happened.
import { connect as connectH2 } from 'node:http2';
import { connect as connectTcp } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../src/app.ts';
import { readText } from '../src/body.ts';
import { serve, serveH2c, type Served } from '../src/adapter-node.ts';

const LIMIT = 64;
const openServers: Array<Served<never>> = [];

afterEach(async () =>
{
    while (openServers.length > 0)
    {
        await openServers.pop()?.shutdown({ gracePeriodMs: 500 });
    }
});

function limitedApp(seen: string[]): App
{
    const app = new App();
    app.post('/upload', async (context) =>
    {
        try
        {
            await readText(context.request, { limit: LIMIT });
        }
        catch (error)
        {
            seen.push((error as Error).constructor.name);
            throw error;
        }
        return new Response('ok');
    });
    return app;
}

describe('an over-limit upload names the right fault', () =>
{
    it('http1: the server records PayloadTooLarge, not a broken-upload error', async () =>
    {
        const seen: string[] = [];
        const served = await serve(limitedApp(seen), { port: 0 });
        openServers.push(served as unknown as Served<never>);

        await new Promise<void>((resolve) =>
        {
            const socket = connectTcp(served.port, '127.0.0.1', () =>
            {
                socket.write('POST /upload HTTP/1.1\r\nHost: local\r\nTransfer-Encoding: chunked\r\n\r\n');
                let sent = 0;
                const timer = setInterval(() =>
                {
                    if (sent++ > 20)
                    {
                        clearInterval(timer);
                        resolve();
                        return;
                    }
                    try
                    {
                        socket.write(`20\r\n${ 'x'.repeat(32) }\r\n`);
                    }
                    catch
                    {
                        clearInterval(timer);
                        resolve();
                    }
                }, 5);
            });
            socket.on('error', () => resolve());
            setTimeout(resolve, 600);
        });
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Before the reorder this was BadRequestError, because destroy() emitted 'aborted'
        // synchronously and that listener rejected first.
        expect(seen).toEqual(['PayloadTooLargeError']);
    });

    it('h2c: same fault, and the client still receives its 413', async () =>
    {
        // The h2c client DOES get a response, which is why resetting the stream from the limit
        // path was rejected - it would have discarded this 413 entirely and silently.
        const seen: string[] = [];
        const served = await serveH2c(limitedApp(seen), { port: 0 });
        openServers.push(served as unknown as Served<never>);

        const client = connectH2(`http://127.0.0.1:${ served.port }`);
        let status: number | null = null;
        try
        {
            await new Promise<void>((resolve) =>
            {
                const request = client.request({ ':path': '/upload', ':method': 'POST' });
                request.on('response', (headers) =>
                {
                    status = headers[':status'] ?? null;
                    resolve();
                });
                request.on('error', () => resolve());
                let sent = 0;
                const timer = setInterval(() =>
                {
                    if (sent++ > 40)
                    {
                        clearInterval(timer);
                        resolve();
                        return;
                    }
                    if (!request.destroyed)
                    {
                        request.write('x'.repeat(32));
                    }
                }, 5);
                setTimeout(() =>
                {
                    clearInterval(timer);
                    resolve();
                }, 600);
            });
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        finally
        {
            client.destroy();
        }

        expect(seen).toEqual(['PayloadTooLargeError']);
        expect(status).toBe(413);
    });
});
