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
import { readRaw, readText } from '../src/body.ts';
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

// A body short of its DECLARED Content-Length is a truncated message, and handing it to a handler
// as a successful read is silent wrong data - the handler acts on a partial upload believing it is
// whole. Completeness used to be inferred from Node emitting 'aborted', which varies by transport
// AND by Node version: an h2c STREAM RESET was measured pushing EOF with no 'aborted' at all
// (resolving 16384 of 100000 bytes) while a session destroy on the same transport rejected. This
// package supports node >=22, so that made a data-integrity guarantee depend on the runtime.
//
// The declared length is now VERIFIED. These arms pin the invariant on both transports; removing
// the 'aborted' listener entirely leaves them green, which is the point - the check, not the
// platform event, is what closes it.
describe('a body short of its declared length is refused', () =>
{
    const DECLARED = 100000;
    const SENT = 16384;

    function recordingApp(seen: string[]): App
    {
        const app = new App({ onError: () => undefined });
        app.post('/upload', async (context) =>
        {
            try
            {
                const body = await readRaw(context.request, { limit: 10_000_000 });
                seen.push(`RESOLVED:${ body.byteLength }`);
            }
            catch (error)
            {
                seen.push(`REJECTED:${ (error as Error).constructor.name }`);
            }
            return new Response('ok');
        });
        return app;
    }

    it('h2c: a STREAM RESET mid-upload is a truncated body, not a successful read', async () =>
    {
        const seen: string[] = [];
        const served = await serveH2c(recordingApp(seen), { port: 0 });
        openServers.push(served as unknown as Served<never>);

        const client = connectH2(`http://127.0.0.1:${ served.port }`);
        await new Promise<void>((resolve) => client.once('connect', () => resolve()));
        const request = client.request({ ':method': 'POST', ':path': '/upload', 'content-length': String(DECLARED) });
        request.on('error', () => undefined);
        request.write(Buffer.alloc(SENT, 0x61));
        await new Promise((resolve) => setTimeout(resolve, 80));
        request.close(8);
        await new Promise((resolve) => setTimeout(resolve, 300));
        client.destroy();

        expect(seen[0]).toBe('REJECTED:BadRequestError');
    });

    it('http1: a client that vanishes mid-upload is a truncated body', async () =>
    {
        const seen: string[] = [];
        const served = await serve(recordingApp(seen), { port: 0 });
        openServers.push(served as unknown as Served<never>);

        const socket = connectTcp(served.port, '127.0.0.1');
        await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
        const CRLF = String.fromCharCode(13, 10);
        socket.write(`POST /upload HTTP/1.1${ CRLF }Host: local${ CRLF }Content-Length: ${ DECLARED }${ CRLF }${ CRLF }`);
        socket.write(Buffer.alloc(SENT, 0x61));
        await new Promise((resolve) => setTimeout(resolve, 80));
        socket.destroy();
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(seen[0]).toBe('REJECTED:BadRequestError');
    });

    it('CONTROL: a COMPLETE body of the declared length resolves with every byte', async () =>
    {
        const seen: string[] = [];
        const served = await serveH2c(recordingApp(seen), { port: 0 });
        openServers.push(served as unknown as Served<never>);

        const client = connectH2(`http://127.0.0.1:${ served.port }`);
        await new Promise<void>((resolve) => client.once('connect', () => resolve()));
        const request = client.request({ ':method': 'POST', ':path': '/upload', 'content-length': String(SENT) });
        request.on('error', () => undefined);
        request.end(Buffer.alloc(SENT, 0x61));
        await new Promise((resolve) => setTimeout(resolve, 300));
        client.destroy();

        expect(seen[0]).toBe(`RESOLVED:${ SENT }`);
    });

    it('CONTROL: a CHUNKED body, which declares no length, still resolves', async () =>
    {
        const seen: string[] = [];
        const served = await serve(recordingApp(seen), { port: 0 });
        openServers.push(served as unknown as Served<never>);

        const socket = connectTcp(served.port, '127.0.0.1');
        await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
        const CRLF = String.fromCharCode(13, 10);
        socket.write(`POST /upload HTTP/1.1${ CRLF }Host: local${ CRLF }Transfer-Encoding: chunked${ CRLF }${ CRLF }`);
        socket.write(`5${ CRLF }hello${ CRLF }0${ CRLF }${ CRLF }`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        socket.destroy();

        expect(seen[0]).toBe('RESOLVED:5');
    });
});
