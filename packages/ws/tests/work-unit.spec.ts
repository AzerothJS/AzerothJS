// @vitest-environment node
//
// The per-message work unit through REAL frames: one unit per complete APPLICATION
// message - fragments assemble first, control frames never enter one - with every failure
// (a unit's report, a throwing interceptor, an async handler's rejection) landing on the
// contained onError path instead of the frame loop. The interceptor under test is the
// real `createWorkUnitInterceptor`, so per-message cache isolation is measured through
// the shipped seam, not a stand-in.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { connect } from 'node:net';
import { once } from 'node:events';
import { cached } from 'azerothjs';
import { App, createWorkUnitInterceptor, type WorkUnitInterceptor } from '@azerothjs/http';
import { serve } from '@azerothjs/http/node';
import { attachWebSockets, serializeFrame, FrameParser, OPCODE, type ServerSocket, type ServerSocketOptions } from '@azerothjs/ws';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function countingFamily(name: string): { family: (key: string) => Promise<string>; fetches: () => number }
{
    let count = 0;
    const family = cached(name, (key: string) =>
    {
        count++;
        return Promise.resolve(`${ name }:${ key }`);
    });
    return { family, fetches: () => count };
}

async function withServer(
    options: { intercept?: NonNullable<ServerSocketOptions['intercept']> },
    onConnection: (socket: ServerSocket) => void,
    run: (port: number) => Promise<void>
): Promise<void>
{
    const app = new App();
    const served = await serve(app, { banner: false });
    const detach = attachWebSockets(served.server, { ...options, path: '/ws', onConnection });
    try
    {
        await run(served.port);
    }
    finally
    {
        detach();
        await served.shutdown({ gracePeriodMs: 500 });
    }
}

/** Performs the HTTP handshake on a raw socket, then hands the socket over. */
async function rawClient(port: number): Promise<{ socket: ReturnType<typeof connect>; close: () => void }>
{
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write('GET /ws HTTP/1.1\r\nHost: local\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    const parser = new FrameParser({ role: 'client' });
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
        parser.push(payload);
    });
    await sleep(30);
    return { socket, close: () => socket.destroy() };
}

describe('one work unit per application message', () =>
{
    it('fragmented text, fragmented binary, two-in-one-chunk and ping: units match messages, control frames get none', async () =>
    {
        let units = 0;
        const delivered: Array<string | Uint8Array> = [];
        await withServer(
            {
                intercept: (unit, report) =>
                {
                    units++;
                    try
                    {
                        return unit();
                    }
                    catch (error)
                    {
                        report(error);
                        return undefined;
                    }
                }
            },
            (socket) =>
            {
                socket.onMessage = (data) => void delivered.push(data);
            },
            async (port) =>
            {
                const { socket, close } = await rawClient(port);
                // fragmented text with an interleaved ping (the ping must not open a unit)
                socket.write(serializeFrame(OPCODE.text, encode('hel'), { mask: true, fin: false }));
                socket.write(serializeFrame(OPCODE.ping, encode('probe'), { mask: true }));
                socket.write(serializeFrame(OPCODE.continuation, encode('lo'), { mask: true }));
                // fragmented binary
                socket.write(serializeFrame(OPCODE.binary, new Uint8Array([1, 2]), { mask: true, fin: false }));
                socket.write(serializeFrame(OPCODE.continuation, new Uint8Array([3]), { mask: true }));
                // two complete messages in ONE tcp chunk
                socket.write(Buffer.concat([
                    serializeFrame(OPCODE.text, encode('a'), { mask: true }),
                    serializeFrame(OPCODE.text, encode('b'), { mask: true })
                ]));
                await sleep(80);
                close();
            });
        expect(delivered).toHaveLength(4);
        expect(delivered[0]).toBe('hello');
        expect(delivered[1]).toEqual(new Uint8Array([1, 2, 3]));
        expect(delivered[2]).toBe('a');
        expect(delivered[3]).toBe('b');
        expect(units).toBe(4);
    });

    it('intercepted messages isolate per unit - identity change on one socket, interleaved mid-await', async () =>
    {
        const { family, fetches } = countingFamily('ws-unit');
        let releaseBarrier!: () => void;
        const barrier = new Promise<void>((resolve) =>
        {
            releaseBarrier = resolve;
        });
        const echoed: string[] = [];
        let arrived = 0;
        await withServer(
            { intercept: createWorkUnitInterceptor() },
            (socket) =>
            {
                socket.onMessage = async (data) =>
                {
                    arrived++;
                    await barrier;
                    const value = await family('k');
                    await family('k');
                    echoed.push(`${ String(data) }=${ value }`);
                    socket.send(`${ String(data) }:done`);
                };
            },
            async (port) =>
            {
                const client = new WebSocket(`ws://127.0.0.1:${ port }/ws`);
                const done = new Promise<void>((resolve) =>
                {
                    let seen = 0;
                    client.addEventListener('message', () =>
                    {
                        seen++;
                        if (seen === 2)
                        {
                            resolve();
                        }
                    });
                });
                await new Promise<void>((resolve) => client.addEventListener('open', () => resolve()));
                client.send('alice');
                client.send('bob');
                while (arrived < 2)
                {
                    await sleep(5);
                }
                releaseBarrier();
                await done;
                client.close();
            });
        expect(echoed.sort()).toEqual(['alice=ws-unit:k', 'bob=ws-unit:k']);
        expect(fetches()).toBe(2);
    });

    it('a throwing interceptor reports and the connection stays alive', async () =>
    {
        const errors: string[] = [];
        const delivered: string[] = [];
        await withServer(
            {
                intercept: () =>
                {
                    throw new Error('hostile interceptor');
                }
            },
            (socket) =>
            {
                socket.onError = (error) => void errors.push(error.message);
                socket.onMessage = (data) => void delivered.push(String(data));
            },
            async (port) =>
            {
                const client = new WebSocket(`ws://127.0.0.1:${ port }/ws`);
                await new Promise<void>((resolve) => client.addEventListener('open', () => resolve()));
                const closed: number[] = [];
                client.addEventListener('close', (event) => void closed.push(event.code));
                client.send('one');
                await sleep(40);
                client.send('two');
                await sleep(40);
                expect(closed).toHaveLength(0);
                client.close();
            });
        expect(errors).toEqual(['hostile interceptor', 'hostile interceptor']);
        expect(delivered).toHaveLength(0);
    });

    it('an async handler rejection reaches onError with NO interceptor wired', async () =>
    {
        const errors: string[] = [];
        await withServer(
            {},
            (socket) =>
            {
                socket.onError = (error) => void errors.push(error.message);
                socket.onMessage = async () =>
                {
                    await sleep(5);
                    throw new Error('handler rejection');
                };
            },
            async (port) =>
            {
                const client = new WebSocket(`ws://127.0.0.1:${ port }/ws`);
                await new Promise<void>((resolve) => client.addEventListener('open', () => resolve()));
                client.send('go');
                await sleep(50);
                client.close();
            });
        expect(errors).toEqual(['handler rejection']);
    });

    it('a PASS-THROUGH interceptor keeps the rejection lane: the handler\'s rejection still reaches onError', async () =>
    {
        const errors: string[] = [];
        await withServer(
            { intercept: (unit) => unit() },
            (socket) =>
            {
                socket.onError = (error) => void errors.push(error.message);
                socket.onMessage = async () =>
                {
                    await sleep(5);
                    throw new Error('rejected under pass-through');
                };
            },
            async (port) =>
            {
                const client = new WebSocket(`ws://127.0.0.1:${ port }/ws`);
                await new Promise<void>((resolve) => client.addEventListener('open', () => resolve()));
                client.send('go');
                await sleep(50);
                client.close();
            });
        expect(errors).toEqual(['rejected under pass-through']);
    });

    it('the structural intercept option and http\'s WorkUnitInterceptor are mutually assignable', () =>
    {
        expectTypeOf<WorkUnitInterceptor>().toExtend<NonNullable<ServerSocketOptions['intercept']>>();
        expectTypeOf<NonNullable<ServerSocketOptions['intercept']>>().toExtend<WorkUnitInterceptor>();
    });
});
