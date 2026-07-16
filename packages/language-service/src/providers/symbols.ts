// Document symbols (the outline) and workspace symbols (project-wide search).
// Both come from TypeScript's navigation APIs over the virtual module; spans
// are mapped back to the original `.azeroth` source, and any symbol whose span
// lives purely in generated scaffolding is dropped.

import ts from 'typescript';
import {
    SymbolKind,
    type DocumentSymbol,
    type Position,
    type SymbolKindValue,
    type WorkspaceSymbol
} from '../protocol.ts';
import { isVirtualFile, resolveLocation, toAzerothPath, type RequestContext } from '../request.ts';
import type { AzerothProject } from '../ts-project.ts';

/** The outline for the document. */
export function getDocumentSymbols(ctx: RequestContext): DocumentSymbol[]
{
    const tree = ctx.project.service.getNavigationTree(ctx.virtualFile);
    if (!tree.childItems)
    {
        return [];
    }
    return tree.childItems
        .map(item => toDocumentSymbol(ctx, item))
        .filter((s): s is DocumentSymbol => s !== null);
}

/** Recursively converts a TS navigation node to a DocumentSymbol. */
function toDocumentSymbol(ctx: RequestContext, item: ts.NavigationTree): DocumentSymbol | null
{
    const span = item.spans[0];
    if (!span)
    {
        return null;
    }
    // A declaration that contains markup straddles generated scaffolding, so its
    // full span isn't one contiguous mapping. Map the two endpoints
    // independently (both sit in verbatim script) to recover the source range.
    const start = ctx.virtual.mapping.toOriginal(span.start);
    const end = ctx.virtual.mapping.toOriginal(span.start + span.length);
    if (start === null || end === null || end < start)
    {
        return null;
    }
    const fullRange = ctx.lineIndex.rangeAt(start, end);
    const selectionRange = nameRange(ctx, item) ?? fullRange;
    const children = (item.childItems ?? [])
        .map(child => toDocumentSymbol(ctx, child))
        .filter((s): s is DocumentSymbol => s !== null);

    return {
        name: item.text,
        kind: tsKindToSymbolKind(item.kind),
        range: fullRange,
        selectionRange,
        children: children.length > 0 ? children : undefined
    };
}

/** Maps a navigation node's name span (the identifier) to a source range. */
function nameRange(ctx: RequestContext, item: ts.NavigationTree): { start: Position; end: Position } | null
{
    const span = item.nameSpan;
    if (!span)
    {
        return null;
    }
    const mapped = ctx.virtual.mapping.toOriginalRange(span.start, span.start + span.length);
    return mapped === null ? null : ctx.lineIndex.rangeAt(mapped.start, mapped.end);
}

/**
 * The most matches a single workspace-symbol query returns. Matches tsserver's
 * navigate-to default: the editor refines the list as the user types, so an
 * unbounded scan only adds latency for results no one reads.
 */
const MAX_WORKSPACE_SYMBOLS = 256;

/** Project-wide symbol search. */
export function getWorkspaceSymbols(project: AzerothProject, query: string): WorkspaceSymbol[]
{
    // excludeDtsFiles = true: a workspace-symbol search navigates to the user's
    // own declarations, never into `lib.dom.d.ts` or `node_modules` `.d.ts`
    // files. Scanning those is a large fixed cost (seconds on a real project)
    // that grows the result set with symbols no one is searching for - so they
    // are excluded, exactly as TypeScript's own tsserver does. The cap bounds
    // the work on top of that.
    const items = project.service.getNavigateToItems(query, MAX_WORKSPACE_SYMBOLS, undefined, true);
    const out: WorkspaceSymbol[] = [];
    for (const item of items)
    {
        // A component declaration's span covers its markup body, which straddles
        // generated scaffolding and so won't map as one contiguous range. The
        // name identifier is verbatim and always maps, so range on it instead -
        // otherwise default-exported components never surface in symbol search.
        const span = nameSpan(project, item) ?? item.textSpan;
        const location = resolveLocation(project, item.fileName, span);
        if (location === null)
        {
            continue;
        }
        out.push({
            name: item.name,
            kind: tsKindToSymbolKind(item.kind),
            location,
            containerName: item.containerName || undefined
        });
    }
    return out;
}

/**
 * The span of a navigate-to item's name identifier within its declaration.
 * `NavigateToItem` carries no name span, so the name's first occurrence inside
 * the declaration text is located (keywords/modifiers precede it and never
 * contain it). Returns `null` when the declaration text is unavailable.
 */
function nameSpan(project: AzerothProject, item: ts.NavigateToItem): ts.TextSpan | null
{
    const text = declarationText(project, item.fileName);
    if (text === null)
    {
        return null;
    }
    const slice = text.slice(item.textSpan.start, item.textSpan.start + item.textSpan.length);
    const offset = slice.indexOf(item.name);
    if (offset < 0)
    {
        return null;
    }
    return { start: item.textSpan.start + offset, length: item.name.length };
}

/** The full text a navigate-to item's span indexes into (generated for virtual files). */
function declarationText(project: AzerothProject, fileName: string): string | null
{
    if (isVirtualFile(fileName))
    {
        return project.getVirtual(toAzerothPath(fileName)).code;
    }
    return ts.sys.readFile(fileName) ?? null;
}

/** Maps a TS ScriptElementKind to an LSP SymbolKind. */
function tsKindToSymbolKind(kind: ts.ScriptElementKind | string): SymbolKindValue
{
    return mapTsKind(kind as ts.ScriptElementKind);
}

function mapTsKind(kind: ts.ScriptElementKind): SymbolKindValue
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
        case ts.ScriptElementKind.enumMemberElement:
            return SymbolKind.EnumMember;
        case ts.ScriptElementKind.functionElement:
        case ts.ScriptElementKind.localFunctionElement:
            return SymbolKind.Function;
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
        case ts.ScriptElementKind.typeElement:
        case ts.ScriptElementKind.typeParameterElement:
            return SymbolKind.TypeParameter;
        default:
            return SymbolKind.Variable;
    }
}
