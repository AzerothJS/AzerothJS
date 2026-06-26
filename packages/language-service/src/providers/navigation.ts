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
import { classDefinition } from './css-classes.ts';
import { getLinkedEditingRanges } from './editing.ts';

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
    // A class name in markup resolves to its CSS rule(s), not a TS symbol.
    const classDefs = classDefinition(ctx, offset);
    if (classDefs.length > 0)
    {
        return classDefs;
    }

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

/**
 * Implementation location(s) for the symbol at `offset` - the concrete classes
 * implementing an interface, or the overrides of an abstract/overridable member.
 * A pure TypeScript query against the virtual module, like {@link getDefinition};
 * for a symbol with no separate implementation TypeScript returns the definition
 * itself, so "Go to Implementation" on an ordinary value still lands somewhere useful.
 */
export function getImplementation(ctx: RequestContext, offset: number): Location[]
{
    const generated = toGenerated(ctx, offset);
    if (generated === null)
    {
        return [];
    }
    const impls = ctx.project.service.getImplementationAtPosition(ctx.virtualFile, generated) ?? [];
    return dedupe(impls
        .map(impl => resolveLocation(ctx.project, impl.fileName, impl.textSpan))
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

/**
 * True when the tag pair's name is a HOST element (lowercase, undotted). A
 * component (PascalCase or dotted, including built-ins like `Show`) is a real TS
 * symbol and should keep its reference highlighting instead.
 */
function isHostTagPair(ctx: RequestContext, tagPair: { start: { line: number; character: number }; end: { line: number; character: number } }[]): boolean
{
    const open = tagPair[0];
    const name = ctx.source.slice(ctx.lineIndex.offsetAt(open.start), ctx.lineIndex.offsetAt(open.end));
    return /^[a-z]/.test(name) && !name.includes('.');
}

/** Occurrences of the symbol at `offset` within this document, for highlighting. */
export function getDocumentHighlights(ctx: RequestContext, offset: number): DocumentHighlight[]
{
    // Caret on a HOST tag name -> highlight the matching open/close pair (so
    // clicking `<h1>` shows its `</h1>`), the way an HTML/markup editor pairs
    // tags. A host tag name compiles to a string literal, so TypeScript can't
    // answer it; the markup model can. A COMPONENT tag name is a real TS symbol,
    // so we leave it to the TypeScript pass below, which highlights every
    // reference (import + all usages) - more useful than just its own tag pair.
    const tagPair = getLinkedEditingRanges(ctx, offset);
    if (tagPair !== null && isHostTagPair(ctx, tagPair))
    {
        return tagPair.map(range => ({ range, kind: 1 as const }));
    }

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
        // providePrefixAndSuffixTextForRename is deliberately LEFT OFF. For a VARIABLE rename (what an
        // `.azeroth` state/prop/local rename is), TS's default - letting a shorthand `{ x }` become
        // `{ newName }`, which still binds the renamed variable - is correct, and it also returns the
        // cross-file `.ts` declaration site. Turning the preference on splits shorthands (needed only when
        // a property name and variable name must DIVERGE) and regressed cross-file rename. The
        // prefix/suffix fields are still applied below for the rare site where TS does populate them.
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
