// Go-to-definition, type-definition, find-references, and rename. All four are
// pure TypeScript queries against the virtual module, with results translated
// back to original ranges (in this file or others). Because component tags and
// every expression identifier are mapped 1:1, jumping from `<Counter/>` to the
// `Counter` definition, or renaming a signal everywhere it's read inside markup,
// works exactly as it does in a `.ts` file.

import ts from 'typescript';
import type { DocumentHighlight, Location, PrepareRenameResult, WorkspaceEdit } from '../protocol.ts';
import {
    resolveLocation,
    spanToRange,
    toGenerated,
    type RequestContext
} from '../request.ts';

/**
 * Validates the rename target at `offset`, returning the identifier range and
 * its current name so the editor can pre-fill the rename box, or null when the
 * position can't be renamed (e.g. whitespace, a keyword, a string literal).
 */
export function getPrepareRename(ctx: RequestContext, offset: number): PrepareRenameResult | null
{
    const generated = toGenerated(ctx, offset);
    if (generated === null)
    {
        return null;
    }
    const info = ctx.project.service.getRenameInfo(ctx.virtualFile, generated, { allowRenameOfImportPath: false });
    if (!info.canRename)
    {
        return null;
    }
    const range = spanToRange(ctx, info.triggerSpan);
    if (range === null)
    {
        return null;
    }
    return { range, placeholder: info.displayName };
}

/** Definition location(s) for the symbol at `offset`. */
export function getDefinition(ctx: RequestContext, offset: number): Location[]
{
    const generated = toGenerated(ctx, offset);
    if (generated === null)
    {
        return [];
    }
    const result = ctx.project.service.getDefinitionAndBoundSpan(ctx.virtualFile, generated);
    if (!result?.definitions)
    {
        return [];
    }
    return dedupe(result.definitions
        .map(def => resolveLocation(ctx.project, def.fileName, def.textSpan))
        .filter((loc): loc is Location => loc !== null));
}

/** Type-definition location(s) for the symbol at `offset`. */
export function getTypeDefinition(ctx: RequestContext, offset: number): Location[]
{
    const generated = toGenerated(ctx, offset);
    if (generated === null)
    {
        return [];
    }
    const defs = ctx.project.service.getTypeDefinitionAtPosition(ctx.virtualFile, generated) ?? [];
    return dedupe(defs
        .map(def => resolveLocation(ctx.project, def.fileName, def.textSpan))
        .filter((loc): loc is Location => loc !== null));
}

/** All references to the symbol at `offset`. */
export function getReferences(ctx: RequestContext, offset: number): Location[]
{
    const generated = toGenerated(ctx, offset);
    if (generated === null)
    {
        return [];
    }
    const refs = ctx.project.service.getReferencesAtPosition(ctx.virtualFile, generated) ?? [];
    return dedupe(refs
        .map(ref => resolveLocation(ctx.project, ref.fileName, ref.textSpan))
        .filter((loc): loc is Location => loc !== null));
}

/** Occurrences of the symbol at `offset` within this document, for highlighting. */
export function getDocumentHighlights(ctx: RequestContext, offset: number): DocumentHighlight[]
{
    const generated = toGenerated(ctx, offset);
    if (generated === null)
    {
        return [];
    }
    const highlights = ctx.project.service.getDocumentHighlights(ctx.virtualFile, generated, [ctx.virtualFile]);
    const out: DocumentHighlight[] = [];
    for (const fileHighlights of highlights ?? [])
    {
        if (fileHighlights.fileName !== ctx.virtualFile)
        {
            continue;
        }
        for (const span of fileHighlights.highlightSpans)
        {
            const range = spanToRange(ctx, span.textSpan);
            if (range !== null)
            {
                out.push({ range, kind: span.kind === ts.HighlightSpanKind.writtenReference ? 3 : 2 });
            }
        }
    }
    return out;
}

/**
 * Computes the workspace edit to rename the symbol at `offset` to `newName`,
 * or null when the position can't be renamed.
 */
export function getRenameEdits(ctx: RequestContext, offset: number, newName: string): WorkspaceEdit | null
{
    const generated = toGenerated(ctx, offset);
    if (generated === null)
    {
        return null;
    }
    const locations = ctx.project.service.findRenameLocations(
        ctx.virtualFile,
        generated,
        false,
        false,
        {}
    );
    if (!locations || locations.length === 0)
    {
        return null;
    }

    const changes: Record<string, { range: Location['range']; newText: string }[]> = {};
    for (const location of locations)
    {
        const resolved = resolveLocation(ctx.project, location.fileName, location.textSpan);
        if (resolved === null)
        {
            continue;
        }
        const prefix = location.prefixText ?? '';
        const suffix = location.suffixText ?? '';
        (changes[resolved.uri] ??= []).push({
            range: resolved.range,
            newText: `${ prefix }${ newName }${ suffix }`
        });
    }

    return { changes };
}

/** Removes duplicate locations (same uri + range). */
function dedupe(locations: Location[]): Location[]
{
    const seen = new Set<string>();
    const out: Location[] = [];
    for (const loc of locations)
    {
        const key = `${ loc.uri }:${ loc.range.start.line }:${ loc.range.start.character }:${ loc.range.end.line }:${ loc.range.end.character }`;
        if (!seen.has(key))
        {
            seen.add(key);
            out.push(loc);
        }
    }
    return out;
}
