/**
 * MODULE: compiler/sourcemap - a minimal Source Map v3 generator (zero dependency)
 *
 * Only LINE-LEVEL mappings are produced - what stack traces use: one segment at the start of each
 * generated line, pointing back into the `.azeroth` source. This is accurate because the transform
 * leaves non-markup byte-for-byte: a generated line that came from verbatim source maps 1:1; a
 * generated line inside a compiled markup region maps to that region's starting position.
 *
 * These are small, pure public utilities (re-exported from the package index); each carries a concise
 * JSDoc + example rather than a full block.
 *
 * @see {@link encodeMappings} - assemble the `mappings` string
 * @see {@link vlqEncode} - the base64 VLQ number format
 */

/** A Source Map v3 object (the shape tools and Vite expect). */
export interface SourceMapV3
{
    version: 3;
    sources: string[];
    sourcesContent: string[];
    names: string[];
    mappings: string;
}

/** One mapping segment: a generated column to a source position. */
export interface RawSegment
{
    genColumn: number;
    sourceLine: number;
    sourceColumn: number;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Encodes a signed integer as a base64 VLQ (the source-map number format).
 *
 * @param value - The signed integer to encode.
 * @returns The base64 VLQ string.
 * @example
 * ```ts
 * vlqEncode(0);  // 'A'
 * vlqEncode(1);  // 'C' (1 << 1 = 2 -> base64 'C')
 * vlqEncode(-1); // 'D' (sign bit set -> 3 -> base64 'D')
 * ```
 */
export function vlqEncode(value: number): string
{
    // Sign goes in the least-significant bit.
    let vlq = value < 0 ? ((-value) << 1) | 1 : value << 1;
    let out = '';
    do
    {
        let digit = vlq & 0b11111;
        vlq >>>= 5;
        if (vlq > 0)
        {
            digit |= 0b100000; // continuation bit
        }
        out += BASE64[digit] ?? '';
    } while (vlq > 0);
    return out;
}

/**
 * Offsets at which each line of `text` begins (index 0 = line 0).
 *
 * @param text - The source text.
 * @returns The byte offset where each line starts.
 * @example
 * ```ts
 * buildLineStarts('ab\ncd\n'); // [0, 3, 6]
 * ```
 */
export function buildLineStarts(text: string): number[]
{
    const starts = [0];
    for (let i = 0; i < text.length; i++)
    {
        if (text[i] === '\n')
        {
            starts.push(i + 1);
        }
    }
    return starts;
}

/**
 * Converts a byte offset to a 0-based `{ line, column }` location (binary search over `lineStarts`).
 *
 * @param offset - The byte offset into the source.
 * @param lineStarts - Line-start offsets from {@link buildLineStarts}.
 * @returns The 0-based line and column.
 * @example
 * ```ts
 * const starts = buildLineStarts('ab\ncd\n'); // [0, 3, 6]
 * locationFor(4, starts); // { line: 1, column: 1 } (the 'd' on line 1)
 * ```
 */
export function locationFor(offset: number, lineStarts: number[]): { line: number; column: number }
{
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi)
    {
        const mid = (lo + hi + 1) >> 1;
        if ((lineStarts[mid] ?? 0) <= offset)
        {
            lo = mid;
        }
        else
        {
            hi = mid - 1;
        }
    }
    return { line: lo, column: offset - (lineStarts[lo] ?? 0) };
}

/**
 * Encodes per-line segment lists into the `mappings` string.
 * `genColumn` is relative within a line (reset each line); the
 * source fields are relative across the whole file, per the spec.
 * A single source (index 0) is assumed.
 *
 * @param lines - Per-generated-line segment lists.
 * @returns The encoded `mappings` string (`;`-separated lines, `,`-separated segments).
 * @example
 * ```ts
 * encodeMappings([
 *     [{ genColumn: 0, sourceLine: 0, sourceColumn: 0 }], // line 0 -> source 0:0
 *     [{ genColumn: 0, sourceLine: 1, sourceColumn: 0 }]  // line 1 -> source 1:0
 * ]);
 * // 'AAAA;AACA' (one ';'-separated segment per generated line)
 * ```
 */
export function encodeMappings(lines: RawSegment[][]): string
{
    let prevSourceLine = 0;
    let prevSourceColumn = 0;
    const encodedLines: string[] = [];

    for (const segments of lines)
    {
        let prevGenColumn = 0;
        const encoded: string[] = [];
        for (const seg of segments)
        {
            let chunk = vlqEncode(seg.genColumn - prevGenColumn);
            prevGenColumn = seg.genColumn;
            chunk += vlqEncode(0); // sourceIndex delta (always 0 - one source)
            chunk += vlqEncode(seg.sourceLine - prevSourceLine);
            prevSourceLine = seg.sourceLine;
            chunk += vlqEncode(seg.sourceColumn - prevSourceColumn);
            prevSourceColumn = seg.sourceColumn;
            encoded.push(chunk);
        }
        encodedLines.push(encoded.join(','));
    }

    return encodedLines.join(';');
}

/** Base64 character -> value, for {@link decodeMappings}. Built once. */
const BASE64_VALUES: Record<string, number> = Object.fromEntries(BASE64.split('').map((c, i) => [c, i]));

/**
 * Decodes a `mappings` string back into per-line absolute segments - the inverse of
 * {@link encodeMappings}, for rewriting an EXISTING map (e.g. remapping TypeScript's declaration
 * map from projected-code positions to `.azeroth` source positions). Single-source maps only
 * (source index 0); a 5-field segment's name index is dropped, and 1-field segments (a generated
 * position with no source) are skipped since they carry nothing to remap.
 *
 * @param mappings - The `mappings` string of a version-3 source map.
 * @returns Per-generated-line segments with ABSOLUTE positions.
 */
export function decodeMappings(mappings: string): RawSegment[][]
{
    const lines: RawSegment[][] = [];
    let sourceLine = 0;
    let sourceColumn = 0;

    for (const lineText of mappings.split(';'))
    {
        const segments: RawSegment[] = [];
        let genColumn = 0;
        for (const chunk of lineText === '' ? [] : lineText.split(','))
        {
            // Base64 VLQ decode: little-endian 5-bit groups, bit 5 = continuation, bit 0 = sign.
            const values: number[] = [];
            let value = 0;
            let shift = 0;
            for (const char of chunk)
            {
                const digit = BASE64_VALUES[char] ?? 0;
                value |= (digit & 31) << shift;
                if ((digit & 32) !== 0)
                {
                    shift += 5;
                    continue;
                }
                values.push((value & 1) === 1 ? -(value >>> 1) : value >>> 1);
                value = 0;
                shift = 0;
            }
            genColumn += values[0] ?? 0;
            if (values.length >= 4)
            {
                sourceLine += values[2] ?? 0;
                sourceColumn += values[3] ?? 0;
                segments.push({ genColumn, sourceLine, sourceColumn });
            }
        }
        lines.push(segments);
    }

    return lines;
}
