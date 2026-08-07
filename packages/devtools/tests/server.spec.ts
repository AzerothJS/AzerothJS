// @vitest-environment node
//
// The server bridge's perimeter, driven over raw sockets the way an attacker would: the stream
// is live application state (a request root's signals hold that request's tokens and rows), so
// every gate is asserted from the outside - the positive environment check, the shared secret on
// the upgrade, the refusal of a missing Origin, and the loopback-only peer. A refused upgrade
// must be a plain HTTP 403 with no session byte on the wire.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { attachDevtools } from '../src/server.ts';

const TOKEN = 'devtools-test-token-0001';

let savedEnv: string | undefined;

beforeEach(() =>
{
    savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
});

afterEach(() =>
{
    if (savedEnv === undefined)
    {
        Reflect.deleteProperty(process.env, 'NODE_ENV');
    }
    else
    {
        process.env.NODE_ENV = savedEnv;
    }
});

async function listen(): Promise<{ server: Server; port: number; close: () => Promise<void> }>
{
    const server = createServer((_request, response) =>
    {
        response.statusCode = 404;
        response.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    return {
        server,
        port: typeof address === 'object' && address !== null ? address.port : 0,
        close: async (): Promise<void> =>
        {
            server.close();
            await once(server, 'close');
        }
    };
}

/** The bytes of a valid RFC 6455 opening handshake, with an optional Origin. */
function handshake(path: string, origin?: string): string
{
    return `GET ${ path } HTTP/1.1\r\nHost: local\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
        + (origin !== undefined ? `Origin: ${ origin }\r\n` : '')
        + '\r\n';
}

/** Connects, sends a handshake, and exposes everything the server has answered so far. */
async function exchange(port: number, request: string): Promise<{ socket: Socket; text: () => string }>
{
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    let buffer = '';
    socket.on('data', (chunk: Buffer) =>
    {
        buffer += chunk.toString('latin1');
    });
    socket.write(request);
    await once(socket, 'data');
    return { socket, text: () => buffer };
}

describe('the environment gate is positive', () =>
{
    it('refuses to attach for every NODE_ENV that is not exactly development', async () =>
    {
        const { server, close } = await listen();
        try
        {
            for (const env of ['', 'production', 'Production', 'PRODUCTION', 'prod', 'production ', 'staging', 'test'])
            {
                process.env.NODE_ENV = env;
                expect(() => attachDevtools(server, { token: TOKEN })).toThrow(/NODE_ENV=development/);
            }
            Reflect.deleteProperty(process.env, 'NODE_ENV');
            expect(() => attachDevtools(server, { token: TOKEN })).toThrow(/NODE_ENV=development/);
        }
        finally
        {
            await close();
        }
    });

    it('attaches under development, and elsewhere only with the explicit opt-in', async () =>
    {
        const { server, close } = await listen();
        try
        {
            attachDevtools(server, { token: TOKEN })();
            process.env.NODE_ENV = 'staging';
            attachDevtools(server, { token: TOKEN, allowNonDevelopment: true })();
        }
        finally
        {
            await close();
        }
    });

    it('demands a real shared secret at attach time', async () =>
    {
        const { server, close } = await listen();
        try
        {
            expect(() => attachDevtools(server, {} as unknown as { token: string })).toThrow(/shared secret/);
            expect(() => attachDevtools(server, { token: 'short' })).toThrow(/at least 16 characters/);
        }
        finally
        {
            await close();
        }
    });
});

describe('the upgrade gate', () =>
{
    async function withBridge(run: (port: number) => Promise<void>): Promise<void>
    {
        const { server, port, close } = await listen();
        const detach = attachDevtools(server, { token: TOKEN });
        try
        {
            await run(port);
        }
        finally
        {
            detach();
            await close();
        }
    }

    it('refuses an upgrade with no token, a wrong token, and a near-miss token', async () =>
    {
        await withBridge(async (port) =>
        {
            for (const path of [
                '/__azeroth/devtools',
                '/__azeroth/devtools?token=',
                '/__azeroth/devtools?token=guess',
                `/__azeroth/devtools?token=${ TOKEN }x`,
                `/__azeroth/devtools?token=${ TOKEN.slice(0, -1) }X`
            ])
            {
                const { socket, text } = await exchange(port, handshake(path, 'http://localhost:5173'));
                expect(text()).toContain('403 Forbidden');
                expect(text()).not.toContain('session');
                socket.destroy();
            }
        });
    });

    it('answers 403, never 500, for a multi-byte token of the same code-unit length', async () =>
    {
        // The length guard compared `String.length` (UTF-16 code units) but then handed
        // `timingSafeEqual` the UTF-8 BUFFERS. A token of equal code-unit length but unequal
        // byte length passed the guard and made timingSafeEqual THROW, which the ws layer
        // turns into 500 while every honest mismatch is 403. Since the peer gate admits any
        // loopback browser and Origin is checked AFTER the secret, any page the developer
        // visited could binary-search the token's length off that difference.
        await withBridge(async (port) =>
        {
            const sameUnitsMoreBytes = 'é'.repeat(TOKEN.length).slice(0, TOKEN.length);
            expect(sameUnitsMoreBytes.length).toBe(TOKEN.length);
            expect(Buffer.byteLength(sameUnitsMoreBytes)).not.toBe(Buffer.byteLength(TOKEN));

            const path = `/__azeroth/devtools?token=${ encodeURIComponent(sameUnitsMoreBytes) }`;
            const { socket, text } = await exchange(port, handshake(path, 'http://localhost:5173'));
            expect(text()).toContain('403 Forbidden');
            expect(text()).not.toContain('500');
            socket.destroy();
        });
    });

    it('refuses a MISSING Origin - what a non-browser client sends', async () =>
    {
        await withBridge(async (port) =>
        {
            const { socket, text } = await exchange(port, handshake(`/__azeroth/devtools?token=${ TOKEN }`));
            expect(text()).toContain('403 Forbidden');
            expect(text()).not.toContain('session');
            socket.destroy();
        });
    });

    it('refuses a foreign Origin even with the right token', async () =>
    {
        await withBridge(async (port) =>
        {
            const { socket, text } = await exchange(port, handshake(`/__azeroth/devtools?token=${ TOKEN }`, 'https://evil.example'));
            expect(text()).toContain('403 Forbidden');
            socket.destroy();
        });
    });

    it('upgrades a localhost page carrying the token, and streams the session', async () =>
    {
        await withBridge(async (port) =>
        {
            const { socket, text } = await exchange(port, handshake(`/__azeroth/devtools?token=${ TOKEN }`, 'http://localhost:5173'));
            expect(text()).toContain('101 Switching Protocols');
            await vi.waitFor(() => expect(text()).toContain('"type":"session"'), { timeout: 2000 });
            socket.destroy();
        });
    });

    it('refuses a peer that is not loopback', async () =>
    {
        const { server, close } = await listen();
        const detach = attachDevtools(server, { token: TOKEN });
        try
        {
            const written: string[] = [];
            const peer = {
                remoteAddress: '203.0.113.7',
                destroyed: false,
                bytesWritten: 0,
                write(chunk: string): boolean
                {
                    written.push(chunk);
                    return true;
                },
                destroy(): void
                {
                    this.destroyed = true;
                }
            };
            const request = {
                url: `/__azeroth/devtools?token=${ TOKEN }`,
                headers: { origin: 'http://localhost:5173' },
                socket: peer
            } as unknown as IncomingMessage;

            server.emit('upgrade', request, peer, Buffer.alloc(0));

            expect(written.join('')).toContain('403 Forbidden');
            expect(written.join('')).not.toContain('session');
            expect(peer.destroyed).toBe(true);
        }
        finally
        {
            detach();
            await close();
        }
    });

    it('allows a remote peer only with the explicit opt-in', async () =>
    {
        const { server, close } = await listen();
        const detach = attachDevtools(server, { token: TOKEN, allowRemoteClients: true });
        try
        {
            const written: string[] = [];
            const peer = {
                remoteAddress: '203.0.113.7',
                destroyed: false,
                bytesWritten: 0,
                setNoDelay(): void
                { /* the ServerSocket constructor asks for this */ },
                on(): void
                { /* frames never arrive on a fake peer */ },
                once(): void
                { /* nor does a close */ },
                write(chunk: string): boolean
                {
                    written.push(chunk);
                    return true;
                },
                destroy(): void
                {
                    this.destroyed = true;
                }
            };
            const request = {
                method: 'GET',
                url: `/__azeroth/devtools?token=${ TOKEN }`,
                headers: {
                    // A real IncomingMessage always carries these; the handshake requires a Host
                    // and HTTP/1.1 per RFC 6455 section 4.1, so a fixture without them is not a
                    // request any server could receive.
                    host: 'localhost:5200',
                    origin: 'http://localhost:5173',
                    upgrade: 'websocket',
                    connection: 'Upgrade',
                    'sec-websocket-version': '13',
                    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ=='
                },
                httpVersionMajor: 1,
                httpVersionMinor: 1,
                socket: peer
            } as unknown as IncomingMessage;

            server.emit('upgrade', request, peer, Buffer.alloc(0));

            expect(written.join('')).toContain('101 Switching Protocols');
        }
        finally
        {
            detach();
            await close();
        }
    });
});
