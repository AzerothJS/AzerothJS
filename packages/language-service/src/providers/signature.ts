// Signature help. A direct TypeScript query at the mapped offset, so it works
// inside any expression hole or attribute expression - and because components
// compile to `Component({ ...props })` calls, it also surfaces a component's
// prop signature while you fill in its attributes.

import ts from 'typescript';
import type { SignatureHelp, SignatureInformation } from '../protocol.ts';
import { toGenerated, type RequestContext } from '../request.ts';

/** Signature help for the call enclosing `offset`, or null. */
export function getSignatureHelp(ctx: RequestContext, offset: number): SignatureHelp | null
{
    const generated = toGenerated(ctx, offset);
    if (generated === null)
    {
        return null;
    }

    const help = ctx.project.service.getSignatureHelpItems(ctx.virtualFile, generated, undefined);
    if (!help || help.items.length === 0)
    {
        return null;
    }

    const signatures: SignatureInformation[] = help.items.map((item) =>
    {
        const prefix = ts.displayPartsToString(item.prefixDisplayParts);
        const separator = ts.displayPartsToString(item.separatorDisplayParts);
        const suffix = ts.displayPartsToString(item.suffixDisplayParts);
        const parameters = item.parameters.map(parameter => ({
            label: ts.displayPartsToString(parameter.displayParts),
            documentation: ts.displayPartsToString(parameter.documentation) || undefined
        }));
        const label = prefix + parameters.map(parameter => parameter.label).join(separator) + suffix;
        return {
            label,
            documentation: ts.displayPartsToString(item.documentation) || undefined,
            parameters
        };
    });

    return {
        signatures,
        activeSignature: help.selectedItemIndex,
        activeParameter: help.argumentIndex
    };
}
