// @vitest-environment node
//
// Security hardening for the codec and the attach layer, each case pinning a concrete
// attack or defect: quadratic reassembly blocking the event loop for 30 seconds on a plain
// upload, cross-site WebSocket hijacking by default, a throwing gate taking the process
// down, unbounded connections, and illegal control frames leaving the serializer.
//
// Everything here is hand-crafted over a raw node:net socket against a real server - a
// client library normalizes away exactly the malformed input under test.

import { describe, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import {
    attachWebSockets, closePayload, serializeFrame, FrameParser, OPCODE, ProtocolError,
    parseClosePayload, validateHandshake, type AttachOptions
} from '@azerothjs/ws';

type Raw = ReturnType<typeof connect>;

async function listen(): Promise<{ server: Server; port: number }>
{
    const server = createServer((_request, response) => void response.end('ok'));
    await new Promise<void>((resolve) => void server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return { server, port: typeof address === 'object' && address !== null ? address.port : 0 };
}

function shutdown(server: Server): Promise<void>
{
    return new Promise((resolve) =>
    {
        server.closeAllConnections();
        server.close(() => resolve());
    });
}

/** The bytes of an opening handshake, header by header so each rule can be violated alone. */
function handshake(headers: Record<string, string>, target = '/ws', version = '1.1'): string
{
    const lines = Object.entries(headers).map(([name, value]) => `${ name }: ${ value }\r\n`).join('');
    return `GET ${ target } HTTP/${ version }\r\n${ lines }\r\n`;
}

/** The header set a compliant browser-equivalent client sends, same-origin by construction. */
function compliant(port: number, extra: Record<string, string> = {}): Record<string, string>
{
    return {
        Host: `127.0.0.1:${ port }`,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...extra
    };
}

/**
 * Connects, writes `request`, and splits the HTTP response line from the frames that follow
 * it: the status is the refusal under test, the frames are what a compliant peer would see.
 */
function speak(port: number, request: string): { socket: Raw; status: Promise<number>; nextFrame: () => Promise<{ opcode: number; payload: Uint8Array }> }
{
    const socket = connect(port, '127.0.0.1');
    const parser = new FrameParser({ role: 'client' });
    const queue: Array<{ opcode: number; payload: Uint8Array }> = [];
    const waiters: Array<(frame: { opcode: number; payload: Uint8Array }) => void> = [];
    let header = Buffer.alloc(0);
    let headerDone = false;
    let settle: (status: number) => void = () => undefined;
    const status = new Promise<number>((resolve) =>
    {
        settle = resolve;
    });

    socket.on('error', () => undefined); // a refusal destroys the socket; ECONNRESET is expected
    socket.on('close', () => settle(0));
    socket.on('data', (chunk: Buffer) =>
    {
        let rest = chunk;
        if (!headerDone)
        {
            header = Buffer.concat([header, chunk]);
            const end = header.indexOf('\r\n\r\n');
            if (end === -1)
            {
                return;
            }
            headerDone = true;
            settle(Number(header.toString('latin1').split(' ')[1]));
            rest = header.subarray(end + 4);
        }
        for (const frame of parser.push(rest))
        {
            const waiter = waiters.shift();
            if (waiter === undefined)
            {
                queue.push(frame);
            }
            else
            {
                waiter(frame);
            }
        }
    });
    socket.once('connect', () => void socket.write(request));

    const nextFrame = (): Promise<{ opcode: number; payload: Uint8Array }> =>
    {
        const queued = queue.shift();
        return queued === undefined
            ? new Promise((resolve) => void waiters.push(resolve))
            : Promise.resolve(queued);
    };
    return { socket, status, nextFrame };
}

async function withEndpoint(options: AttachOptions, run: (port: number) => Promise<void>): Promise<void>
{
    const { server, port } = await listen();
    const detach = attachWebSockets(server, options);
    try
    {
        await run(port);
    }
    finally
    {
        detach();
        await shutdown(server);
    }
}

describe('FrameParser reassembly cost', () =>
{
    /** Feeds one frame in fixed-size segments and returns the assembled payload plus timing. */
    function feed(payloadSize: number, segment: number): { ms: number; payload: Uint8Array }
    {
        const payload = new Uint8Array(payloadSize);
        for (let i = 0; i < payloadSize; i++)
        {
            payload[i] = i & 0xff;
        }
        const wire = serializeFrame(OPCODE.binary, payload, { mask: true });
        const parser = new FrameParser();
        const started = performance.now();
        let assembled: Uint8Array | undefined;
        for (let i = 0; i < wire.byteLength; i += segment)
        {
            for (const frame of parser.push(wire.subarray(i, Math.min(i + segment, wire.byteLength))))
            {
                assembled = frame.payload;
            }
        }
        const ms = performance.now() - started;
        expect(assembled).toBeDefined();
        return { ms, payload: assembled ?? new Uint8Array(0) };
    }

    it('reassembles a 16 MiB frame from TCP-sized segments without blocking the event loop', () =>
    {
        // Reconcatenating the retained buffer per push cost O(n*k): this same input measured
        // 30.5 SECONDS of blocked loop and 2 GiB of memcpy. The bound is deliberately loose;
        // the measurements below are the real signal.
        const measured: string[] = [];
        for (const mib of [1, 4, 16])
        {
            const size = mib * 1024 * 1024;
            const { ms, payload } = feed(size, 1400);
            expect(payload.byteLength).toBe(size);
            expect(payload[0]).toBe(0);
            expect(payload[size - 1]).toBe((size - 1) & 0xff);
            measured.push(`${ mib } MiB / 1400-byte segments: ${ ms.toFixed(1) } ms`);
            if (mib === 16)
            {
                expect(ms).toBeLessThan(5000);
            }
        }
        console.log(`[ws parser] ${ measured.join('  |  ') }`);
    }, 120_000);

    it('64 KiB reads of an 8 MiB frame stay linear', () =>
    {
        const size = 8 * 1024 * 1024;
        const { ms, payload } = feed(size, 64 * 1024);
        expect(payload.byteLength).toBe(size);
        expect(ms).toBeLessThan(5000);
        console.log(`[ws parser] 8 MiB / 64 KiB reads: ${ ms.toFixed(1) } ms`);
    }, 120_000);

    it('any chunking reassembles byte-identically to a single chunk', () =>
    {
        const wire = new Uint8Array([
            ...serializeFrame(OPCODE.text, new TextEncoder().encode('first'), { mask: true }),
            ...serializeFrame(OPCODE.binary, new Uint8Array(300).fill(11), { mask: true, fin: false }),
            ...serializeFrame(OPCODE.continuation, new Uint8Array(70_000).fill(12), { mask: true }),
            ...serializeFrame(OPCODE.ping, new Uint8Array([1, 2, 3]), { mask: true })
        ]);
        const single = new FrameParser().push(wire).map((frame) => [frame.fin, frame.opcode, frame.payload.byteLength]);

        let state = 0xc0ffee;
        const random = (limit: number): number =>
        {
            state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
            return 1 + ((state >>> 0) % limit);
        };
        for (let attempt = 0; attempt < 40; attempt++)
        {
            const parser = new FrameParser();
            const seen: Array<[boolean, number, number]> = [];
            const bytes: number[] = [];
            for (let i = 0; i < wire.byteLength;)
            {
                const take = Math.min(random(4096), wire.byteLength - i);
                for (const frame of parser.push(wire.subarray(i, i + take)))
                {
                    seen.push([frame.fin, frame.opcode, frame.payload.byteLength]);
                    bytes.push(...frame.payload.subarray(0, 4));
                }
                i += take;
            }
            expect(seen, `attempt ${ attempt }`).toEqual(single);
        }
    });
});

describe('cross-site WebSocket hijacking', () =>
{
    it('refuses a cross-origin upgrade with 403 by DEFAULT (no verifyOrigin configured)', async () =>
    {
        const opened = vi.fn();
        await withEndpoint({ path: '/ws', onConnection: opened }, async (port) =>
        {
            const evil = speak(port, handshake(compliant(port, { Origin: 'https://evil.example' })));
            expect(await evil.status).toBe(403);
            expect(opened).not.toHaveBeenCalled();
            evil.socket.destroy();

            // A sandboxed frame's opaque origin is not same-origin either.
            const opaque = speak(port, handshake(compliant(port, { Origin: 'null' })));
            expect(await opaque.status).toBe(403);
            opaque.socket.destroy();

            // Same host:port as the request was aimed at.
            const same = speak(port, handshake(compliant(port, { Origin: `http://127.0.0.1:${ port }` })));
            expect(await same.status).toBe(101);
            same.socket.destroy();

            // A different PORT on the same host is a different origin.
            const otherPort = speak(port, handshake(compliant(port, { Origin: 'http://127.0.0.1:1' })));
            expect(await otherPort.status).toBe(403);
            otherPort.socket.destroy();
        });
    });

    it('a client sending no Origin (non-browser) is still allowed', async () =>
    {
        await withEndpoint({ path: '/ws', onConnection: () => undefined }, async (port) =>
        {
            const plain = speak(port, handshake(compliant(port)));
            expect(await plain.status).toBe(101);
            plain.socket.destroy();
        });
    });

    it('verifyOrigin remains the override in both directions', async () =>
    {
        await withEndpoint(
            {
                path: '/ws',
                verifyOrigin: (origin) => origin === 'https://trusted.example',
                onConnection: () => undefined
            },
            async (port) =>
            {
                const trusted = speak(port, handshake(compliant(port, { Origin: 'https://trusted.example' })));
                expect(await trusted.status).toBe(101); // cross-origin, but explicitly trusted
                trusted.socket.destroy();

                const rejected = speak(port, handshake(compliant(port, { Origin: `http://127.0.0.1:${ port }` })));
                expect(await rejected.status).toBe(403); // same-origin, but the callback says no
                rejected.socket.destroy();
            }
        );
    });
});

describe('a throwing gate must not kill the process', () =>
{
    it('verifyOrigin throwing refuses with 500 and the server keeps serving', async () =>
    {
        let fail = true;
        await withEndpoint(
            {
                path: '/ws',
                verifyOrigin: () =>
                {
                    if (fail)
                    {
                        throw new Error('auth backend down');
                    }
                    return true;
                },
                onConnection: () => undefined
            },
            async (port) =>
            {
                const broken = speak(port, handshake(compliant(port)));
                expect(await broken.status).toBe(500);
                broken.socket.destroy();

                fail = false;
                const later = speak(port, handshake(compliant(port)));
                expect(await later.status).toBe(101); // the listener survived the throw
                later.socket.destroy();
            }
        );
    });

    it('onConnection throwing closes that socket with 1011 and the server keeps serving', async () =>
    {
        let fail = true;
        await withEndpoint(
            {
                path: '/ws',
                onConnection: (socket) =>
                {
                    if (fail)
                    {
                        throw new Error('header parse failed');
                    }
                    socket.send('ready');
                }
            },
            async (port) =>
            {
                const broken = speak(port, handshake(compliant(port)));
                expect(await broken.status).toBe(101); // the 101 is already on the wire
                const closed = await broken.nextFrame();
                expect(closed.opcode).toBe(OPCODE.close);
                expect(parseClosePayload(closed.payload).code).toBe(1011);
                broken.socket.destroy();

                fail = false;
                const later = speak(port, handshake(compliant(port)));
                expect(await later.status).toBe(101);
                expect(new TextDecoder().decode((await later.nextFrame()).payload)).toBe('ready');
                later.socket.destroy();
            }
        );
    });
});

describe('maxConnections', () =>
{
    it('refuses past the cap with 503 while the live connection keeps working', async () =>
    {
        await withEndpoint(
            {
                path: '/ws',
                maxConnections: 1,
                heartbeatMs: 0,
                onConnection: (socket) =>
                {
                    socket.onMessage = (data) => void socket.send(data);
                }
            },
            async (port) =>
            {
                const first = speak(port, handshake(compliant(port)));
                expect(await first.status).toBe(101);

                const second = speak(port, handshake(compliant(port)));
                expect(await second.status).toBe(503);
                second.socket.destroy();

                first.socket.write(serializeFrame(OPCODE.text, new TextEncoder().encode('alive'), { mask: true }));
                expect(new TextDecoder().decode((await first.nextFrame()).payload)).toBe('alive');
                first.socket.destroy();
            }
        );
    });
});

describe('the server never emits an illegal control frame', () =>
{
    it('truncates a long close reason to 123 bytes on a codepoint boundary', () =>
    {
        const payload = closePayload(1008, 'x'.repeat(214));
        expect(payload.byteLength).toBe(125); // 2 code bytes + 123, a legal control payload
        expect(parseClosePayload(payload)).toEqual({ code: 1008, reason: 'x'.repeat(123) });

        // 4-byte codepoints cannot fill 123 bytes, so the cut must land at 120.
        const emoji = closePayload(1008, '\u{1f642}'.repeat(50));
        expect(emoji.byteLength).toBe(122);
        expect(parseClosePayload(emoji).reason).toBe('\u{1f642}'.repeat(30));
        expect(parseClosePayload(emoji).reason).not.toContain('�');
    });

    it('a close reason from user input survives as a readable 1008 on the wire', async () =>
    {
        const reason = `rejected: ${ 'é'.repeat(200) }`;
        await withEndpoint(
            { path: '/ws', onConnection: (socket) => socket.close(1008, reason) },
            async (port) =>
            {
                const peer = speak(port, handshake(compliant(port)));
                expect(await peer.status).toBe(101);
                const frame = await peer.nextFrame();
                expect(frame.opcode).toBe(OPCODE.close);
                expect(frame.payload.byteLength).toBeLessThanOrEqual(125);
                // A 241-byte control payload made a compliant peer answer 1002, losing this.
                const { code, reason: got } = parseClosePayload(frame.payload);
                expect(code).toBe(1008);
                expect(reason.startsWith(got)).toBe(true);
                peer.socket.destroy();
            }
        );
    });

    it('1005 and 1006 leave the wire empty instead of carrying a forbidden code', () =>
    {
        expect(closePayload(1005, 'ignored').byteLength).toBe(0);
        expect(closePayload(1006, 'ignored').byteLength).toBe(0);
        expect(parseClosePayload(closePayload(1005)).code).toBe(1005); // "no status received"
    });

    it('a code outside the sendable set is a RangeError, not a 16-bit alias', () =>
    {
        expect(() => closePayload(70_000)).toThrow(RangeError); // 16-bit truncation would deliver 4464
        for (const code of [0, 999, 1004, 1015, 2999, 5000])
        {
            expect(() => closePayload(code), `code ${ code }`).toThrow(RangeError);
        }
        expect(closePayload(1000).byteLength).toBe(2);
        expect(closePayload(4999).byteLength).toBe(2);
    });

    it('serializeFrame refuses an oversized control payload', () =>
    {
        expect(() => serializeFrame(OPCODE.ping, new Uint8Array(126))).toThrow(RangeError);
        expect(() => serializeFrame(OPCODE.pong, new Uint8Array(126))).toThrow(RangeError);
        expect(() => serializeFrame(OPCODE.close, new Uint8Array(126))).toThrow(RangeError);
        expect(serializeFrame(OPCODE.ping, new Uint8Array(125)).byteLength).toBe(127);
        expect(serializeFrame(OPCODE.binary, new Uint8Array(126)).byteLength).toBe(130); // data is uncapped
    });
});

describe('the IANA close codes a gateway actually sends', () =>
{
    it('accepts 1012, 1013 and 1014 instead of killing the peer with 1002', () =>
    {
        for (const code of [1012, 1013, 1014])
        {
            const wire = new Uint8Array([code >>> 8, code & 0xff]);
            expect(parseClosePayload(wire), `code ${ code }`).toEqual({ code, reason: '' });
        }
    });

    it('a peer closing with 1013 "try again later" is echoed 1013, not a protocol violation', async () =>
    {
        const seen: Array<[number, string]> = [];
        await withEndpoint(
            {
                path: '/ws',
                onConnection: (socket) =>
                {
                    socket.onClose = (code, reason) => void seen.push([code, reason]);
                }
            },
            async (port) =>
            {
                const peer = speak(port, handshake(compliant(port)));
                expect(await peer.status).toBe(101);
                peer.socket.write(serializeFrame(OPCODE.close, closePayload(1013, 'shedding'), { mask: true }));
                const echo = await peer.nextFrame();
                expect(echo.opcode).toBe(OPCODE.close);
                expect(parseClosePayload(echo.payload).code).toBe(1013);
                await vi.waitFor(() => expect(seen).toEqual([[1013, 'shedding']]));
                peer.socket.destroy();
            }
        );
    });
});

describe('handshake conformance', () =>
{
    it('a 64-bit length with the high bit set is the documented 1002, not 1009', () =>
    {
        const wire = new Uint8Array([0x82, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 0]);
        try
        {
            new FrameParser().push(wire);
            expect.unreachable('the parser accepted a 64-bit length with the high bit set');
        }
        catch (error)
        {
            expect(error).toBeInstanceOf(ProtocolError);
            expect((error as ProtocolError).code).toBe(1002);
        }
    });

    it('Upgrade is a token list: "websocket, h2c" upgrades', async () =>
    {
        await withEndpoint({ path: '/ws', onConnection: () => undefined }, async (port) =>
        {
            const listed = speak(port, handshake(compliant(port, { Upgrade: 'websocket, h2c' })));
            expect(await listed.status).toBe(101);
            listed.socket.destroy();
        });
    });

    it('a missing Host is 400 and HTTP/1.0 is 505', async () =>
    {
        await withEndpoint({ path: '/ws', onConnection: () => undefined }, async (port) =>
        {
            const headers = compliant(port);
            delete headers.Host;
            const hostless = speak(port, handshake(headers));
            expect(await hostless.status).toBe(400);
            hostless.socket.destroy();

            const old = speak(port, handshake(compliant(port), '/ws', '1.0'));
            expect(await old.status).toBe(505);
            old.socket.destroy();
        });
    });

    it('validateHandshake reports the same two rules directly', () =>
    {
        const base = {
            httpVersionMajor: 1,
            httpVersionMinor: 1,
            method: 'GET',
            headers: {
                host: 'local',
                upgrade: 'websocket',
                connection: 'Upgrade',
                'sec-websocket-version': '13',
                'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ=='
            }
        };
        const request = (patch: Record<string, unknown>): Parameters<typeof validateHandshake>[0] =>
            ({ ...base, ...patch }) as unknown as Parameters<typeof validateHandshake>[0];

        expect(validateHandshake(request({}))).toEqual({ key: 'dGhlIHNhbXBsZSBub25jZQ==' });
        expect(validateHandshake(request({ headers: { ...base.headers, host: undefined } }))).toMatchObject({ status: 400 });
        expect(validateHandshake(request({ httpVersionMinor: 0 }))).toMatchObject({ status: 505 });
        expect(validateHandshake(request({ headers: { ...base.headers, upgrade: 'h2c, WebSocket' } })))
            .toEqual({ key: 'dGhlIHNhbXBsZSBub25jZQ==' });
    });
});
