// Diagnostics from three sources:
//   1. The compiler's own parser - a CompileError (mismatched/closing tag,
//      missing attribute value, ...) is reported at its exact offset.
//   2. The compiler's lint rules over parsed regions - warnings for the
//      mistakes the type system can't see (onClick={save()}, duplicate
//      attributes, lowercase event names).
//   3. TypeScript's syntactic + semantic diagnostics over the virtual module,
//      mapped back to original ranges. Diagnostics that land purely in
//      generated scaffolding are dropped (there is no original code to flag),
//      EXCEPT the two the projection deliberately checks there: a non-function
//      event handler (1360, on the `satisfies` keyword) and a component-tag
//      props mismatch (on the synthesized call args) - both anchored back to the
//      markup so the editor flags exactly what the azeroth-tsc gate flags.

import ts from 'typescript';
import { findMarkupStart, parseModule } from '@azerothjs/compiler';
import { parseMarkup, CompileError, lintMarkup } from '@azerothjs/compiler';
import {
    DiagnosticSeverity,
    type Diagnostic,
    type DiagnosticRelatedInformation,
    type DiagnosticSeverityValue
} from '../protocol.ts';
import { keywordOptions } from '../language-data.ts';
import { resolveLocation, type RequestContext } from '../request.ts';

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
    return [...warnings, ...withOptionDiagnostics(ctx), ...typeScriptDiagnostics(ctx)];
}

/**
 * Flags an unknown key inside a keyword's `with { ... }` options clause - e.g. a typo'd or made-up
 * option. The allowed set comes from the same KEYWORD_OPTIONS registry that completion and hover
 * use, so adding an option there clears this error too. Only the KEYS are checked (a made-up option
 * is a real mistake the projection can't catch, since it drops the options object); value types are
 * the runtime's concern.
 */
function withOptionDiagnostics(ctx: RequestContext): Diagnostic[]
{
    let module: ReturnType<typeof parseModule>;
    try
    {
        module = parseModule(ctx.source);
    }
    catch
    {
        return [];
    }

    const out: Diagnostic[] = [];
    for (const item of module.items)
    {
        if (item.kind !== 'component')
        {
            continue;
        }
        for (const bodyItem of item.body)
        {
            if (!('optionsStart' in bodyItem) || bodyItem.optionsStart === null || bodyItem.optionsEnd === null)
            {
                continue;
            }
            const allowed = keywordOptions(bodyItem.kind);
            if (allowed === undefined)
            {
                continue;
            }
            const allowedNames = new Set(allowed.map(option => option.name));
            const allowedList = allowed.map(option => option.name).join(', ');
            for (const key of optionKeys(ctx.source, bodyItem.optionsStart, bodyItem.optionsEnd))
            {
                if (!allowedNames.has(key.name))
                {
                    out.push({
                        range: ctx.lineIndex.rangeAt(key.start, key.end),
                        severity: DiagnosticSeverity.Error,
                        message: `Unknown option '${ key.name }' for \`${ bodyItem.kind }\`. Allowed: ${ allowedList }.`,
                        code: 'azeroth/unknown-option',
                        source: 'azeroth'
                    });
                }
            }
        }
    }
    return out;
}

/**
 * The top-level keys of the `{ ... }` options object spanning `[start, end)`, with their source spans.
 * Parses through TypeScript so nested objects, function values, and strings in the option values are
 * skipped correctly; positions are rebased from the wrapped `({ ... })` parse back onto the source.
 */
function optionKeys(source: string, start: number, end: number): { name: string; start: number; end: number }[]
{
    const sourceFile = ts.createSourceFile('__opts.ts', `(${ source.slice(start, end) })`, ts.ScriptTarget.Latest, false);
    const statement = sourceFile.statements[0];
    if (statement === undefined || !ts.isExpressionStatement(statement) || !ts.isParenthesizedExpression(statement.expression))
    {
        return [];
    }
    const object = statement.expression.expression;
    if (!ts.isObjectLiteralExpression(object))
    {
        return [];
    }
    const keys: { name: string; start: number; end: number }[] = [];
    for (const property of object.properties)
    {
        const nameNode = property.name;
        if (nameNode === undefined || !ts.isIdentifier(nameNode))
        {
            continue;
        }
        // Positions are into the wrapping `(` + slice, so drop the leading `(` and rebase to source.
        const relative = nameNode.getStart(sourceFile) - 1;
        keys.push({ name: nameNode.text, start: start + relative, end: start + relative + nameNode.text.length });
    }
    return keys;
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
            // Passing the source enables the style rules that need raw text (interpolation-spacing
            // inspects the bytes between an expression's braces, which the AST does not carry).
            for (const finding of lintMarkup(node, ctx.source))
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
        // A handler `satisfies AzerothHandler<...>` failure (TS 1360 - the only `satisfies` the
        // projection emits) is reported on the generated `satisfies` keyword, which is scaffolding.
        // Anchor it to the handler value segment and present it as a handler error, so a
        // non-function `onClick={...}` surfaces in the editor exactly as the azeroth-tsc gate
        // reports it - otherwise the editor stays silent while CI fails.
        if (diag.code === 1360)
        {
            const handler = ctx.virtual.mapping.segmentAt(diag.start)
                ?? ctx.virtual.mapping.nearestSegmentBefore(diag.start);
            if (handler !== null)
            {
                out.push(withRelated(ctx, diag, {
                    range: ctx.lineIndex.rangeAt(handler.sourceStart, handler.sourceEnd),
                    severity: categoryToSeverity(diag.category),
                    message: 'Event handler must be a function: ' + ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
                    code: diag.code,
                    source: 'azeroth-ts'
                }));
            }
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
                    out.push(withRelated(ctx, diag, {
                        range: ctx.lineIndex.rangeAt(anchor, Math.min(anchor + 1, ctx.source.length)),
                        severity: categoryToSeverity(diag.category),
                        message: ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
                        code: diag.code,
                        source: 'azeroth-ts'
                    }));
                }
            }
            continue;
        }
        out.push(withRelated(ctx, diag, {
            range: ctx.lineIndex.rangeAt(mapped.start, mapped.end),
            severity: categoryToSeverity(diag.category),
            message: ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
            code: diag.code,
            source: 'azeroth-ts'
        }));
    }
    return out;
}

/**
 * Attaches `relatedInformation` (TypeScript's "'x' is declared here" / "the
 * expected type comes from ..." secondary spans) to a mapped diagnostic. Each
 * related entry can point at another `.azeroth` file or a real `.ts` file, so it
 * resolves through the same virtual mapping as definitions/references. Entries
 * that land in generated scaffolding (or have no span) are skipped, and the
 * field is left off entirely when nothing maps.
 */
function withRelated(ctx: RequestContext, diag: ts.Diagnostic, out: Diagnostic): Diagnostic
{
    if (diag.relatedInformation === undefined)
    {
        return out;
    }
    const related: DiagnosticRelatedInformation[] = [];
    for (const info of diag.relatedInformation)
    {
        if (info.file === undefined || info.start === undefined || info.length === undefined)
        {
            continue;
        }
        const location = resolveLocation(ctx.project, info.file.fileName, { start: info.start, length: info.length });
        if (location === null)
        {
            continue;
        }
        related.push({
            location,
            message: ts.flattenDiagnosticMessageText(info.messageText, '\n')
        });
    }
    if (related.length > 0)
    {
        out.relatedInformation = related;
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
