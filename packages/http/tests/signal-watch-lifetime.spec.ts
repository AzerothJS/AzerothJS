// @vitest-environment node
//
// The client-disconnect watch must be released when the RESPONSE closes - not when the request
// does, and not never.
//
// On http1 a fully consumed IncomingMessage closes at the END OF ITS BODY, long before a
// streaming response finishes. Hanging the detach on the request's own close was therefore wrong
// in both directions: registered after that close it never fires at all, so a keep-alive
// connection accumulates one socket listener, one AbortController and one live closure per
// request it serves. Measured before the fix: 32 listeners over 30 requests on ONE socket, with
// a MaxListenersExceededWarning at the eleventh.
//
// Only a real socket shows this - app.handle() has no connection to accumulate on - so these
// arms drive one raw keep-alive connection and count listeners on the server's own socket.
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../src/app.ts';
import { readText } from '../src/body.ts';
import { serve, type Served } from '../src/adapter-node.ts';

const open: Array<Served<never>> = [];

afterEach(async () =>
{
    while (open.length > 0)
    {
        await open.pop()?.shutdown({ gracePeriodMs: 500 });
    }
});

/** Reads the body then answers, which is the shape whose incoming closes early. */
function bodyReadingApp(fail: boolean): App
{
    const app = new App({ onError: () => undefined });
    app.post('/x', async (context) =>
    {
        await readText(context.request, { limit: 1024 });
        if (fail)
        {
            throw new Error('boom');
        }
        return new Response('ok');
    });
    return app;
}

// Built from codepoints, not escapes: a CRLF written as a backslash sequence is exactly
// what a heredoc or an editor silently turns into a bare LF, and an HTTP request framed
// with LF stalls the parser rather than failing loudly.
const CRLF = String.fromCharCode(13, 10);

async function drive(app: App, requests: number): Promise<number>
{
    const served = await serve(app, { port: 0 });
    open.push(served as unknown as Served<never>);

    // A holder, because narrowing would otherwise decide this can only ever be null.
    const found: { socket: Socket | null } = { socket: null };
    served.server.on('connection', (socket: Socket) =>
    {
        found.socket ??= socket;
    });

    const client = connect(served.port, '127.0.0.1');
    await new Promise((resolve) => client.once('connect', resolve));

    let received = '';
    client.on('data', (chunk: Buffer) =>
    {
        received += chunk.toString('latin1');
    });
    const responsesSeen = (): number => received.split('HTTP/1.1 ').length - 1;

    const body = 'hello';
    const request = [
        'POST /x HTTP/1.1',
        'Host: local',
        `Content-Length: ${ body.length }`,
        'Connection: keep-alive',
        '',
        body
    ].join(CRLF);

    for (let i = 0; i < requests; i++)
    {
        const before = responsesSeen();
        client.write(request);
        const deadline = Date.now() + 3000;
        while (responsesSeen() === before && Date.now() < deadline)
        {
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
    }

    const count = found.socket === null ? -1 : found.socket.listenerCount('close');
    client.destroy();
    return count;
}

describe('the disconnect watch does not accumulate on a keep-alive connection', () =>
{
    it('stays flat across many failing requests that consumed their body', async () =>
    {
        // The 5xx path reads the signal through clientGone, which is what installs the watch.
        const count = await drive(bodyReadingApp(true), 25);
        expect(count).toBeGreaterThanOrEqual(0);
        expect(count).toBeLessThan(6);
    }, 30_000);

    it('stays flat across many SUCCEEDING requests too - it was never 5xx-specific', async () =>
    {
        // A plain `new Response(body)` counts as streaming, so the request root reads the
        // signal here as well. Filing this as an error-path defect would have been wrong.
        const count = await drive(bodyReadingApp(false), 25);
        expect(count).toBeGreaterThanOrEqual(0);
        expect(count).toBeLessThan(6);
    }, 30_000);

    it('CONTROL: releasing the watch does not stop a real disconnect from aborting', async () =>
    {
        // The watch exists for this. A fix that merely stopped the leak by never watching
        // would pass the arms above and silently break every handler that awaits the signal.
        let abortedAt = -1;
        const started = { at: 0 };
        const app = new App();
        app.post('/live', async (context) =>
        {
            await readText(context.request, { limit: 1024 });
            context.request.signal.addEventListener('abort', () =>
            {
                abortedAt = Date.now() - started.at;
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

        const served = await serve(app, { port: 0 });
        open.push(served as unknown as Served<never>);

        await new Promise<void>((resolve) =>
        {
            const socket = connect(served.port, '127.0.0.1', () =>
            {
                const body = 'hello';
                socket.write(`POST /live HTTP/1.1\r\nHost: local\r\nContent-Length: ${ body.length }\r\n\r\n${ body }`);
            });
            socket.on('data', () =>
            {
                started.at ||= Date.now();
                setTimeout(() =>
                {
                    socket.resetAndDestroy();
                    resolve();
                }, 30);
            });
            socket.on('error', () => resolve());
            setTimeout(resolve, 2000);
        });
        await new Promise((resolve) => setTimeout(resolve, 400));

        expect(abortedAt).toBeGreaterThanOrEqual(0);
    }, 30_000);
});
