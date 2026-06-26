// @vitest-environment node
//
// Real-execution coverage for the zero-dependency Source Map v3 generator:
// base64 VLQ encoding, line-start indexing, offset->location, and the relative
// per-line/per-file mappings encoding.
import { describe, it, expect } from 'vitest';
import {
    vlqEncode,
    buildLineStarts,
    locationFor,
    encodeMappings
} from '@azerothjs/compiler';

describe('vlqEncode', () =>
{
    it('encodes zero and small positive values', () =>
    {
        expect(vlqEncode(0)).toBe('A');
        expect(vlqEncode(1)).toBe('C');
        expect(vlqEncode(2)).toBe('E');
    });

    it('puts the sign in the least-significant bit for negatives', () =>
    {
        expect(vlqEncode(-1)).toBe('D');
    });

    it('uses a continuation digit for values that need more than 5 bits', () =>
    {
        // 16 << 1 = 32 -> needs two base64 digits.
        const encoded = vlqEncode(16);
        expect(encoded.length).toBeGreaterThan(1);
        expect(encoded).toBe('gB');
    });
});

describe('buildLineStarts', () =>
{
    it('returns the offset at which each line begins', () =>
    {
        expect(buildLineStarts('ab\ncd\n')).toEqual([0, 3, 6]);
    });

    it('always includes line 0 even for empty input', () =>
    {
        expect(buildLineStarts('')).toEqual([0]);
        expect(buildLineStarts('noeol')).toEqual([0]);
    });
});

describe('locationFor', () =>
{
    it('maps an offset to its 0-based line and column', () =>
    {
        const starts = buildLineStarts('ab\ncd\n');
        expect(locationFor(0, starts)).toEqual({ line: 0, column: 0 });
        expect(locationFor(4, starts)).toEqual({ line: 1, column: 1 });
        expect(locationFor(2, starts)).toEqual({ line: 0, column: 2 });
    });

    it('maps an offset on the third line correctly', () =>
    {
        const starts = buildLineStarts('a\nbb\nccc');
        expect(locationFor(7, starts)).toEqual({ line: 2, column: 2 });
    });
});

describe('encodeMappings', () =>
{
    it('emits one ;-separated group per generated line', () =>
    {
        const result = encodeMappings([
            [{ genColumn: 0, sourceLine: 0, sourceColumn: 0 }],
            [{ genColumn: 0, sourceLine: 1, sourceColumn: 0 }]
        ]);
        expect(result).toBe('AAAA;AACA');
    });

    it('encodes genColumn relative within a line and source fields relative across the file', () =>
    {
        const result = encodeMappings([
            [
                { genColumn: 0, sourceLine: 0, sourceColumn: 0 },
                { genColumn: 4, sourceLine: 0, sourceColumn: 4 }
            ]
        ]);
        // Two comma-separated segments on one line.
        expect(result.split(';')).toHaveLength(1);
        expect(result.split(',')).toHaveLength(2);
        // First segment is the all-zero AAAA; second carries deltas.
        expect(result.startsWith('AAAA,')).toBe(true);
    });

    it('produces an empty string for no lines', () =>
    {
        expect(encodeMappings([])).toBe('');
    });
});
