// The connection state machine's failure modes: two remote memory-exhaustion kills that the
// byte cap could not bound, a message delivered after the app tore its state down, a backpressure
// await that never settled, and a heartbeat that a plausible configuration silently disabled.
//
// Driven against a hand-built socket stand-in rather than a real server, so each rule is tested
// in isolation from the handshake and the frame codec.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { ServerSocket } from '../src/socket.ts';
import { OPCODE } from '../src/frames.ts';
import type { ServerSocketOptions } from '../src/socket.ts';

/** A net.Socket stand-in whose writability and lifecycle we drive by hand. */
class FakeSocket extends EventEmitter
{
    public writableLength = 0;

    public writableNeedDrain = false;

    public written: Uint8Array[] = [];

    public destroyed = false;

    public setNoDelay(): void
    { /* no-op */ }

    public end(): void
    { /* no-op */ }

    public destroy(): void
    {
        this.destroyed = true;
    }

    public write(chunk: Uint8Array): boolean
    {
        this.written.push(chunk);
        this.writableLength += chunk.byteLength;
        return true;
    }
}

/** A client-masked frame, which is the only form a server accepts. */
function clientFrame(opcode: number, payload: Uint8Array, fin = true): Buffer
{
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++)
    {
        masked[i] = (masked[i] ?? 0) ^ (mask[i % 4] ?? 0);
    }
    const header = Buffer.from([(fin ? 0x80 : 0x00) | opcode, 0x80 | masked.length]);
    return Buffer.concat([header, mask, masked]);
}

function connect(options: ServerSocketOptions = {}): { fake: FakeSocket; socket: ServerSocket }
{
    const fake = new FakeSocket();
    const socket = new ServerSocket(fake as unknown as import('node:net').Socket, { heartbeatMs: 0, ...options });
    return { fake, socket };
}

describe('fragment assembly is bounded by COUNT, not only by bytes', () =>
{
    it('an endless stream of zero-length continuations is refused instead of growing the heap', () =>
    {
        const { fake, socket } = connect({ maxMessage: 1024 });
        const closes: number[] = [];
        socket.onClose = (code): void =>
        {
            closes.push(code);
        };

        // RFC 6455 permits a zero-length fragment, so nothing here is malformed: each one adds
        // zero to the byte total, which is why the maxMessage cap could never trip.
        fake.emit('data', clientFrame(OPCODE.binary, new Uint8Array(0), false));
        for (let i = 0; i < 8000; i++)
        {
            fake.emit('data', clientFrame(OPCODE.continuation, new Uint8Array(0), false));
        }

        expect(closes).toEqual([1009]);
    });

    it('one-byte fragments are refused on the same rule, so raising maxMessage is no escape', () =>
    {
        const { fake, socket } = connect({ maxMessage: 16 * 1024 * 1024 });
        const closes: number[] = [];
        socket.onClose = (code): void =>
        {
            closes.push(code);
        };

        fake.emit('data', clientFrame(OPCODE.binary, new Uint8Array([1]), false));
        for (let i = 0; i < 8000; i++)
        {
            fake.emit('data', clientFrame(OPCODE.continuation, new Uint8Array([1]), false));
        }

        expect(closes).toEqual([1009]);
    });

    it('a legitimate fragmented message still assembles', () =>
    {
        const { fake, socket } = connect();
        let received: string | Uint8Array | null = null;
        socket.onMessage = (data): void =>
        {
            received = data;
        };

        fake.emit('data', clientFrame(OPCODE.text, new TextEncoder().encode('he'), false));
        fake.emit('data', clientFrame(OPCODE.continuation, new TextEncoder().encode('llo'), true));

        expect(received).toBe('hello');
    });
});

describe('the automatic pong cannot be used to fill the write queue', () =>
{
    it('pongs stop being queued once the socket is backed up', () =>
    {
        const { fake, socket } = connect();
        void socket;

        for (let i = 0; i < 40; i++)
        {
            fake.emit('data', clientFrame(OPCODE.ping, new Uint8Array(0)));
        }
        const beforeBacklog = fake.written.length;
        expect(beforeBacklog).toBe(40);

        // A client that floods pings while refusing to read: the queue is deep, so further pongs
        // are dropped rather than accumulating one userland write request per ping forever.
        fake.writableLength = 1024 * 1024;
        for (let i = 0; i < 500; i++)
        {
            fake.emit('data', clientFrame(OPCODE.ping, new Uint8Array(0)));
        }
        expect(fake.written.length).toBe(beforeBacklog);
    });
});

describe('nothing is delivered after onClose', () =>
{
    it('a close and a message in ONE chunk does not run the handler after teardown', () =>
    {
        const { fake, socket } = connect();
        const order: string[] = [];
        socket.onClose = (): void =>
        {
            order.push('close');
        };
        socket.onMessage = (): void =>
        {
            order.push('message');
        };

        // The exchange case: teardown releases the session, then an order arrives against it.
        fake.emit('data', Buffer.concat([
            clientFrame(OPCODE.close, Buffer.from([0x03, 0xe8])),
            clientFrame(OPCODE.text, new TextEncoder().encode('SELL 10000 BTC')),
            clientFrame(OPCODE.text, new TextEncoder().encode('and again'))
        ]));

        expect(order).toEqual(['close']);
    });
});

describe('drain settles when the connection ends', () =>
{
    it('a drain awaited across a disconnect resolves instead of hanging forever', async () =>
    {
        const { fake, socket } = connect();
        fake.writableNeedDrain = true;

        let settled = false;
        const waiting = socket.drain().then(() =>
        {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        // The peer vanishes. A destroyed socket never emits 'drain', so before the fix the
        // producer loop was abandoned mid-iteration and its finally block never ran.
        fake.emit('close');
        await waiting;
        expect(settled).toBe(true);
    });
});

describe('the heartbeat cannot be configured into a no-op', () =>
{
    it('a pong timeout at least as long as the interval still reclaims a dead peer', () =>
    {
        vi.useFakeTimers();
        try
        {
            const { fake, socket } = connect({ heartbeatMs: 100, pongTimeoutMs: 250 });
            const closes: number[] = [];
            socket.onClose = (code): void =>
            {
                closes.push(code);
            };

            // Sixteen intervals with no pong. Re-arming the deadline on every tick meant the
            // timeout could never fire and the half-open socket was never reclaimed.
            vi.advanceTimersByTime(1600);

            expect(fake.destroyed).toBe(true);
            expect(closes.length).toBeGreaterThan(0);
        }
        finally
        {
            vi.useRealTimers();
        }
    });
});

describe('a throwing error reporter cannot escape', () =>
{
    it('onError throwing does not propagate out of the socket', () =>
    {
        const { fake, socket } = connect();
        socket.onError = (): never =>
        {
            throw new Error('reporter is down');
        };
        let closed = false;
        socket.onClose = (): void =>
        {
            closed = true;
        };

        // A socket error reaches #report; before the guard the reporter's own throw escaped into
        // the emitter as an uncaught exception, taking every other live connection with it.
        expect(() => fake.emit('error', new Error('boom'))).not.toThrow();
        expect(closed).toBe(true);
    });
});

describe('maxPayload bounds per-connection memory', () =>
{
    it('is forwarded to the parser, so a declared oversize frame is refused from its header', () =>
    {
        const { fake, socket } = connect({ maxMessage: 1024, maxPayload: 1024 });
        const closes: number[] = [];
        socket.onClose = (code): void =>
        {
            closes.push(code);
        };

        // A 14-byte header declaring a 15 MiB payload, and not one payload byte sent. Before the
        // option was plumbed through, every connection could pin a 16 MiB parser buffer no matter
        // what maxMessage said.
        const header = Buffer.alloc(14);
        header[0] = 0x82;
        header[1] = 0xff;
        header.writeBigUInt64BE(BigInt(15 * 1024 * 1024), 2);
        fake.emit('data', header);

        expect(closes).toEqual([1009]);
    });
});

describe('close() is total: a teardown must always tear down', () =>
{
    it('a code RFC 6455 forbids on the wire closes with 1000 instead of throwing', () =>
    {
        const { fake, socket } = connect();

        // An app calling close(999) is a programmer error, but a connection left OPEN because its
        // close code was wrong is worse than one closed under a normalised code.
        expect(() => socket.close(999, 'bye')).not.toThrow();
        expect(fake.written.length).toBe(1);

        const frame = fake.written[0] ?? new Uint8Array();
        expect((frame[0] ?? 0) & 0x0f).toBe(OPCODE.close);
        expect(((frame[2] ?? 0) << 8) | (frame[3] ?? 0)).toBe(1000);
    });

    it('a reason far past the 125-byte control limit is truncated, not rejected', () =>
    {
        const { fake, socket } = connect();
        expect(() => socket.close(1008, 'x'.repeat(400))).not.toThrow();

        const frame = fake.written[0] ?? new Uint8Array();
        // A control frame's payload length lives in the low 7 bits of byte 1, and must fit 125.
        expect((frame[1] ?? 0) & 0x7f).toBeLessThanOrEqual(125);
    });
});
