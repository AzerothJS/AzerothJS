// @vitest-environment node
//
// The full connection over real sockets, against TWO independent clients:
//
//   - Node's BUILT-IN WebSocket (undici) - a foreign implementation, so passing echo,
//     server-push, binary, and the close handshake against it is genuine interop, not this
//     package agreeing with itself;
//   - a raw net.Socket speaking hand-crafted frames through our own client-role serializer,
//     for what a compliant client will never send: fragmentation with interleaved pings,
//     unmasked frames, invalid UTF-8 - the protocol-violation matrix with its close codes.

import { describe, it, expect, vi } from 'vitest';
import { connect } from 'node:net';
import { once } from 'node:events';
import { App, serve, text as textResponse, type Served } from '@azerothjs/http';
import { attachWebSockets, serializeFrame, FrameParser, OPCODE, closePayload, type ServerSocket } from '@azerothjs/ws';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

async function withServer(
    onConnection: (socket: ServerSocket) => void,
    run: (port: number, served: Served) => Promise<void>
): Promise<void>
{
    const app = new App();
    app.get('/health', () => textResponse('ok'));
    const served = await serve(app);
    const detach = attachWebSockets(served.server as Parameters<typeof attachWebSockets>[0], {
        path: '/ws',
        onConnection
    });
    try
    {
        await run(served.port, served);
    }
    finally
    {
        detach();
        await served.shutdown({ gracePeriodMs: 500 });
    }
}

describe('interop with Node\'s built-in WebSocket client (undici)', () =>
{
    it('echoes text and binary, and pushes server-initiated messages', async () =>
    {
        await withServer(
            (socket) =>
            {
                socket.send('welcome');
                socket.onMessage = (data) => socket.send(data); // echo
            },
            async (port) =>
            {
                const client = new WebSocket(`ws://127.0.0.1:${ port }/ws`);
                client.binaryType = 'arraybuffer';
                const received: Array<string | number[]> = [];
                client.addEventListener('message', (event) =>
                {
                    received.push(typeof event.data === 'string' ? event.data : [...new Uint8Array(event.data as ArrayBuffer)]);
                });
                await once(client, 'open');
                client.send('hello');
                client.send(new Uint8Array([1, 2, 250]));
                await vi.waitFor(() => expect(received).toHaveLength(3));
                expect(received[0]).toBe('welcome');       // server push
                expect(received[1]).toBe('hello');         // text echo
                expect(received[2]).toEqual([1, 2, 250]);  // binary echo, bytes intact
                client.close();
            }
        );
    });

    it('the closing handshake carries code and reason in both directions', async () =>
    {
        // Server-initiated close.
        await withServer(
            (socket) => socket.close(4001, 'server says bye'),
            async (port) =>
            {
                const client = new WebSocket(`ws://127.0.0.1:${ port }/ws`);
                const closed = new Promise<{ code: number; reason: string }>((resolve) =>
                    client.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })));
                expect(await closed).toEqual({ code: 4001, reason: 'server says bye' });
            }
        );

        // Client-initiated close reaches onClose with the client's code.
        const serverSaw = vi.fn();
        await withServer(
            (socket) =>
            {
                socket.onClose = serverSaw;
            },
            async (port) =>
            {
                const client = new WebSocket(`ws://127.0.0.1:${ port }/ws`);
                await once(client, 'open');
                client.close(4002, 'client leaving');
                await vi.waitFor(() => expect(serverSaw).toHaveBeenCalledWith(4002, 'client leaving'));
            }
        );
    });

    it('a wrong path is refused with plain HTTP (no half-upgrade)', async () =>
    {
        await withServer(
            () => undefined,
            async (port) =>
            {
                const client = new WebSocket(`ws://127.0.0.1:${ port }/elsewhere`);
                const failed = new Promise((resolve) => client.addEventListener('error', resolve));
                await failed; // the client sees a failed connection, never an open socket
            }
        );
    });
});

describe('the raw-socket protocol matrix', () =>
{
    /** Performs the HTTP handshake on a raw socket, then hands the socket over. */
    async function rawClient(port: number): Promise<{ socket: ReturnType<typeof connect>; frames: () => Promise<{ opcode: number; payload: Uint8Array }> }>
    {
        const socket = connect(port, '127.0.0.1');
        await once(socket, 'connect');
        socket.write('GET /ws HTTP/1.1\r\nHost: local\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
            + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');

        // Split the handshake response from any frames that follow it.
        const parser = new FrameParser({ role: 'client' });
        const queue: Array<{ opcode: number; payload: Uint8Array }> = [];
        const waiters: Array<(frame: { opcode: number; payload: Uint8Array }) => void> = [];
        let headerDone = false;
        let headerBuffer = Buffer.alloc(0);
        socket.on('data', (chunk: Buffer) =>
        {
            let payload = chunk;
            if (!headerDone)
            {
                headerBuffer = Buffer.concat([headerBuffer, chunk]);
                const end = headerBuffer.indexOf('\r\n\r\n');
                if (end === -1)
                {
                    return;
                }
                headerDone = true;
                payload = headerBuffer.subarray(end + 4);
            }
            for (const frame of parser.push(payload))
            {
                const waiter = waiters.shift();
                if (waiter !== undefined)
                {
                    waiter(frame);
                }
                else
                {
                    queue.push(frame);
                }
            }
        });
        const frames = (): Promise<{ opcode: number; payload: Uint8Array }> =>
        {
            const queued = queue.shift();
            if (queued !== undefined)
            {
                return Promise.resolve(queued);
            }
            return new Promise((resolve) => waiters.push(resolve));
        };
        return { socket, frames };
    }

    it('a fragmented text message with an interleaved ping assembles into one delivery', async () =>
    {
        const messages: Array<string | Uint8Array> = [];
        await withServer(
            (socket) =>
            {
                socket.onMessage = (data) => messages.push(data);
            },
            async (port) =>
            {
                const { socket, frames } = await rawClient(port);
                socket.write(serializeFrame(OPCODE.text, encode('hel'), { mask: true, fin: false }));
                socket.write(serializeFrame(OPCODE.ping, encode('probe'), { mask: true }));
                socket.write(serializeFrame(OPCODE.continuation, encode('lo, '), { mask: true, fin: false }));
                socket.write(serializeFrame(OPCODE.continuation, encode('world'), { mask: true }));

                const pong = await frames();
                expect(pong.opcode).toBe(OPCODE.pong);
                expect(new TextDecoder().decode(pong.payload)).toBe('probe'); // same payload back
                await vi.waitFor(() => expect(messages).toEqual(['hello, world']));
                socket.destroy();
            }
        );
    });

    async function expectCloseCode(
        port: number,
        violate: (socket: ReturnType<typeof connect>) => void,
        expected: number
    ): Promise<void>
    {
        const { socket, frames } = await rawClient(port);
        violate(socket);
        const close = await frames();
        expect(close.opcode).toBe(OPCODE.close);
        expect(((close.payload[0] ?? 0) << 8) | (close.payload[1] ?? 0)).toBe(expected);
        socket.destroy();
    }

    it('an unmasked client frame dies with 1002', async () =>
    {
        await withServer(() => undefined, async (port) =>
        {
            await expectCloseCode(port, (socket) =>
                void socket.write(serializeFrame(OPCODE.text, encode('bare'))), 1002);
        });
    });

    it('invalid UTF-8 in a text message dies with 1007 - detected mid-stream', async () =>
    {
        await withServer(() => undefined, async (port) =>
        {
            await expectCloseCode(port, (socket) =>
            {
                socket.write(serializeFrame(OPCODE.text, new Uint8Array([0xff, 0xfe]), { mask: true, fin: false }));
                // The violation is already on the wire; no closing fragment needed.
            }, 1007);
        });
    });

    it('a continuation without an open message dies with 1002', async () =>
    {
        await withServer(() => undefined, async (port) =>
        {
            await expectCloseCode(port, (socket) =>
                void socket.write(serializeFrame(OPCODE.continuation, encode('orphan'), { mask: true })), 1002);
        });
    });

    it('a new data frame during fragmentation dies with 1002', async () =>
    {
        await withServer(() => undefined, async (port) =>
        {
            await expectCloseCode(port, (socket) =>
            {
                socket.write(serializeFrame(OPCODE.text, encode('open'), { mask: true, fin: false }));
                socket.write(serializeFrame(OPCODE.text, encode('barge-in'), { mask: true }));
            }, 1002);
        });
    });

    it('an oversized assembled message dies with 1009', async () =>
    {
        const app = new App();
        const served = await serve(app);
        const detach = attachWebSockets(served.server as Parameters<typeof attachWebSockets>[0], {
            path: '/ws',
            maxMessage: 64,
            onConnection: () => undefined
        });
        try
        {
            await expectCloseCode(served.port, (socket) =>
                void socket.write(serializeFrame(OPCODE.binary, new Uint8Array(128), { mask: true })), 1009);
        }
        finally
        {
            detach();
            await served.shutdown({ gracePeriodMs: 500 });
        }
    });

    it('a wire-invalid close code from the peer dies with 1002', async () =>
    {
        await withServer(() => undefined, async (port) =>
        {
            const { socket, frames } = await rawClient(port);
            // 1006 must never appear on the wire; hand-craft it (closePayload would refuse? it
            // does not validate on WRITE - validation is the receiver's job per the RFC).
            socket.write(serializeFrame(OPCODE.close, closePayload(1006, ''), { mask: true }));
            const close = await frames();
            expect(((close.payload[0] ?? 0) << 8) | (close.payload[1] ?? 0)).toBe(1002);
            socket.destroy();
        });
    });
});
