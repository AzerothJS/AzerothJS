// Diagnostics from two sources:
//   1. The compiler's own parser - a CompileError (mismatched/closing tag,
//      missing attribute value, ...) is reported at its exact offset.
//   2. TypeScript's syntactic + semantic diagnostics over the virtual module,
//      mapped back to original ranges. Diagnostics that land purely in
//      generated scaffolding are dropped (there is no original code to flag),
//      so what surfaces are genuine type errors in the user's expressions and
//      script.

import ts from 'typescript';
import { findMarkupStart } from '@azerothjs/compiler';
import { parseMarkup, CompileError } from '@azerothjs/compiler';
import {
    DiagnosticSeverity,
    type Diagnostic,
    type DiagnosticSeverityValue
} from '../protocol.ts';
import { type RequestContext } from '../request.ts';

/** All diagnostics for the document. */
export function getDiagnostics(ctx: RequestContext): Diagnostic[]
{
    const markup = markupDiagnostics(ctx);
    // A hard markup parse error means the virtual module is incomplete; TS
    // diagnostics would be noise, so report only the markup error.
    if (markup.length > 0)
    {
        return markup;
    }
    return typeScriptDiagnostics(ctx);
}

/** Reports the first unparseable markup region as a CompileError diagnostic. */
function markupDiagnostics(ctx: RequestContext): Diagnostic[]
{
    const out: Diagnostic[] = [];
    let i = 0;
    for (;;)
    {
        const start = findMarkupStart(ctx.source, i);
        if (start === -1)
        {
            break;
        }
        try
        {
            const { end } = parseMarkup(ctx.source, start);
            i = end;
        }
        catch (err)
        {
            if (err instanceof CompileError)
            {
                const at = Math.min(err.offset, ctx.source.length);
                out.push({
                    range: ctx.lineIndex.rangeAt(at, Math.min(at + 1, ctx.source.length)),
                    severity: DiagnosticSeverity.Error,
                    message: err.message,
                    source: 'azeroth'
                });
            }
            break;
        }
    }
    return out;
}

/** TypeScript syntactic + semantic diagnostics, mapped to original ranges. */
function typeScriptDiagnostics(ctx: RequestContext): Diagnostic[]
{
    const raw = [
        ...ctx.project.service.getSyntacticDiagnostics(ctx.virtualFile),
        ...ctx.project.service.getSemanticDiagnostics(ctx.virtualFile)
    ];

    const out: Diagnostic[] = [];
    for (const diag of raw)
    {
        if (diag.start === undefined || diag.length === undefined)
        {
            continue;
        }
        const mapped = ctx.virtual.mapping.toOriginalRange(diag.start, diag.start + diag.length);
        if (mapped === null)
        {
            continue;
        }
        out.push({
            range: ctx.lineIndex.rangeAt(mapped.start, mapped.end),
            severity: categoryToSeverity(diag.category),
            message: ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
            code: diag.code,
            source: 'azeroth-ts'
        });
    }
    return out;
}

/** Maps a TS diagnostic category to an LSP severity. */
function categoryToSeverity(category: ts.DiagnosticCategory): DiagnosticSeverityValue
{
    switch (category)
    {
        case ts.DiagnosticCategory.Error:
            return DiagnosticSeverity.Error;
        case ts.DiagnosticCategory.Warning:
            return DiagnosticSeverity.Warning;
        case ts.DiagnosticCategory.Suggestion:
            return DiagnosticSeverity.Hint;
        default:
            return DiagnosticSeverity.Information;
    }
}
