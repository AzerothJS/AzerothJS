// ============================================================================
// AZEROTHJS COMPILER — Source Maps (from scratch, no deps)
// ============================================================================
//
// A minimal Source Map v3 generator. We only need LINE-level
// mappings, which is what stack traces use: one segment at the start
// of each generated line, pointing back into the `.azeroth` source.
//
// It's accurate because the transform leaves non-markup byte-for-
// byte: a generated line that came from verbatim source maps 1:1;
// a generated line inside a compiled markup region maps to that
// region's starting position.
//
// ============================================================================

/** A Source Map v3 object (the shape tools and Vite expect). */
export interface SourceMapV3
{
    version: 3;
    sources: string[];
    sourcesContent: string[];
    names: string[];
    mappings: string;
}

/** One mapping segment: a generated column → a source position. */
export interface RawSegment
{
    genColumn: number;
    sourceLine: number;
    sourceColumn: number;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Encodes a signed integer as a base64 VLQ (the source-map number format). */
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
        out += BASE64[digit];
    } while (vlq > 0);
    return out;
}

/** Offsets at which each line of `text` begins (index 0 = line 0). */
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

/** Converts a byte offset to a 0-based `{ line, column }` location. */
export function locationFor(offset: number, lineStarts: number[]): { line: number; column: number }
{
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi)
    {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset)
        {
            lo = mid;
        }
        else
        {
            hi = mid - 1;
        }
    }
    return { line: lo, column: offset - lineStarts[lo] };
}

/**
 * Encodes per-line segment lists into the `mappings` string.
 * `genColumn` is relative within a line (reset each line); the
 * source fields are relative across the whole file, per the spec.
 * A single source (index 0) is assumed.
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
            chunk += vlqEncode(0); // sourceIndex delta (always 0 — one source)
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
