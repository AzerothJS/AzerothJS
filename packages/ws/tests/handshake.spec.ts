// @vitest-environment node
//
// The opening handshake, pinned against RFC 6455's OWN worked example (section 1.3): the
// sample nonce must hash to the sample accept value, byte for byte. The rejection matrix
// then covers each required header's absence or corruption.

import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { acceptValueFor, validateHandshake, upgradeResponse } from '@azerothjs/ws';

function upgradeRequest(overrides: Record<string, string | undefined> = {}, method = 'GET'): IncomingMessage
{
    const headers: Record<string, string | undefined> = {
        upgrade: 'websocket',
        connection: 'keep-alive, Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...overrides
    };
    return { method, headers } as unknown as IncomingMessage;
}

describe('the RFC 6455 vector', () =>
{
    it('hashes the sample nonce to the sample accept value', () =>
    {
        expect(acceptValueFor('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    });

    it('the 101 response carries the accept header and correct framing', () =>
    {
        const response = upgradeResponse('dGhlIHNhbXBsZSBub25jZQ==');
        expect(response).toContain('HTTP/1.1 101 Switching Protocols\r\n');
        expect(response).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n');
        expect(response.endsWith('\r\n\r\n')).toBe(true);
    });
});

describe('validation', () =>
{
    it('accepts a compliant request (Connection as a token list)', () =>
    {
        const outcome = validateHandshake(upgradeRequest());
        expect(outcome).toEqual({ key: 'dGhlIHNhbXBsZSBub25jZQ==' });
    });

    it('rejects each missing or wrong requirement with a plain HTTP status', () =>
    {
        expect(validateHandshake(upgradeRequest({}, 'POST'))).toMatchObject({ status: 405 });
        expect(validateHandshake(upgradeRequest({ upgrade: undefined }))).toMatchObject({ status: 426 });
        expect(validateHandshake(upgradeRequest({ connection: 'keep-alive' }))).toMatchObject({ status: 400 });
        expect(validateHandshake(upgradeRequest({ 'sec-websocket-version': '8' }))).toMatchObject({ status: 426 });
        expect(validateHandshake(upgradeRequest({ 'sec-websocket-key': undefined }))).toMatchObject({ status: 400 });
        expect(validateHandshake(upgradeRequest({ 'sec-websocket-key': 'dG9vc2hvcnQ=' }))).toMatchObject({ status: 400 });
    });
});
