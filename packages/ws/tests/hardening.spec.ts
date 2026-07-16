// @vitest-environment node
//
// Production hardening for the WebSocket server: origin gating before the upgrade, the
// heartbeat that reclaims half-open connections, and send-side backpressure.

import { describe, it, expect, vi } from 'vitest';
import { connect } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { App, serve } from '@azerothjs/http';
import { attachWebSockets, ServerSocket } from '@azerothjs/ws';

/** The bytes of a valid RFC 6455 opening handshake, with an optional Origin. */
function handshake(path: string, origin?: string): string
{
    return `GET ${ path } HTTP/1.1\r\nHost: local\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
        + (origin !== undefined ? `Origin: ${ origin }\r\n` : '')
        + '\r\n';
}

/** Connects, sends a handshake, and reads the first response line's status code. */
async function requestStatus(port: number, request: string): Promise<{ socket: ReturnType<typeof connect>; status: number }>
{
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(request);
    const [chunk] = await once(socket, 'data') as [Buffer];
    return { socket, status: Number(chunk.toString('latin1').split(' ')[1]) };
}

describe('verifyOrigin', () =>
{
    it('refuses a disallowed origin with 403 and upgrades an allowed one', async () =>
    {
        const served = await serve(new App());
        const detach = attachWebSockets(served.server as Parameters<typeof attachWebSockets>[0], {
            path: '/ws',
            verifyOrigin: (origin) => origin === 'https://trusted.example',
            onConnection: () => undefined
        });
        try
        {
            const bad = await requestStatus(served.port, handshake('/ws', 'https://evil.example'));
            expect(bad.status).toBe(403);
            bad.socket.destroy();

            const good = await requestStatus(served.port, handshake('/ws', 'https://trusted.example'));
            expect(good.status).toBe(101);
            good.socket.destroy();
        }
        finally
        {
            detach();
            await served.shutdown({ gracePeriodMs: 300 });
        }
    });
});

describe('heartbeat', () =>
{
    it('terminates a peer that stops answering pings', async () =>
    {
        const served = await serve(new App());
        let closeInfo: { code: number; reason: string } | undefined;
        const detach = attachWebSockets(served.server as Parameters<typeof attachWebSockets>[0], {
            path: '/ws',
            heartbeatMs: 40,
            pongTimeoutMs: 40,
            onConnection: (socket) =>
            {
                socket.onClose = (code, reason) =>
                {
                    closeInfo = { code, reason };
                };
            }
        });
        try
        {
            const socket = connect(served.port, '127.0.0.1');
            await once(socket, 'connect');
            socket.write(handshake('/ws'));
            socket.on('data', () => undefined); // consume the handshake + pings, but never pong

            await vi.waitFor(() => expect(closeInfo).toEqual({ code: 1006, reason: 'Heartbeat timeout' }), { timeout: 2000 });
            socket.destroy();
        }
        finally
        {
            detach();
            await served.shutdown({ gracePeriodMs: 300 });
        }
    });

    it('keeps a live peer (which auto-pongs) open across several heartbeats', async () =>
    {
        const served = await serve(new App());
        const closed = vi.fn();
        const detach = attachWebSockets(served.server as Parameters<typeof attachWebSockets>[0], {
            path: '/ws',
            heartbeatMs: 40,
            pongTimeoutMs: 60,
            onConnection: (socket) =>
            {
                socket.onClose = closed;
            }
        });
        let client: WebSocket | undefined;
        try
        {
            client = new WebSocket(`ws://127.0.0.1:${ served.port }/ws`);
            await once(client, 'open');
            await new Promise((resolve) => setTimeout(resolve, 250)); // ~6 heartbeats
            expect(closed).not.toHaveBeenCalled();
            expect(client.readyState).toBe(WebSocket.OPEN);
        }
        finally
        {
            client?.close();
            detach();
            await served.shutdown({ gracePeriodMs: 300 });
        }
    });
});

describe('send backpressure', () =>
{
    /** A minimal net.Socket stand-in whose writability we drive by hand. */
    class FakeSocket extends EventEmitter
    {
        public writableLength = 0;

        public writableNeedDrain = false;

        public full = false;

        public setNoDelay(): void
        { /* no-op */ }

        public end(): void
        { /* no-op */ }

        public destroy(): void
        { /* no-op */ }

        public write(chunk: Uint8Array): boolean
        {
            this.writableLength += chunk.byteLength;
            return !this.full;
        }
    }

    it('send reports a full buffer and drain resolves when it flushes', async () =>
    {
        const fake = new FakeSocket();
        const socket = new ServerSocket(fake as unknown as import('node:net').Socket, { heartbeatMs: 0 });

        expect(socket.send('hello')).toBe(true);
        expect(socket.bufferedAmount).toBeGreaterThan(0);

        fake.full = true;
        fake.writableNeedDrain = true;
        expect(socket.send('more')).toBe(false); // backpressure surfaced to the producer

        let resolved = false;
        const drained = socket.drain().then(() =>
        {
            resolved = true;
        });
        await Promise.resolve();
        expect(resolved).toBe(false); // still buffered

        fake.writableNeedDrain = false;
        fake.emit('drain');
        await drained;
        expect(resolved).toBe(true);
    });
});
