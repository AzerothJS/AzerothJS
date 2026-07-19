/**
 * MODULE: compiler/mapping - bidirectional offset mapping between an original `.azeroth` source and the
 * virtual TypeScript module the projection produces.
 *
 * The mapping is a list of VERBATIM segments - spans of user-authored text that appear byte-for-byte in
 * both documents (the script outside markup, the code inside `{ ... }` holes, attribute expressions,
 * component tag names, declaration names/initializers). Because those spans are copied 1:1, a position
 * inside one translates by a simple additive shift. Generated scaffolding (the `function Name(` / `h('div', {`
 * a construct expands to) has no segment, so positions there don't map back - which is exactly right:
 * there is no original character to point at.
 *
 * Every tool that turns positions/diagnostics from the virtual module back into the source - the editor
 * language service, the TypeScript-backed type checker, the ESLint processor - flows through here.
 */

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
 * An immutable mapping built by the projection. Lookups are binary searches over the segment list
 * (sorted by start), so translating the many locations a "find references" can return stays cheap.
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
    readonly #bySource: MappingSegment[];

    /** Segments sorted by `generatedStart` (for generated -> original). */
    readonly #byGenerated: MappingSegment[];

    constructor(segments: MappingSegment[])
    {
        this.#bySource = [...segments].sort((a, b) => a.sourceStart - b.sourceStart);
        this.#byGenerated = [...segments].sort((a, b) => a.generatedStart - b.generatedStart);
    }

    /**
     * Maps an offset in the original source to the virtual module, or `null` when it falls in non-mapped
     * generated scaffolding. A position touching a segment's exclusive end still maps (so a caret right
     * after an identifier resolves), preferring the segment that actually contains it.
     */
    public toGenerated(sourceOffset: number): number | null
    {
        const seg = CodeMapping.#find(this.#bySource, sourceOffset, segment => segment.sourceStart, segment => segment.sourceEnd);
        if (seg === null)
        {
            return null;
        }
        return seg.generatedStart + (sourceOffset - seg.sourceStart);
    }

    /**
     * Maps an offset in the virtual module back to the original source, or `null` when it lands in
     * generated scaffolding with no original origin.
     */
    public toOriginal(generatedOffset: number): number | null
    {
        const seg = CodeMapping.#find(this.#byGenerated, generatedOffset, segment => segment.generatedStart, segment => segment.generatedEnd);
        if (seg === null)
        {
            return null;
        }
        return seg.sourceStart + (generatedOffset - seg.generatedStart);
    }

    /**
     * Maps an original `[start, end)` range to the virtual module. Returns `null` unless both ends land
     * in the *same* segment, which guarantees the translated range is contiguous and meaningful (e.g. a
     * rename edit).
     */
    public toGeneratedRange(sourceStart: number, sourceEnd: number): { start: number; end: number } | null
    {
        const seg = CodeMapping.#find(this.#bySource, sourceStart, segment => segment.sourceStart, segment => segment.sourceEnd);
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
     * Maps a virtual `[start, end)` range back to the original source. Both ends must share a segment;
     * otherwise the range straddles generated scaffolding and has no faithful original counterpart.
     */
    public toOriginalRange(generatedStart: number, generatedEnd: number): { start: number; end: number } | null
    {
        const seg = CodeMapping.#find(this.#byGenerated, generatedStart, segment => segment.generatedStart, segment => segment.generatedEnd);
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
     * The original offset of the nearest mapped segment at or before `generatedOffset`. Anchors a
     * diagnostic that lands purely in generated scaffolding (no exact original origin) to the closest
     * real code - e.g. a component-call argument error on the generated `({ ... })` is anchored to the
     * copied component tag that precedes it. Returns `null` if nothing precedes the offset.
     */
    public nearestSourceBefore(generatedOffset: number): number | null
    {
        const seg = this.nearestSegmentBefore(generatedOffset);
        return seg === null ? null : seg.sourceStart;
    }

    /** The segment whose generated span contains `generatedOffset`, or `null` (a scaffolding position). */
    public segmentAt(generatedOffset: number): MappingSegment | null
    {
        return CodeMapping.#find(this.#byGenerated, generatedOffset, segment => segment.generatedStart, segment => segment.generatedEnd);
    }

    /**
     * The nearest mapped segment at or before `generatedOffset` - anchors a diagnostic that lands purely
     * in generated scaffolding (e.g. a missing-prop error on the synthesized `({ ... })`) to the closest
     * real code (the component tag that precedes it). Returns `null` if nothing precedes the offset.
     */
    public nearestSegmentBefore(generatedOffset: number): MappingSegment | null
    {
        let best: MappingSegment | null = null;
        for (const seg of this.#byGenerated)
        {
            if (seg.generatedStart > generatedOffset)
            {
                break;
            }
            best = seg;
        }
        return best;
    }

    /**
     * Binary-searches `segments` (sorted by `start`) for the one whose `[start, end]` span contains
     * `offset`, preferring a span that strictly contains it over one it only touches at the exclusive end.
     *
     * We locate the RIGHTMOST segment that starts at or before `offset`, then accept it if `offset`
     * falls within (or touches the end of) its span. This is what makes a shared boundary resolve
     * correctly: where one segment's exclusive end equals the next segment's start (e.g. mapped script
     * `return ` abutting the `<Component` tag, since the `<` emits nothing), the offset sits at the END
     * of the earlier segment but at the START of the later one. The rightmost-start rule selects the
     * later segment, which actually contains the offset - so a position on the component name maps to
     * the tag, not one character early onto the `<`. A bare end-touch (no later segment starts there,
     * e.g. a caret right after an identifier) still resolves to the segment it touches. Segments never
     * overlap within a coordinate space apart from such shared boundaries, so the rightmost candidate is
     * always the right one.
     */
    static #find(segments: MappingSegment[], offset: number, start: (segment: MappingSegment) => number, end: (segment: MappingSegment) => number): MappingSegment | null
    {
        let lo = 0;
        let hi = segments.length - 1;
        let candidate: MappingSegment | null = null;

        // Rightmost segment with start(seg) <= offset.
        while (lo <= hi)
        {
            const mid = (lo + hi) >> 1;
            const segment = segments[mid];
            if (segment !== undefined && start(segment) <= offset)
            {
                candidate = segment;
                lo = mid + 1;
            }
            else
            {
                hi = mid - 1;
            }
        }

        // Accept it only if offset lies within its span (strict, or touching the exclusive end);
        // a larger offset means offset sits in a non-mapped gap after the last preceding segment.
        return candidate !== null && offset <= end(candidate) ? candidate : null;
    }
}
