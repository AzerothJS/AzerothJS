// Bidirectional offset mapping between an original `.azeroth` source and the
// virtual TypeScript module the language service type-checks against.
//
// The mapping is a sorted list of *verbatim* segments - spans of user-authored
// text that appear byte-for-byte in both documents (the script outside markup,
// the code inside `{ ... }` holes, attribute expressions, component tag names).
// Because those spans are copied 1:1, a position inside one translates by a
// simple additive shift. Generated scaffolding (the `h('div', { ... })` a
// markup region expands to) has no segment, so positions there don't map back -
// which is exactly right: there is no original character to point at.
//
// Everything the TypeScript bridge does flows through here: a request arrives
// at an original offset, `toGenerated` finds where to ask TS, and `toOriginal`
// translates each location TS hands back.

/** Why a segment exists - useful for debugging and for the markup layer. */
export type MappingKind = 'script' | 'expression' | 'attribute' | 'tag' | 'text';

/**
 * One verbatim span. The two ranges have equal length, so any offset `o` with
 * `sourceStart <= o <= sourceEnd` maps to `generatedStart + (o - sourceStart)`.
 */
export interface MappingSegment
{
    sourceStart: number;
    sourceEnd: number;
    generatedStart: number;
    generatedEnd: number;
    kind: MappingKind;
}

/**
 * An immutable mapping built by the virtual-code generator. Lookups are binary
 * searches over the segment list (sorted by start), so translating the many
 * locations a "find references" can return stays cheap.
 *
 * @example
 * ```ts
 * const map = new CodeMapping([
 *     { sourceStart: 0, sourceEnd: 10, generatedStart: 40, generatedEnd: 50, kind: 'script' }
 * ]);
 * map.toGenerated(3); // 43
 * map.toOriginal(43); // 3
 * ```
 */
export class CodeMapping
{
    /** Segments sorted by `sourceStart` (for original -> generated). */
    private readonly bySource: MappingSegment[];

    /** Segments sorted by `generatedStart` (for generated -> original). */
    private readonly byGenerated: MappingSegment[];

    constructor(segments: MappingSegment[])
    {
        this.bySource = [...segments].sort((a, b) => a.sourceStart - b.sourceStart);
        this.byGenerated = [...segments].sort((a, b) => a.generatedStart - b.generatedStart);
    }

    /**
     * Maps an offset in the original source to the virtual module, or `null`
     * when it falls in non-mapped generated scaffolding. A position touching a
     * segment's exclusive end still maps (so a caret right after an identifier
     * resolves), preferring the segment that actually contains it.
     */
    public toGenerated(sourceOffset: number): number | null
    {
        const seg = CodeMapping.find(this.bySource, sourceOffset, segment => segment.sourceStart, segment => segment.sourceEnd);
        if (seg === null)
        {
            return null;
        }
        return seg.generatedStart + (sourceOffset - seg.sourceStart);
    }

    /**
     * Maps an offset in the virtual module back to the original source, or
     * `null` when it lands in generated scaffolding with no original origin.
     */
    public toOriginal(generatedOffset: number): number | null
    {
        const seg = CodeMapping.find(this.byGenerated, generatedOffset, segment => segment.generatedStart, segment => segment.generatedEnd);
        if (seg === null)
        {
            return null;
        }
        return seg.sourceStart + (generatedOffset - seg.generatedStart);
    }

    /**
     * Maps an original `[start, end)` range to the virtual module. Returns
     * `null` unless both ends land in the *same* segment, which guarantees the
     * translated range is contiguous and meaningful (e.g. a rename edit).
     */
    public toGeneratedRange(sourceStart: number, sourceEnd: number): { start: number; end: number } | null
    {
        const seg = CodeMapping.find(this.bySource, sourceStart, segment => segment.sourceStart, segment => segment.sourceEnd);
        if (seg === null || sourceEnd > seg.sourceEnd)
        {
            return null;
        }
        return {
            start: seg.generatedStart + (sourceStart - seg.sourceStart),
            end: seg.generatedStart + (sourceEnd - seg.sourceStart)
        };
    }

    /**
     * Maps a virtual `[start, end)` range back to the original source. Both
     * ends must share a segment; otherwise the range straddles generated
     * scaffolding and has no faithful original counterpart.
     */
    public toOriginalRange(generatedStart: number, generatedEnd: number): { start: number; end: number } | null
    {
        const seg = CodeMapping.find(this.byGenerated, generatedStart, segment => segment.generatedStart, segment => segment.generatedEnd);
        if (seg === null || generatedEnd > seg.generatedEnd)
        {
            return null;
        }
        return {
            start: seg.sourceStart + (generatedStart - seg.generatedStart),
            end: seg.sourceStart + (generatedEnd - seg.generatedStart)
        };
    }

    /**
     * Binary-searches `segments` (sorted by `start`) for the one whose
     * `[start, end]` span contains `offset`, preferring a span that strictly
     * contains it over one it only touches at the end.
     */
    private static find(
        segments: MappingSegment[],
        offset: number,
        start: (segment: MappingSegment) => number,
        end: (segment: MappingSegment) => number
    ): MappingSegment | null
    {
        let lo = 0;
        let hi = segments.length - 1;
        let touch: MappingSegment | null = null;

        while (lo <= hi)
        {
            const mid = (lo + hi) >> 1;
            const seg = segments[mid];
            if (offset < start(seg))
            {
                hi = mid - 1;
            }
            else if (offset > end(seg))
            {
                lo = mid + 1;
            }
            else
            {
                // Inside the span. An exact hit on the exclusive end is kept as
                // a fallback but we keep scanning left for a strict container.
                if (offset < end(seg))
                {
                    return seg;
                }
                touch = seg;
                hi = mid - 1;
            }
        }

        return touch;
    }
}
