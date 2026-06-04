// Inlay hints - the inline parameter-name and inferred-type annotations TS
// shows (`createSignal(initialValue: 0)`, `const x: number = …`). A direct
// TypeScript query over the virtual module, with each hint's position mapped
// back to the original source and filtered to the requested range. Hints that
// land in generated scaffolding (which has no original position) are dropped.

import ts from 'typescript';
import type { InlayHint, Range } from '../protocol.ts';
import type { RequestContext } from '../request.ts';

/**
 * Which inlay-hint families to show. Mirrors VS Code's TypeScript settings so
 * the editor can enable/disable each kind. All on by default.
 */
export interface InlayHintOptions
{
    /** Master switch; when false, no hints are produced. */
    enabled?: boolean;
    /** Parameter-name hints at call sites. */
    parameterNames?: 'none' | 'literals' | 'all';
    /** Inferred types for un-annotated function parameters. */
    parameterTypes?: boolean;
    /** Inferred types for `const`/`let` declarations. */
    variableTypes?: boolean;
    /** Inferred types for class property declarations. */
    propertyDeclarationTypes?: boolean;
    /** Inferred return types for functions. */
    functionLikeReturnTypes?: boolean;
    /** Computed values for enum members. */
    enumMemberValues?: boolean;
}

/** Builds TypeScript preferences from the family toggles (defaults: all on). */
function buildPreferences(options: InlayHintOptions): ts.UserPreferences
{
    return {
        includeInlayParameterNameHints: options.parameterNames ?? 'all',
        includeInlayParameterNameHintsWhenArgumentMatchesName: false,
        includeInlayFunctionParameterTypeHints: options.parameterTypes ?? true,
        includeInlayVariableTypeHints: options.variableTypes ?? true,
        includeInlayVariableTypeHintsWhenTypeMatchesName: false,
        includeInlayPropertyDeclarationTypeHints: options.propertyDeclarationTypes ?? true,
        includeInlayFunctionLikeReturnTypeHints: options.functionLikeReturnTypes ?? true,
        includeInlayEnumMemberValueHints: options.enumMemberValues ?? true
    };
}

/** Inlay hints for the requested range, honouring the family toggles. */
export function getInlayHints(ctx: RequestContext, range: Range, options: InlayHintOptions = {}): InlayHint[]
{
    if (options.enabled === false)
    {
        return [];
    }

    const rangeStart = ctx.lineIndex.offsetAt(range.start);
    const rangeEnd = ctx.lineIndex.offsetAt(range.end);

    let hints: ts.InlayHint[];
    try
    {
        // Compute over the whole module, then map/filter - the generated offsets
        // don't line up with the requested range, so we can't pass it through.
        hints = ctx.project.service.provideInlayHints(
            ctx.virtualFile,
            { start: 0, length: ctx.virtual.code.length },
            buildPreferences(options)
        );
    }
    catch
    {
        return [];
    }

    const out: InlayHint[] = [];
    for (const hint of hints)
    {
        const original = ctx.virtual.mapping.toOriginal(hint.position);
        if (original === null || original < rangeStart || original > rangeEnd)
        {
            continue;
        }
        out.push({
            position: ctx.lineIndex.positionAt(original),
            label: hint.text,
            kind: hint.kind === ts.InlayHintKind.Type ? 1 : hint.kind === ts.InlayHintKind.Parameter ? 2 : undefined,
            paddingLeft: hint.whitespaceBefore,
            paddingRight: hint.whitespaceAfter
        });
    }
    return out;
}
