/**
 * MODULE: ws/handshake - the RFC 6455 opening handshake (section 4)
 *
 * A WebSocket begins as an HTTP/1.1 GET carrying Upgrade headers; the server proves it
 * speaks WebSocket (and is not an HTTP cache blindly replaying bytes) by hashing the
 * client's random Sec-WebSocket-Key with a fixed GUID into Sec-WebSocket-Accept. The
 * validation here is strict: a request missing any required header is answered with a
 * plain HTTP error, never half-upgraded.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** The RFC 6455 handshake GUID - a protocol constant, not a secret. */
const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** The Sec-WebSocket-Accept value for a client key. */
export function acceptValueFor(key: string): string
{
    return createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64');
}

/** Why a handshake was refused (mapped to a plain HTTP response by the attach layer). */
export interface HandshakeRejection
{
    status: number;
    reason: string;
}

/** @internal A comma-separated header field as its lowercased token set (RFC 7230 section 7). */
function tokens(field: string | undefined): string[]
{
    return (field ?? '').toLowerCase().split(',').map((token) => token.trim());
}

/**
 * Validates an upgrade request. Returns the client key on success, or the rejection to
 * answer with. `Upgrade` and `Connection` are both token LISTS (browsers send
 * `keep-alive, Upgrade`, and a client offering more than one protocol sends
 * `websocket, h2c`), so membership - not equality - is the test.
 */
export function validateHandshake(request: IncomingMessage): { key: string } | HandshakeRejection
{
    if (request.method !== 'GET')
    {
        return { status: 405, reason: 'WebSocket handshakes are GET requests.' };
    }
    // RFC 6455 section 4.1: the handshake is an HTTP/1.1-or-later request carrying a Host.
    if (request.httpVersionMajor < 1 || (request.httpVersionMajor === 1 && request.httpVersionMinor < 1))
    {
        return { status: 505, reason: 'WebSocket handshakes require HTTP/1.1 or later.' };
    }
    if ((request.headers.host ?? '') === '')
    {
        return { status: 400, reason: 'A WebSocket handshake must carry a Host header.' };
    }
    if (!tokens(request.headers.upgrade).includes('websocket'))
    {
        return { status: 426, reason: 'Expected an Upgrade: websocket request.' };
    }
    if (!tokens(request.headers.connection).includes('upgrade'))
    {
        return { status: 400, reason: 'The Connection header must include "upgrade".' };
    }
    if (request.headers['sec-websocket-version'] !== '13')
    {
        return { status: 426, reason: 'Only WebSocket version 13 is supported.' };
    }
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string' || Buffer.from(key, 'base64').byteLength !== 16)
    {
        return { status: 400, reason: 'Sec-WebSocket-Key must be 16 base64-encoded bytes.' };
    }
    return { key };
}

/** The raw 101 response bytes completing the upgrade. */
export function upgradeResponse(key: string): string
{
    return 'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${ acceptValueFor(key) }\r\n`
        + '\r\n';
}
