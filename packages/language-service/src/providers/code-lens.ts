// Code lenses: a "N references" annotation over each top-level component /
// function declaration. The initial pass (getCodeLenses) reuses the
// document-symbol navigation tree to place a lens on every eligible declaration,
// stashing the source URI + name offset in `data` - it deliberately does NOT
// count references (a find-all-references per declaration is too slow for the
// whole document at once). The count is computed lazily, one lens at a time, in
// resolveCodeLens via the references provider, mirroring completion/resolve.

import ts from 'typescript';
import type { CodeLens } from '../protocol.ts';
import { type RequestContext } from '../request.ts';
import { getReferences } from './navigation.ts';

/** The script-element kinds that get a reference lens (top-level declarations). */
const LENS_KINDS = new Set<string>([
    ts.ScriptElementKind.functionElement,
    ts.ScriptElementKind.classElement,
    ts.ScriptElementKind.constElement,
    ts.ScriptElementKind.variableElement,
    ts.ScriptElementKind.letElement,
    ts.ScriptElementKind.interfaceElement,
    ts.ScriptElementKind.enumElement
]);

/** One unresolved lens per top-level declaration; references are NOT counted here. */
export function getCodeLenses(ctx: RequestContext): CodeLens[]
{
    const tree = ctx.project.service.getNavigationTree(ctx.virtualFile);
    if (!tree.childItems)
    {
        return [];
    }
    const out: CodeLens[] = [];
    for (const item of tree.childItems)
    {
        if (!LENS_KINDS.has(item.kind))
        {
            continue;
        }
        const offset = nameOffset(ctx, item);
        if (offset === null)
        {
            continue;
        }
        out.push({ range: ctx.lineIndex.rangeAt(offset, offset), data: { uri: ctx.uri, offset } });
    }
    return out;
}

/**
 * Fills a lens's command with its reference count, computed now via the
 * references provider. The lens carries the declaration's source offset in
 * `data`; an unresolvable/unmappable payload yields the lens unchanged.
 */
export function resolveCodeLens(ctx: RequestContext, lens: CodeLens): CodeLens
{
    const data = lens.data as { uri: string; offset: number } | undefined;
    if (!data)
    {
        return lens;
    }
    const references = getReferences(ctx, data.offset);
    // The declaration's own name counts as a reference; subtract it so the lens
    // reads like the editor's built-in "N references".
    const count = Math.max(references.length - 1, 0);
    return {
        ...lens,
        command:
        {
            title: `${ count } reference${ count === 1 ? '' : 's' }`,
            command: 'editor.action.showReferences',
            arguments: [data.uri, lens.range.start, references]
        }
    };
}

/** The original-source offset of a navigation node's name, or null if unmapped. */
function nameOffset(ctx: RequestContext, item: ts.NavigationTree): number | null
{
    const span = item.nameSpan ?? item.spans[0];
    if (!span)
    {
        return null;
    }
    return ctx.virtual.mapping.toOriginal(span.start);
}
