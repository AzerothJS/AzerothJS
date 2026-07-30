// @vitest-environment node
//
// Which frames an application sees before a protocol violation depended on how the peer split its
// TCP segments - and the peer chooses that. `push()` accumulates frames in a local array and
// throws when it reaches the bad one, so everything parsed earlier IN THAT CALL was discarded with
// the array; the same bytes arriving in separate segments had already been returned and delivered.
// A fuzz run put it at 6,204 of 50,000 cases.
//
// No capability is gained by an attacker - they choose whether to send the malformed frame at all
// - so this is a determinism defect rather than an exploit. But it contradicts the rule socket.ts
// already states for the `[close][text]` case at #receive: everything up to the terminating event
// is delivered, nothing after it. A frame that was completely and validly received BEFORE the
// violation arrived while the connection was still healthy, so it is delivered - identically,
// whatever the segmentation.
import { describe, expect, it } from 'vitest';

import { FrameParser, ProtocolError, serializeFrame } from '../src/frames.ts';

const decoder = new TextDecoder();

/** A masked client frame, as a server parser requires. */
function clientFrame(text: string, opcode = 0x1): Uint8Array
{
    return serializeFrame(opcode, new TextEncoder().encode(text), { mask: true });
}

/** RSV1 set: a protocol violation with no negotiated extension. */
function violation(): Uint8Array
{
    const frame = clientFrame('never');
    const first = frame[0] ?? 0;
    frame[0] = first | 0x40;
    return frame;
}

function concat(parts: Uint8Array[]): Uint8Array
{
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts)
    {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** Drives the parser in `sizes`-byte slices, collecting what the application would have seen. */
function deliveredBy(bytes: Uint8Array, chunk: number): { delivered: string[]; code: number | null }
{
    const parser = new FrameParser({ maxPayload: 1 << 20 });
    const delivered: string[] = [];
    for (let i = 0; i < bytes.length; i += chunk)
    {
        try
        {
            for (const frame of parser.push(bytes.subarray(i, Math.min(i + chunk, bytes.length))))
            {
                delivered.push(decoder.decode(frame.payload));
            }
        }
        catch (error)
        {
            if (error instanceof ProtocolError)
            {
                for (const frame of error.frames)
                {
                    delivered.push(decoder.decode(frame.payload));
                }
                return { delivered, code: error.code };
            }
            throw error;
        }
    }
    return { delivered, code: null };
}

describe('frame delivery does not depend on how the peer split its segments', () =>
{
    it('delivers the same frames whether the violation arrives with them or after them', () =>
    {
        const bytes = concat([clientFrame('one'), clientFrame('two'), violation()]);

        const wholeSegment = deliveredBy(bytes, bytes.length);
        const dripFed = deliveredBy(bytes, 1);

        expect(wholeSegment.delivered).toEqual(['one', 'two']);
        expect(dripFed.delivered).toEqual(['one', 'two']);
        expect(wholeSegment.code).toBe(1002);
        expect(dripFed.code).toBe(1002);
    });

    it('agrees across every segment size', () =>
    {
        const bytes = concat([clientFrame('a'), clientFrame('b'), clientFrame('c'), violation()]);
        const expected = ['a', 'b', 'c'];

        for (const chunk of [1, 2, 3, 5, 7, 11, bytes.length])
        {
            const result = deliveredBy(bytes, chunk);
            expect(result.delivered, `chunk size ${ chunk }`).toEqual(expected);
            expect(result.code, `chunk size ${ chunk }`).toBe(1002);
        }
    });

    it('carries nothing when the violation is the very first frame', () =>
    {
        const result = deliveredBy(violation(), 64);

        expect(result.delivered).toEqual([]);
        expect(result.code).toBe(1002);
    });

    it('never carries a frame that came AFTER the violation', () =>
    {
        const bytes = concat([clientFrame('before'), violation(), clientFrame('after')]);

        expect(deliveredBy(bytes, bytes.length).delivered).toEqual(['before']);
        expect(deliveredBy(bytes, 1).delivered).toEqual(['before']);
    });
});
