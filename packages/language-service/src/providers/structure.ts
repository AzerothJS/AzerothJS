// Three structural features grouped together:
//   - folding ranges: markup elements that span lines, plus TypeScript's own
//     outlining spans (functions, blocks, imports, block comments);
//   - code actions: TypeScript quick fixes for diagnostics at a range, with
//     their edits mapped back to the original document;
//   - formatting: TypeScript's formatter run over the virtual module, keeping
//     only the edits that fall inside mapped (user-authored) spans - so the
//     script and expressions are tidied while the markup is left untouched.

import ts from 'typescript';
import {
    type CodeAction,
    type FoldingRange,
    type Position,
    type Range,
    type SelectionRange,
    type TextEdit,
    type WorkspaceEdit
} from '../protocol.ts';
import { collectMarkupNodes } from '../markup-model.ts';
import { resolveLocation, spanToRange, toGenerated, type RequestContext } from '../request.ts';

/** Default formatter settings, matching the repo's 4-space, single-quote style. */
const FORMAT_OPTIONS: ts.FormatCodeSettings =
{
    indentSize: 4,
    tabSize: 4,
    convertTabsToSpaces: true,
    insertSpaceAfterCommaDelimiter: true,
    insertSpaceAfterKeywordsInControlFlowStatements: true,
    insertSpaceBeforeAndAfterBinaryOperators: true,
    semicolons: ts.SemicolonPreference.Insert
};

/** Collapsible regions: multi-line markup elements + TS outlining spans. */
export function getFoldingRanges(ctx: RequestContext): FoldingRange[]
{
    const ranges: FoldingRange[] = [];
    const seen = new Set<string>();

    const add = (startLine: number, endLine: number, kind?: FoldingRange['kind']): void =>
    {
        if (endLine <= startLine)
        {
            return;
        }
        const key = `${ startLine }:${ endLine }`;
        if (!seen.has(key))
        {
            seen.add(key);
            ranges.push({ startLine, endLine, kind });
        }
    };

    for (const node of collectMarkupNodes(ctx.source))
    {
        const startLine = ctx.lineIndex.positionAt(node.start).line;
        const endLine = ctx.lineIndex.positionAt(node.end - 1).line;
        add(startLine, endLine);
    }

    for (const span of ctx.project.service.getOutliningSpans(ctx.virtualFile))
    {
        const mapped = ctx.virtual.mapping.toOriginalRange(span.textSpan.start, span.textSpan.start + span.textSpan.length);
        if (mapped === null)
        {
            continue;
        }
        const startLine = ctx.lineIndex.positionAt(mapped.start).line;
        // mapped.end is exclusive; step back one offset so a span ending right before a
        // newline folds to the brace line, not the line after it (guard empty/one-char spans).
        const endLine = ctx.lineIndex.positionAt(Math.max(mapped.start, mapped.end - 1)).line;
        add(startLine, endLine, span.kind === ts.OutliningSpanKind.Comment ? 'comment' : span.kind === ts.OutliningSpanKind.Imports ? 'imports' : 'region');
    }

    return ranges;
}

/**
 * Code actions for `range`: TypeScript quick fixes for the overlapping
 * diagnostics, plus any applicable refactors (extract function/constant, ...)
 * whose edits map cleanly back to the source. Refactors that would touch
 * generated markup scaffolding are skipped, since their edits can't be
 * represented faithfully in the original document.
 */
export function getCodeActions(ctx: RequestContext, range: Range, errorCodes: number[]): CodeAction[]
{
    const start = ctx.lineIndex.offsetAt(range.start);
    const end = ctx.lineIndex.offsetAt(range.end);
    const generated = ctx.virtual.mapping.toGeneratedRange(start, Math.max(end, start));
    if (generated === null)
    {
        return [];
    }

    const actions: CodeAction[] = [];

    const codes = errorCodes.length > 0 ? errorCodes : commonFixCodes();
    const fixes = ctx.project.service.getCodeFixesAtPosition(ctx.virtualFile, generated.start, generated.end, codes, FORMAT_OPTIONS, {});
    for (const fix of fixes)
    {
        const edit = changesToWorkspaceEdit(ctx, fix.changes);
        if (edit !== null)
        {
            actions.push({ title: fix.description, kind: 'quickfix', edit, isPreferred: fix.fixName === fixes[0]?.fixName });
        }
    }

    actions.push(...refactors(ctx, generated.start, generated.end));
    return actions;
}

/** Applicable refactors at the range whose edits map cleanly to the source. */
function refactors(ctx: RequestContext, start: number, end: number): CodeAction[]
{
    const positionOrRange = { pos: start, end };
    let applicable: readonly ts.ApplicableRefactorInfo[];
    try
    {
        applicable = ctx.project.service.getApplicableRefactors(ctx.virtualFile, positionOrRange, {});
    }
    catch
    {
        return [];
    }

    const actions: CodeAction[] = [];
    for (const refactor of applicable)
    {
        for (const action of refactor.actions)
        {
            let edits: ts.RefactorEditInfo | undefined;
            try
            {
                edits = ctx.project.service.getEditsForRefactor(ctx.virtualFile, FORMAT_OPTIONS, positionOrRange, refactor.name, action.name, {});
            }
            catch
            {
                continue;
            }
            if (!edits)
            {
                continue;
            }
            const edit = changesToWorkspaceEdit(ctx, edits.edits);
            if (edit !== null)
            {
                actions.push({ title: action.description, kind: 'refactor', edit });
            }
        }
    }
    return actions;
}

/** Formats the document, applying only edits that map cleanly to the source. */
export function getFormattingEdits(ctx: RequestContext): TextEdit[]
{
    return mapTextChanges(ctx, ctx.project.service.getFormattingEditsForDocument(ctx.virtualFile, FORMAT_OPTIONS));
}

/** Formatting edits triggered by typing `ch` at a position (e.g. `;`, `}`). */
export function getOnTypeFormattingEdits(ctx: RequestContext, position: Position, ch: string): TextEdit[]
{
    const generated = toGenerated(ctx, ctx.lineIndex.offsetAt(position));
    if (generated === null)
    {
        return [];
    }
    return mapTextChanges(ctx, ctx.project.service.getFormattingEditsAfterKeystroke(ctx.virtualFile, generated, ch, FORMAT_OPTIONS));
}

/** Maps TS formatting text changes back to original-document edits (dropping unmappable ones). */
function mapTextChanges(ctx: RequestContext, changes: readonly ts.TextChange[]): TextEdit[]
{
    const edits: TextEdit[] = [];
    for (const change of changes)
    {
        const mapped = ctx.virtual.mapping.toOriginalRange(change.span.start, change.span.start + change.span.length);
        if (mapped !== null)
        {
            edits.push({ range: ctx.lineIndex.rangeAt(mapped.start, mapped.end), newText: change.newText });
        }
    }
    return edits;
}

/** Smart-selection (Expand Selection) chains for each caret position. */
export function getSelectionRanges(ctx: RequestContext, positions: Position[]): SelectionRange[]
{
    return positions.map((position) =>
    {
        const fallback: SelectionRange = { range: { start: position, end: position } };
        const generated = toGenerated(ctx, ctx.lineIndex.offsetAt(position));
        if (generated === null)
        {
            return fallback;
        }
        const tsRange = ctx.project.service.getSmartSelectionRange(ctx.virtualFile, generated);
        return convertSelectionRange(ctx, tsRange) ?? fallback;
    });
}

/** Converts a TS selection-range tree to mapped ranges (innermost references its parent). */
function convertSelectionRange(ctx: RequestContext, tsRange: ts.SelectionRange): SelectionRange | null
{
    // Collect each level's mapped range from innermost outward.
    const ranges: Range[] = [];
    let node: ts.SelectionRange | undefined = tsRange;
    while (node)
    {
        const range = spanToRange(ctx, node.textSpan);
        if (range !== null)
        {
            ranges.push(range);
        }
        node = node.parent;
    }
    // Link outermost (no parent) inward, so each level references its enclosing one.
    let result: SelectionRange | undefined;
    for (let i = ranges.length - 1; i >= 0; i--)
    {
        result = { range: ranges[i], parent: result };
    }
    return result ?? null;
}

/** Converts TS multi-file text changes into a mapped WorkspaceEdit. */
function changesToWorkspaceEdit(ctx: RequestContext, changes: readonly ts.FileTextChanges[]): WorkspaceEdit | null
{
    const result: Record<string, TextEdit[]> = {};
    for (const fileChange of changes)
    {
        for (const textChange of fileChange.textChanges)
        {
            const location = resolveLocation(ctx.project, fileChange.fileName, textChange.span);
            if (location === null)
            {
                return null;
            }
            (result[location.uri] ??= []).push({ range: location.range, newText: textChange.newText });
        }
    }
    return { changes: result };
}

/** A few common quick-fixable error codes used when none are supplied. */
function commonFixCodes(): number[]
{
    return [
        2304, // Cannot find name
        2552, // Cannot find name (did you mean)
        2345, // Argument type not assignable
        2769, // No overload matches
        6133, // Declared but never used
        2307 // Cannot find module
    ];
}
