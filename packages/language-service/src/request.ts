// Per-request context and the glue that translates TypeScript results (which
// live in virtual-file offsets) back into the original `.azeroth` document
// (line/character ranges). Every provider takes a RequestContext and leans on
// these helpers so the offset bookkeeping lives in exactly one place.

import ts from 'typescript';
import type { Location, Range } from './protocol.ts';
import { LineIndex } from './text.ts';
import { pathToUri } from './uri.ts';
import type {
    AzerothProject } from './ts-project.ts';
import {
    isVirtualFile,
    toAzerothPath,
    toVirtualFile
} from './ts-project.ts';
import type { VirtualCode } from './virtual-code.ts';

/** Everything a provider needs to answer one request about one document. */
export interface RequestContext
{
    project: AzerothProject;
    /** The `.azeroth` document URI. */
    uri: string;
    /** Filesystem path of the `.azeroth` document. */
    azerothPath: string;
    /** Synthetic virtual TS file name TypeScript knows it by. */
    virtualFile: string;
    /** Original source text. */
    source: string;
    /** Compiled virtual module + offset mapping. */
    virtual: VirtualCode;
    /** Line index over the original source. */
    lineIndex: LineIndex;
}

/** Maps an original offset to the virtual module, or null if unmapped. */
export function toGenerated(ctx: RequestContext, offset: number): number | null
{
    return ctx.virtual.mapping.toGenerated(offset);
}

/**
 * Maps a TS text span in *this* document's virtual module back to an original
 * range, or null when it covers generated scaffolding.
 */
export function spanToRange(ctx: RequestContext, span: ts.TextSpan): Range | null
{
    const mapped = ctx.virtual.mapping.toOriginalRange(span.start, span.start + span.length);
    if (mapped === null)
    {
        return null;
    }
    return ctx.lineIndex.rangeAt(mapped.start, mapped.end);
}

/**
 * Resolves a TS document span (possibly in another file) to an editor Location.
 * Virtual files map back through their own mapping and report the `.azeroth`
 * URI; real files report directly.
 */
export function resolveLocation(project: AzerothProject, fileName: string, span: ts.TextSpan): Location | null
{
    if (isVirtualFile(fileName))
    {
        const azerothPath = toAzerothPath(fileName);
        const virtual = project.getVirtual(azerothPath);
        const mapped = virtual.mapping.toOriginalRange(span.start, span.start + span.length);
        if (mapped === null)
        {
            return null;
        }
        const lineIndex = new LineIndex(project.getSource(azerothPath) ?? '');
        return { uri: pathToUri(azerothPath), range: lineIndex.rangeAt(mapped.start, mapped.end) };
    }

    const text = ts.sys.readFile(fileName);
    if (text === undefined)
    {
        return null;
    }
    const lineIndex = new LineIndex(text);
    return { uri: pathToUri(fileName), range: lineIndex.rangeAt(span.start, span.start + span.length) };
}

/** The deepest TypeScript node whose span contains `pos`, for a checker query at a generated offset. */
export function tokenAt(sourceFile: ts.SourceFile, pos: number): ts.Node | undefined
{
    const find = (node: ts.Node): ts.Node | undefined =>
    {
        if (pos < node.getStart(sourceFile) || pos >= node.getEnd())
        {
            return undefined;
        }
        return ts.forEachChild(node, find) ?? node;
    };
    return find(sourceFile);
}

/** Re-exports so providers import file-name helpers from one place. */
export { isVirtualFile, toAzerothPath, toVirtualFile };
