// Diagnostics from three sources:
//   1. The compiler's own parser - a CompileError (mismatched/closing tag,
//      missing attribute value, ...) is reported at its exact offset.
//   2. The compiler's lint rules over parsed regions - warnings for the
//      mistakes the type system can't see (onClick={save()}, duplicate
//      attributes, lowercase event names).
//   3. TypeScript's syntactic + semantic diagnostics over the virtual module,
//      mapped back to original ranges. Diagnostics that land purely in
//      generated scaffolding are dropped (there is no original code to flag),
//      so what surfaces are genuine type errors in the user's expressions and
//      script.

import ts from 'typescript';
import { findMarkupStart } from '@azerothjs/compiler';
import { parseMarkup, CompileError, lintMarkup } from '@azerothjs/compiler';
import {
    DiagnosticSeverity,
    type Diagnostic,
    type DiagnosticSeverityValue
} from '../protocol.ts';
import { type RequestContext } from '../request.ts';

/** All diagnostics for the document. */
export function getDiagnostics(ctx: RequestContext): Diagnostic[]
{
    const { errors, warnings } = markupDiagnostics(ctx);
    // A hard markup parse error means the virtual module is incomplete; TS
    // diagnostics would be noise, so report only the markup error. Lint
    // warnings are NOT errors and must never suppress type checking.
    if (errors.length > 0)
    {
        return errors;
    }
    return [...warnings, ...typeScriptDiagnostics(ctx)];
}

/**
 * Walks the markup regions once: an unparseable region becomes a
 * CompileError diagnostic (and stops the walk - everything after it is
 * unreliable); each parsed region is linted for warnings.
 */
function markupDiagnostics(ctx: RequestContext): { errors: Diagnostic[]; warnings: Diagnostic[] }
{
    const errors: Diagnostic[] = [];
    const warnings: Diagnostic[] = [];
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
            const { node, end } = parseMarkup(ctx.source, start);
            for (const finding of lintMarkup(node))
            {
                warnings.push({
                    range: ctx.lineIndex.rangeAt(finding.start, Math.min(finding.end, ctx.source.length)),
                    severity: DiagnosticSeverity.Warning,
                    message: finding.message,
                    code: finding.code,
                    source: 'azeroth-lint'
                });
            }
            i = end;
        }
        catch (err)
        {
            if (err instanceof CompileError)
            {
                const at = Math.min(err.offset, ctx.source.length);
                errors.push({
                    range: ctx.lineIndex.rangeAt(at, Math.min(at + 1, ctx.source.length)),
                    severity: DiagnosticSeverity.Error,
                    message: err.message,
                    source: 'azeroth'
                });
            }
            break;
        }
    }
    return { errors, warnings };
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
            // A component-tag props mismatch (a missing required prop, or a
            // wrong props shape) is reported by TypeScript on the generated
            // `({ ... })` argument, which is unmapped scaffolding. Rather than
            // drop it, anchor it to the component tag that precedes the call so
            // `<Modal/>` missing a required prop surfaces on the markup. Scoped
            // to these codes so ordinary scaffolding noise is still dropped.
            if (COMPONENT_PROP_CODES.has(diag.code))
            {
                const anchor = ctx.virtual.mapping.nearestSourceBefore(diag.start);
                if (anchor !== null)
                {
                    out.push({
                        range: ctx.lineIndex.rangeAt(anchor, Math.min(anchor + 1, ctx.source.length)),
                        severity: categoryToSeverity(diag.category),
                        message: ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
                        code: diag.code,
                        source: 'azeroth-ts'
                    });
                }
            }
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

/**
 * TypeScript error codes for a call argument not matching the callee's
 * parameter type - exactly the errors a component tag's props raise on the
 * lowered `Comp({ ... })` call: a missing required prop / wrong props shape
 * (2345), and missing-property variants (2739, 2741). Anchored to the tag when
 * they land in generated scaffolding.
 */
const COMPONENT_PROP_CODES = new Set<number>([2345, 2739, 2741]);

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
