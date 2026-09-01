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

// A response can finish while its request body is still arriving - any handler that answers
// without reading the body, an over-limit refusal being the obvious one. Node stops policing the
// connection at that point, so nothing bounded what followed: a peer that had ALREADY been refused
// held its socket for as long as it dribbled, one byte every 200ms, measured with requestTimeout
// at 2s and the sweep at 250ms. That is a post-response slowloris.
//
// The upload cannot be stopped at the refusal without LOSING the refusal - closing a socket that
// still holds unread data forces a TCP RST which discards the queued response, measured the same
// for socket.end(), req.destroy(), socket.destroy() and a byte-capped lingering close. So the
// bound is on TIME, and these arms pin both halves: the dribbler is cut, and everyone else is not.
describe('an abandoned request body cannot hold the connection forever', () =>
{
    const CRLF = String.fromCharCode(13, 10);

    function refusingApp(): App
    {
        const app = new App({ onError: () => undefined });
        app.post('/upload', async (context) =>
        {
            await readText(context.request, { limit: 64 });
            return new Response('ok');
        });
        app.get('/ping', () => new Response('pong'));
        return app;
    }

    it('cuts a peer still dribbling an abandoned body past the deadline, AFTER delivering the refusal', async () =>
    {
        const served = await serve(refusingApp(), { port: 0, timeouts: { requestMs: 600, checkIntervalMs: 100 } });
        openServers.push(served as unknown as Served<never>);

        const socket = connectTcp(served.port, '127.0.0.1');
        await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
        let response = '';
        // A holder, not a let: assigned only inside a callback, TypeScript narrows a let to its
        // initial type and the loop guard below becomes a constant.
        const closed: { at: number | null } = { at: null };
        const started = Date.now();
        socket.on('data', (buffer: Buffer) =>
        {
            response += buffer.toString('latin1');
        });
        socket.on('close', () =>
        {
            closed.at = Date.now() - started;
        });
        socket.on('error', () => undefined);

        socket.write(`POST /upload HTTP/1.1${ CRLF }Host: local${ CRLF }Content-Length: 67108864${ CRLF }${ CRLF }`);
        for (let i = 0; i < 15 && closed.at === null; i++)
        {
            socket.write('a');
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // The refusal is delivered - bounding the drain must not cost the client its answer.
        expect(response).toContain('413');
        // And the socket is reclaimed rather than held for as long as the peer cares to dribble.
        expect(closed.at).not.toBeNull();
        socket.destroy();
    });

    it('CONTROL: an ordinary keep-alive request is never cut, and the connection is reused', async () =>
    {
        const served = await serve(refusingApp(), { port: 0, timeouts: { requestMs: 600, checkIntervalMs: 100 } });
        openServers.push(served as unknown as Served<never>);

        const socket = connectTcp(served.port, '127.0.0.1');
        await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
        let response = '';
        socket.on('data', (buffer: Buffer) =>
        {
            response += buffer.toString('latin1');
        });
        socket.on('error', () => undefined);

        socket.write(`GET /ping HTTP/1.1${ CRLF }Host: local${ CRLF }${ CRLF }`);
        await new Promise((resolve) => setTimeout(resolve, 900));   // well past the deadline
        socket.write(`GET /ping HTTP/1.1${ CRLF }Host: local${ CRLF }${ CRLF }`);
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Two answers on ONE socket: the deadline never armed for a request that had no
        // unfinished body, so ordinary keep-alive traffic is untouched.
        expect(response.split('pong').length - 1).toBe(2);
        socket.destroy();
    });

    it('CONTROL: a body the handler READS leaves the connection usable', async () =>
    {
        const served = await serve(refusingApp(), { port: 0, timeouts: { requestMs: 600, checkIntervalMs: 100 } });
        openServers.push(served as unknown as Served<never>);

        const socket = connectTcp(served.port, '127.0.0.1');
        await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
        let response = '';
        socket.on('data', (buffer: Buffer) =>
        {
            response += buffer.toString('latin1');
        });
        socket.on('error', () => undefined);

        socket.write(`POST /upload HTTP/1.1${ CRLF }Host: local${ CRLF }Content-Length: 5${ CRLF }${ CRLF }hello`);
        await new Promise((resolve) => setTimeout(resolve, 900));
        socket.write(`GET /ping HTTP/1.1${ CRLF }Host: local${ CRLF }${ CRLF }`);
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(response).toContain('pong');
        socket.destroy();
    });
});
