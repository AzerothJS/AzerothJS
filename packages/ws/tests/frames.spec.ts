// @vitest-environment node
//
// The frame codec: round-trips through our own serializer (client role, masked) into the
// server parser, arbitrary chunk boundaries, both extended length forms, and EVERY
// section-5 rule as its mandated close code. The fuzz block feeds seeded garbage: the
// contract is frames or ProtocolError - never a crash, never a hang.

import { describe, it, expect } from 'vitest';
import { FrameParser, OPCODE, ProtocolError, closePayload, parseClosePayload, serializeFrame } from '@azerothjs/ws';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function parseAll(bytes: Uint8Array, options?: ConstructorParameters<typeof FrameParser>[0]): ReturnType<FrameParser['push']>
{
    return new FrameParser(options).push(bytes);
}

describe('round-trips and chunking', () =>
{
    it('parses a masked client frame produced by the serializer', () =>
    {
        const frames = parseAll(serializeFrame(OPCODE.text, text('hello'), { mask: true }));
        expect(frames).toHaveLength(1);
        expect(frames[0]!.fin).toBe(true);
        expect(frames[0]!.opcode).toBe(OPCODE.text);
        expect(new TextDecoder().decode(frames[0]!.payload)).toBe('hello');
    });

    it('reassembles frames delivered one byte at a time', () =>
    {
        const wire = serializeFrame(OPCODE.binary, new Uint8Array([1, 2, 3, 250]), { mask: true });
        const parser = new FrameParser();
        const collected = [];
        for (const byte of wire)
        {
            collected.push(...parser.push(new Uint8Array([byte])));
        }
        expect(collected).toHaveLength(1);
        expect([...collected[0]!.payload]).toEqual([1, 2, 3, 250]);
    });

    it('parses multiple frames arriving in one chunk', () =>
    {
        const wire = new Uint8Array([
            ...serializeFrame(OPCODE.text, text('a'), { mask: true }),
            ...serializeFrame(OPCODE.text, text('b'), { mask: true })
        ]);
        const frames = parseAll(wire);
        expect(frames.map((frame) => new TextDecoder().decode(frame.payload))).toEqual(['a', 'b']);
    });

    it('handles 16-bit and 64-bit extended lengths', () =>
    {
        const medium = new Uint8Array(300).fill(7);
        const large = new Uint8Array(70_000).fill(9);
        expect(parseAll(serializeFrame(OPCODE.binary, medium, { mask: true }))[0]!.payload.byteLength).toBe(300);
        expect(parseAll(serializeFrame(OPCODE.binary, large, { mask: true }))[0]!.payload.byteLength).toBe(70_000);
    });

    it('the server serializer emits unmasked frames the client parser accepts', () =>
    {
        const frames = parseAll(serializeFrame(OPCODE.text, text('from server')), { role: 'client' });
        expect(new TextDecoder().decode(frames[0]!.payload)).toBe('from server');
    });
});

describe('every section-5 rule, by close code', () =>
{
    function expectViolation(bytes: Uint8Array, code: number, options?: ConstructorParameters<typeof FrameParser>[0]): void
    {
        try
        {
            parseAll(bytes, options);
            expect.unreachable('the parser accepted a protocol violation');
        }
        catch (error)
        {
            expect(error).toBeInstanceOf(ProtocolError);
            expect((error as ProtocolError).code).toBe(code);
        }
    }

    it('RSV bits without an extension: 1002', () =>
    {
        const wire = serializeFrame(OPCODE.text, text('x'), { mask: true });
        wire[0] = (wire[0] ?? 0) | 0x40; // RSV2
        expectViolation(wire, 1002);
    });

    it('reserved opcodes: 1002', () =>
    {
        for (const opcode of [0x3, 0x7, 0xb, 0xf])
        {
            expectViolation(serializeFrame(opcode, text('x'), { mask: true }), 1002);
        }
    });

    it('a fragmented control frame: 1002', () =>
    {
        expectViolation(serializeFrame(OPCODE.ping, text('x'), { mask: true, fin: false }), 1002);
    });

    it('a control frame over 125 bytes: 1002', () =>
    {
        expectViolation(serializeFrame(OPCODE.ping, new Uint8Array(126), { mask: true }), 1002);
    });

    it('an unmasked client frame: 1002 (and a masked server frame the other way)', () =>
    {
        expectViolation(serializeFrame(OPCODE.text, text('x')), 1002);
        expectViolation(serializeFrame(OPCODE.text, text('x'), { mask: true }), 1002, { role: 'client' });
    });

    it('non-minimal length encodings: 1002', () =>
    {
        // A 5-byte payload spelled with the 16-bit form.
        const nonMinimal16 = new Uint8Array([0x81, 0xfe, 0x00, 0x05, 0, 0, 0, 0, 104, 101, 108, 108, 111]);
        expectViolation(nonMinimal16, 1002);
        // A 300-byte payload spelled with the 64-bit form.
        const nonMinimal64 = new Uint8Array(2 + 8 + 4 + 300);
        nonMinimal64[0] = 0x82;
        nonMinimal64[1] = 0xff;
        new DataView(nonMinimal64.buffer).setBigUint64(2, 300n);
        expectViolation(nonMinimal64, 1002);
    });

    it('a frame above the payload cap: 1009', () =>
    {
        expectViolation(serializeFrame(OPCODE.binary, new Uint8Array(2048), { mask: true }), 1009, { maxPayload: 1024 });
    });
});

describe('close payloads', () =>
{
    it('round-trips code + reason', () =>
    {
        expect(parseClosePayload(closePayload(1000, 'bye'))).toEqual({ code: 1000, reason: 'bye' });
        expect(parseClosePayload(closePayload(4321, ''))).toEqual({ code: 4321, reason: '' });
    });

    it('an empty payload is the internal "none received" 1005', () =>
    {
        expect(parseClosePayload(new Uint8Array(0)).code).toBe(1005);
    });

    it('a 1-byte payload, wire-invalid codes, and non-UTF-8 reasons are violations', () =>
    {
        expect(() => parseClosePayload(new Uint8Array([3]))).toThrow(ProtocolError);
        for (const code of [999, 1004, 1005, 1006, 1015, 2999, 5000])
        {
            expect(() => parseClosePayload(closePayload(code)), `code ${ code }`).toThrow(ProtocolError);
        }
        const badReason = new Uint8Array([0x03, 0xe8, 0xff, 0xfe]);
        expect(() => parseClosePayload(badReason)).toThrow(/UTF-8/);
    });
});

describe('fuzz: garbage in, ProtocolError or frames out', () =>
{
    it('2000 random buffers never crash or hang the parser', () =>
    {
        let state = 0x5eed;
        const random = (): number =>
        {
            state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
            return (state >>> 0) / 0xffffffff;
        };
        for (let i = 0; i < 2000; i++)
        {
            const bytes = new Uint8Array(Math.floor(random() * 64));
            for (let j = 0; j < bytes.length; j++)
            {
                bytes[j] = Math.floor(random() * 256);
            }
            try
            {
                const frames = new FrameParser({ maxPayload: 4096 }).push(bytes);
                expect(Array.isArray(frames)).toBe(true);
            }
            catch (error)
            {
                expect(error, `iteration ${ i }`).toBeInstanceOf(ProtocolError);
            }
        }
    });
});
