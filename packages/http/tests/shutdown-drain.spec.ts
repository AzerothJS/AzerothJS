// @vitest-environment node
//
// The shutdown drain, tested over REAL sockets. The defect class under pin: an upgraded
// socket leaves the http server's connection tracking, so `closeAllConnections()` cannot
// reach it and `shutdown()` used to wait on it forever. The fix destroys survivors as soon
// as in-flight HTTP work has drained, bounded by ONE `gracePeriodMs` deadline - and does
// NOTHING on h2c, where `closeAllConnections` does not exist and a destroy would silently
// truncate live streams.
//
// Not pinned here (hard to reach from a spec): a socket
// accepted during the listen retry window - guarded instead by the tracker's attach point
// sitting beside `inFlight` at the top of `manage()`, before anything can be accepted.
import { describe, it, expect } from 'vitest';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as h2connect } from 'node:http2';
import { App } from '../src/app.ts';
import { text } from '../src/respond.ts';
import { serve, serveH2c } from './support/serve.ts';

/** Opens a raw socket and completes a WebSocket-shaped upgrade against a test 101-responder. */
function upgradeSocket(port: number): Promise<Socket>
{
    return new Promise((resolve, reject) =>
    {
        const socket = netConnect(port, '127.0.0.1', () =>
        {
            socket.write(
                'GET /ws HTTP/1.1\r\n'
                + 'Host: 127.0.0.1\r\n'
                + 'Connection: Upgrade\r\n'
                + 'Upgrade: websocket\r\n'
                + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
                + 'Sec-WebSocket-Version: 13\r\n\r\n'
            );
        });
        socket.once('data', () => resolve(socket));
        socket.once('error', reject);
    });
}

/** A consumer-shaped upgrade handler: answers 101 and holds the socket, like a ws library. */
function accept101(server: import('node:http').Server): void
{
    server.on('upgrade', (_req, socket) =>
    {
        socket.on('error', () =>
        { /* the consumer owns the socket's errors */ });
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
}

describe('shutdown drains upgraded sockets', () =>
{
    it('a held upgraded socket no longer stalls shutdown, and is destroyed', async () =>
    {
        const app = new App();
        app.get('/x', () => text('ok'));
        const served = await serve(app);
        accept101(served.server);
        const socket = await upgradeSocket(served.port);
        const closedByServer = new Promise<void>((done) => socket.once('close', () => done()));

        const startedAt = Date.now();
        await served.shutdown({ gracePeriodMs: 5000 });
        // Immediate destroy: no in-flight HTTP work, so the drain must not wait the grace out.
        expect(Date.now() - startedAt).toBeLessThan(1000);
        await closedByServer;
    });

    it('five held sockets all die, still without waiting out the grace', async () =>
    {
        const app = new App();
        app.get('/x', () => text('ok'));
        const served = await serve(app);
        accept101(served.server);
        const sockets = await Promise.all(Array.from({ length: 5 }, () => upgradeSocket(served.port)));
        const allClosed = Promise.all(sockets.map((s) => new Promise<void>((done) => s.once('close', () => done()))));

        const startedAt = Date.now();
        await served.shutdown({ gracePeriodMs: 5000 });
        expect(Date.now() - startedAt).toBeLessThan(1000);
        await allClosed;
    });

    it('an in-flight response still gets its grace, alongside a held socket', async () =>
    {
        const app = new App();
        app.get('/slow', async () =>
        {
            await new Promise((r) => setTimeout(r, 400));
            return text('slow-done');
        });
        const served = await serve(app);
        accept101(served.server);
        const socket = await upgradeSocket(served.port);
        const closedByServer = new Promise<boolean>((done) =>
        {
            socket.once('close', () => done(true));
            setTimeout(() => done(false), 2000);
        });
        const pending = fetch(`http://127.0.0.1:${ served.port }/slow`).then((r) => r.text());
        await new Promise((r) => setTimeout(r, 50));

        await served.shutdown({ gracePeriodMs: 5000 });
        await expect(pending).resolves.toBe('slow-done');
        await expect(closedByServer).resolves.toBe(true);
    });

    it('gracePeriodMs: Infinity lets in-flight work finish instead of clamping to 1ms', async () =>
    {
        const warnings: string[] = [];
        const onWarning = (w: Error): void =>
        {
            warnings.push(w.name);
        };
        process.on('warning', onWarning);
        try
        {
            const app = new App();
            app.get('/slow', async () =>
            {
                await new Promise((r) => setTimeout(r, 300));
                return text('slow-done');
            });
            const served = await serve(app);
            const pending = fetch(`http://127.0.0.1:${ served.port }/slow`).then((r) => r.text());
            await new Promise((r) => setTimeout(r, 50));

            await served.shutdown({ gracePeriodMs: Infinity });
            await expect(pending).resolves.toBe('slow-done');
            expect(warnings.filter((n) => n.includes('TimeoutOverflow'))).toEqual([]);
        }
        finally
        {
            process.off('warning', onWarning);
        }
    });

    it('shutdown resolves only once the port is actually released (rebind succeeds)', async () =>
    {
        const app = new App();
        app.get('/x', () => text('ok'));
        const served = await serve(app);
        accept101(served.server);
        const { port } = served;
        await upgradeSocket(port);

        await served.shutdown({ gracePeriodMs: 1000 });
        const again = await serve(app, { port });
        expect(again.port).toBe(port);
        await again.shutdown({ gracePeriodMs: 1000 });
    });
});

describe('the tracker changes nothing for servers without an upgrade consumer', () =>
{
    it('registers no upgrade listener of its own', async () =>
    {
        const app = new App();
        app.get('/x', () => text('ok'));
        const served = await serve(app);
        try
        {
            // The load-bearing negative: an 'upgrade' listener REROUTES Upgrade-flagged
            // requests away from the request handler, which is why the tracker must not be one.
            expect(served.server.listenerCount('upgrade')).toBe(0);
        }
        finally
        {
            await served.shutdown({ gracePeriodMs: 1000 });
        }
    });

    it('a stray Upgrade request is answered as plain HTTP, and an abrupt client reset is survived', async () =>
    {
        const app = new App();
        app.get('/anything', () => text('http-ok'));
        const served = await serve(app);
        try
        {
            const answered = await new Promise<string>((resolve, reject) =>
            {
                const socket = netConnect(served.port, '127.0.0.1', () =>
                {
                    socket.write(
                        'GET /anything HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
                        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
                    );
                });
                let data = '';
                socket.on('data', (chunk) =>
                {
                    data += String(chunk);
                    socket.resetAndDestroy();
                    resolve(data.split('\r\n')[0] ?? '');
                });
                socket.on('error', reject);
            });
            expect(answered).toBe('HTTP/1.1 200 OK');

            // The reset must not have taken the process (or the server) down.
            await new Promise((r) => setTimeout(r, 100));
            const alive = await fetch(`http://127.0.0.1:${ served.port }/anything`);
            expect(alive.status).toBe(200);
        }
        finally
        {
            await served.shutdown({ gracePeriodMs: 1000 });
        }
    });
});

describe('h2c keeps its wait-for-streams drain', () =>
{
    it('a live stream is not cut: the body completes even past the grace', async () =>
    {
        const app = new App();
        app.get('/stream', () => new Response(new ReadableStream({
            async start(controller)
            {
                controller.enqueue(new TextEncoder().encode('AAAA'));
                await new Promise((r) => setTimeout(r, 600));
                controller.enqueue(new TextEncoder().encode('BBBB'));
                controller.close();
            }
        })));
        const served = await serveH2c(app);
        const client = h2connect(`http://127.0.0.1:${ served.port }`);
        const request = client.request({ ':path': '/stream' });
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) =>
        {
            body += chunk;
        });
        const ended = new Promise<void>((done) => request.on('end', () => done()));
        await new Promise((r) => setTimeout(r, 100));

        // Grace far below the stream's runtime: on HTTP/1 the survivor sweep would cut it;
        // on h2c the sweep must not run, because closeAllConnections never did.
        await served.shutdown({ gracePeriodMs: 100 });
        await ended;
        expect(body).toBe('AAAABBBB');
        expect(request.rstCode).toBe(0);
        client.destroy();
    });
});
