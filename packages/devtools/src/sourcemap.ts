// Maps a stack-frame position back through the served module's source map.
//
// `Error.stack` is never source-mapped - browsers apply maps when PRINTING a
// trace, not to the `.stack` string - so every frame the agent captures carries
// a position in the TRANSFORMED module Vite serves, while the panel's
// open-in-editor path points into the original `.azeroth` file. Pasting a
// generated line onto a source path lands go-to-file on whatever happens to sit
// there: a divider comment, a neighboring declaration.
//
// The dev server already serves the truth. Each transformed module ends with an
// inline `//# sourceMappingURL=` data URI carrying the chained compiler+oxc map,
// and the compiler's per-line bookkeeping resolves every lowered creation call
// to its declaration's real line. This module fetches that map once per module
// URL, decodes the VLQ mappings, and answers position lookups; on ANY failure a
// lookup resolves `null` and the caller keeps the raw frame - attribution can
// only get more precise, never break.

/** A 1-based line/column in the ORIGINAL source. */
export interface MappedPosition
{
    line: number;
    column: number;
}

/** Resolves a generated (1-based) position in the module at `url` to its source position. */
export type PositionResolver = (url: string, line: number, column: number) => Promise<MappedPosition | null>;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decodes a source map `mappings` string into per-generated-line segments of
 * `[generatedColumn, sourceLine, sourceColumn]`, all 0-based. Segments without
 * a source (1-field) are decoded for state but not emitted - they cannot answer
 * a lookup. Field state (source index, line, column) persists across lines per
 * the spec; the source index is tracked only to keep the VLQ stream aligned.
 *
 * @param mappings - The `mappings` field of a source map v3.
 * @returns One segment array per generated line.
 * @internal
 */
export function decodeMappedLines(mappings: string): [number, number, number][][]
{
    const lines: [number, number, number][][] = [];
    let current: [number, number, number][] = [];
    let genCol = 0;
    let srcLine = 0;
    let srcCol = 0;
    let fields: number[] = [];
    let value = 0;
    let shift = 0;

    // Ends the pending segment: 4/5-field segments advance the source position
    // (field 1, the source index, is delta-decoded for stream alignment but a
    // single-source module never moves it); 1-field segments advance only the
    // generated column.
    const flush = (): void =>
    {
        if (fields.length >= 4)
        {
            genCol += fields[0] ?? 0;
            srcLine += fields[2] ?? 0;
            srcCol += fields[3] ?? 0;
            current.push([genCol, srcLine, srcCol]);
        }
        else if (fields.length === 1)
        {
            genCol += fields[0] ?? 0;
        }
        fields = [];
    };

    for (const ch of mappings)
    {
        if (ch === ',' || ch === ';')
        {
            flush();
            if (ch === ';')
            {
                lines.push(current);
                current = [];
                genCol = 0;
            }
            continue;
        }
        const digit = BASE64.indexOf(ch);
        if (digit === -1)
        {
            return lines;
        }
        value += (digit & 31) << shift;
        if ((digit & 32) !== 0)
        {
            shift += 5;
            continue;
        }
        fields.push((value & 1) === 1 ? -(value >>> 1) : value >>> 1);
        value = 0;
        shift = 0;
    }
    flush();
    lines.push(current);
    return lines;
}

/**
 * The greatest-lower-bound lookup every source-map consumer performs: the last
 * segment on the generated line whose column is <= the wanted column, falling
 * back to the line's first segment (a frame column can point mid-token, before
 * the first mapping). A generated line with no mapped segments answers `null`.
 *
 * @param lines - Decoded segments from {@link decodeMappedLines}.
 * @param line - Generated line, 1-based (stack-frame convention).
 * @param column - Generated column, 1-based.
 * @returns The 1-based original position, or `null` when the line is unmapped.
 * @internal
 */
export function lookupPosition(lines: [number, number, number][][], line: number, column: number): MappedPosition | null
{
    const segments = lines[line - 1];
    if (segments === undefined || segments.length === 0)
    {
        return null;
    }
    let best = segments[0];
    for (const seg of segments)
    {
        if (seg[0] > column - 1)
        {
            break;
        }
        best = seg;
    }
    return best === undefined ? null : { line: best[1] + 1, column: best[2] + 1 };
}

/**
 * Extracts and decodes the module's trailing `//# sourceMappingURL=` into a
 * decoded mapping table. Inline data URIs (what Vite serves in dev) decode in
 * place; a relative URL is fetched against the module's own URL.
 *
 * @param moduleText - The served module source.
 * @param moduleUrl - The module's URL, for resolving a relative map reference.
 * @param fetchText - Text fetcher, injectable for tests.
 * @returns Decoded mapped lines, or `null` when no usable map is present.
 */
async function loadMap(
    moduleText: string,
    moduleUrl: string,
    fetchText: (url: string) => Promise<string>
): Promise<[number, number, number][][] | null>
{
    // The LAST reference wins: a module that embeds another module's text as a
    // string may contain earlier, inert occurrences.
    const at = moduleText.lastIndexOf('sourceMappingURL=');
    if (at === -1)
    {
        return null;
    }
    const ref = (/^([^\s]+)/.exec(moduleText.slice(at + 'sourceMappingURL='.length)) ?? [])[1] ?? '';
    let json: string;
    const inline = /^data:application\/json[^,]*;base64,(.*)$/.exec(ref);
    if (inline !== null)
    {
        json = atob(inline[1] ?? '');
    }
    else if (ref !== '')
    {
        json = await fetchText(new URL(ref, moduleUrl).href);
    }
    else
    {
        return null;
    }
    const map = JSON.parse(json) as { mappings?: string };
    return typeof map.mappings === 'string' ? decodeMappedLines(map.mappings) : null;
}

/**
 * Builds a memoized {@link PositionResolver}. Each module URL is fetched and
 * decoded once - a mount burst creating hundreds of nodes from one component
 * shares a single in-flight promise - and a failed load is memoized as `null`
 * so a missing map costs one attempt, not one per node. HMR needs no
 * invalidation: Vite stamps updated modules with a fresh `?t=` query, which is
 * a fresh cache key here.
 *
 * @param fetchText - Text fetcher, injectable for tests; defaults to `fetch`.
 * @returns The resolver.
 */
export function createPositionResolver(
    fetchText: (url: string) => Promise<string> = async (url) => (await fetch(url)).text()
): PositionResolver
{
    const cache = new Map<string, Promise<[number, number, number][][] | null>>();
    return async (url, line, column) =>
    {
        if (!/^https?:/.test(url))
        {
            return null;
        }
        let entry = cache.get(url);
        if (entry === undefined)
        {
            entry = fetchText(url)
                .then((text) => loadMap(text, url, fetchText))
                .catch(() => null);
            cache.set(url, entry);
        }
        const lines = await entry;
        return lines === null ? null : lookupPosition(lines, line, column);
    };
}
