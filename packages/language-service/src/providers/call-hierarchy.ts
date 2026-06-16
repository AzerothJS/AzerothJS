// Call hierarchy: prepare a node at the caret, then walk its callers (incoming)
// or callees (outgoing). Like navigation.ts, every query runs against the
// virtual module and every span TypeScript hands back is mapped to the original
// `.azeroth` source. The follow-up incoming/outgoing requests don't carry a
// position, only the prepared item, so each item stashes its originating URI and
// source offset in `data`; that offset is re-mapped to the virtual module to
// re-query TypeScript.

import ts from 'typescript';
import {
    SymbolKind,
    type CallHierarchyIncomingCall,
    type CallHierarchyItem,
    type CallHierarchyOutgoingCall,
    type Range,
    type SymbolKindValue
} from '../protocol.ts';
import { LineIndex } from '../text.ts';
import { pathToUri } from '../uri.ts';
import {
    isVirtualFile,
    toAzerothPath,
    toGenerated,
    type RequestContext
} from '../request.ts';
import type { AzerothProject } from '../ts-project.ts';

/** The call-hierarchy node(s) for the symbol at `offset`. */
export function prepareCallHierarchy(ctx: RequestContext, offset: number): CallHierarchyItem[]
{
    const generated = toGenerated(ctx, offset);
    if (generated === null)
    {
        return [];
    }
    const prepared = ctx.project.service.prepareCallHierarchy(ctx.virtualFile, generated);
    if (!prepared)
    {
        return [];
    }
    const items = Array.isArray(prepared) ? prepared : [prepared];
    return items
        .map(item => toHierarchyItem(ctx.project, item))
        .filter((item): item is CallHierarchyItem => item !== null);
}

/** Callers of the item, each with the ranges where the call appears. */
export function incomingCalls(ctx: RequestContext, offset: number): CallHierarchyIncomingCall[]
{
    const generated = toGenerated(ctx, offset);
    if (generated === null)
    {
        return [];
    }
    const calls = ctx.project.service.provideCallHierarchyIncomingCalls(ctx.virtualFile, generated);
    const out: CallHierarchyIncomingCall[] = [];
    for (const call of calls)
    {
        const from = toHierarchyItem(ctx.project, call.from);
        if (from === null)
        {
            continue;
        }
        out.push({ from, fromRanges: mapSpans(ctx.project, call.from.file, call.fromSpans) });
    }
    return out;
}

/** Callees of the item, each with the call-site ranges in the caller. */
export function outgoingCalls(ctx: RequestContext, offset: number): CallHierarchyOutgoingCall[]
{
    const generated = toGenerated(ctx, offset);
    if (generated === null)
    {
        return [];
    }
    const calls = ctx.project.service.provideCallHierarchyOutgoingCalls(ctx.virtualFile, generated);
    const out: CallHierarchyOutgoingCall[] = [];
    for (const call of calls)
    {
        const to = toHierarchyItem(ctx.project, call.to);
        if (to === null)
        {
            continue;
        }
        // Outgoing `fromSpans` are call sites in the *caller* (the queried item's
        // own file), so they map through that file, not the callee's.
        out.push({ to, fromRanges: mapSpans(ctx.project, ctx.virtualFile, call.fromSpans) });
    }
    return out;
}

/**
 * Translates a TS call-hierarchy item (possibly in another file) to an editor
 * item. A virtual file maps both spans back through its mapping and reports the
 * `.azeroth` URI; a real file reports directly. Returns null when the enclosing
 * span lands purely in generated scaffolding (no faithful source range).
 */
function toHierarchyItem(project: AzerothProject, item: ts.CallHierarchyItem): CallHierarchyItem | null
{
    if (isVirtualFile(item.file))
    {
        const azerothPath = toAzerothPath(item.file);
        const virtual = project.getVirtual(azerothPath);
        const source = project.getSource(azerothPath) ?? '';
        const lineIndex = new LineIndex(source);
        // A function that returns markup straddles generated scaffolding, so its
        // full span is not one contiguous mapping. Map the two endpoints
        // independently (both sit in verbatim script), mirroring symbols.ts. The
        // selection span is always the verbatim name, so it maps as one range.
        const range = toEndpointRange(virtual.mapping, lineIndex, item.span);
        const selectionRange = toSourceRange(virtual.mapping, lineIndex, item.selectionSpan);
        if (range === null || selectionRange === null)
        {
            return null;
        }
        const offset = virtual.mapping.toOriginal(item.selectionSpan.start);
        const uri = pathToUri(azerothPath);
        return {
            name: item.name,
            kind: tsKindToSymbolKind(item.kind),
            detail: item.containerName || undefined,
            uri,
            range,
            selectionRange,
            data: offset === null ? undefined : { uri, offset }
        };
    }

    const text = ts.sys.readFile(item.file);
    if (text === undefined)
    {
        return null;
    }
    const lineIndex = new LineIndex(text);
    const uri = pathToUri(item.file);
    return {
        name: item.name,
        kind: tsKindToSymbolKind(item.kind),
        detail: item.containerName || undefined,
        uri,
        range: lineIndex.rangeAt(item.span.start, item.span.start + item.span.length),
        selectionRange: lineIndex.rangeAt(item.selectionSpan.start, item.selectionSpan.start + item.selectionSpan.length),
        data: { uri, offset: item.selectionSpan.start }
    };
}

/** Maps every call-site span in `fileName` back to a source range, dropping unmappable ones. */
function mapSpans(project: AzerothProject, fileName: string, spans: ts.TextSpan[]): Range[]
{
    const out: Range[] = [];
    if (isVirtualFile(fileName))
    {
        const azerothPath = toAzerothPath(fileName);
        const virtual = project.getVirtual(azerothPath);
        const lineIndex = new LineIndex(project.getSource(azerothPath) ?? '');
        for (const span of spans)
        {
            const range = toSourceRange(virtual.mapping, lineIndex, span);
            if (range !== null)
            {
                out.push(range);
            }
        }
        return out;
    }

    const text = ts.sys.readFile(fileName);
    if (text === undefined)
    {
        return out;
    }
    const lineIndex = new LineIndex(text);
    for (const span of spans)
    {
        out.push(lineIndex.rangeAt(span.start, span.start + span.length));
    }
    return out;
}

/** Maps a virtual span to an original range, or null when it covers scaffolding. */
function toSourceRange(mapping: VirtualMapping, lineIndex: LineIndex, span: ts.TextSpan): Range | null
{
    const mapped = mapping.toOriginalRange(span.start, span.start + span.length);
    return mapped === null ? null : lineIndex.rangeAt(mapped.start, mapped.end);
}

/**
 * Maps a span by translating each endpoint independently. Recovers the source
 * range of a declaration whose body contains markup (and so straddles generated
 * scaffolding that no single range can cross). Null when either end is unmapped.
 */
function toEndpointRange(mapping: VirtualMapping, lineIndex: LineIndex, span: ts.TextSpan): Range | null
{
    const start = mapping.toOriginal(span.start);
    const end = mapping.toOriginal(span.start + span.length);
    if (start === null || end === null || end < start)
    {
        return null;
    }
    return lineIndex.rangeAt(start, end);
}

/** The mapping surface this provider relies on (kept narrow for clarity). */
interface VirtualMapping
{
    toOriginal(generatedOffset: number): number | null;
    toOriginalRange(generatedStart: number, generatedEnd: number): { start: number; end: number } | null;
}

/** Maps a TS ScriptElementKind to an LSP SymbolKind (call-hierarchy subset). */
function tsKindToSymbolKind(kind: string): SymbolKindValue
{
    switch (kind)
    {
        case ts.ScriptElementKind.moduleElement:
            return SymbolKind.Module;
        case ts.ScriptElementKind.classElement:
        case ts.ScriptElementKind.localClassElement:
            return SymbolKind.Class;
        case ts.ScriptElementKind.interfaceElement:
            return SymbolKind.Interface;
        case ts.ScriptElementKind.enumElement:
            return SymbolKind.Enum;
        case ts.ScriptElementKind.memberFunctionElement:
        case ts.ScriptElementKind.constructorImplementationElement:
            return SymbolKind.Method;
        case ts.ScriptElementKind.memberVariableElement:
        case ts.ScriptElementKind.memberGetAccessorElement:
        case ts.ScriptElementKind.memberSetAccessorElement:
            return SymbolKind.Property;
        case ts.ScriptElementKind.variableElement:
        case ts.ScriptElementKind.letElement:
            return SymbolKind.Variable;
        case ts.ScriptElementKind.constElement:
            return SymbolKind.Constant;
        default:
            return SymbolKind.Function;
    }
}
