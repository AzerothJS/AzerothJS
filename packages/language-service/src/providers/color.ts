// Document colors: render a swatch next to every CSS color literal in a
// `.azeroth` file, in the two places CSS appears - a static `style="..."`
// attribute (a declaration list) and a css`` template (a full stylesheet).
// Both are handed to vscode-css-languageservice via css-service, which maps the
// swatch ranges back to the original source. `style={...}` is a JS expression and
// is left to the TypeScript bridge, never reached here.

import { collectMarkupNodes } from '../markup-model.ts';
import { type RequestContext } from '../request.ts';
import type { Color, ColorInformation, ColorPresentation, Range } from '../protocol.ts';
import {
    cssColorPresentations,
    cssColors,
    cssTemplateSpans,
    styleRegion,
    templateRegion,
    type CssRegion
} from './css-service.ts';

/**
 * Color swatches for every static `style="..."` value and css`` template in the
 * document. Collects the CSS regions, runs the wrapped CSS service over each,
 * and returns the located colors with source-mapped ranges. Never throws.
 */
export function getDocumentColors(ctx: RequestContext): ColorInformation[]
{
    try
    {
        const regions: CssRegion[] = [];
        for (const span of styleValueSpans(ctx.source))
        {
            regions.push(styleRegion(ctx.source, span.start, span.end));
        }
        for (const span of cssTemplateSpans(ctx.source))
        {
            regions.push(templateRegion(ctx.source, span.start, span.end));
        }
        return cssColors(ctx.source, regions, ctx.lineIndex);
    }
    catch
    {
        return [];
    }
}

/** The spelling choices for a picked color at `range` (delegated to the CSS service). */
export function getColorPresentations(_ctx: RequestContext, color: Color, range: Range): ColorPresentation[]
{
    return cssColorPresentations(color, range);
}

/** The `[start, end)` content span of every static `style="..."` value in the source. */
function styleValueSpans(source: string): { start: number; end: number }[]
{
    const spans: { start: number; end: number }[] = [];
    for (const node of collectMarkupNodes(source))
    {
        if (node.kind !== 'element')
        {
            continue;
        }
        for (const attr of node.attributes)
        {
            if (attr.name !== 'style' || attr.value.kind !== 'static')
            {
                continue;
            }
            const eq = source.indexOf('=', attr.start);
            if (eq === -1)
            {
                continue;
            }
            const quote = source[eq + 1];
            if (quote !== '"' && quote !== '\'')
            {
                continue;
            }
            // attr.end sits just past the closing quote; the value is between them.
            spans.push({ start: eq + 2, end: attr.end - 1 });
        }
    }
    return spans;
}
