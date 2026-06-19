// CSS intelligence for the reactive `styleMap({ ... })` helper, the JS-side
// counterpart to a static `style="..."`. Its object keys are CSS property names
// written camelCase (`fontWeight`, converted to `font-weight` at runtime) and
// its string values are CSS values:
//
//   style={styleMap({ color: () => '#080', fontWeight: 'bold' })}
//
// This provider offers property-name completion + hover on the keys, CSS value
// completion inside value strings, and (via color.ts) color swatches on color
// values. Detection is a shallow scan for the enclosing `styleMap(` whose object
// the caret sits directly inside; nested calls/objects (a `() => '...'` getter)
// are left to the TypeScript bridge.

import { isWhitespace, isIdentPart } from '@azerothjs/compiler';
import { CompletionItemKind, type CompletionItem, type Hover } from '../protocol.ts';
import type { RequestContext } from '../request.ts';
import { cssPropertyCompletions, cssValueCompletions } from './css-service.ts';

/** Where the caret sits within a styleMap object. */
type StyleMapPosition =
    /** On/within a property-name key (before its `:`). */
    | { kind: 'key' }
    /** Inside a string value, after the property's `:`. */
    | { kind: 'valueString'; property: string; valueStart: number; valueEnd: number }
    /** A non-string value position (a JS expression) - left to TypeScript. */
    | { kind: 'valueExpr' };

/** Cached CSS property completions, camelCased for the object-key form. */
let camelProperties: CompletionItem[] | null = null;

/** Property-name / CSS-value completions for the caret, or `[]` if not in a styleMap. */
export function styleMapCompletions(ctx: RequestContext, offset: number): CompletionItem[]
{
    const position = styleMapPositionAt(ctx.source, offset);
    if (position === null)
    {
        return [];
    }
    if (position.kind === 'key')
    {
        return keyCompletions();
    }
    if (position.kind === 'valueString')
    {
        const valueText = ctx.source.slice(position.valueStart, position.valueEnd);
        return cssValueCompletions(toKebab(position.property), valueText, offset - position.valueStart);
    }
    return [];
}

/** Hover for a styleMap property-name key under the caret, or null. */
export function styleMapHover(ctx: RequestContext, offset: number): Hover | null
{
    const position = styleMapPositionAt(ctx.source, offset);
    if (position === null || position.kind !== 'key')
    {
        return null;
    }
    const word = identifierAround(ctx.source, offset);
    if (word === '')
    {
        return null;
    }
    const property = properties().find(item => item.label === word);
    if (!property || !property.documentation)
    {
        return null;
    }
    let start = offset;
    while (start > 0 && isIdentPart(ctx.source[start - 1]))
    {
        start--;
    }
    return { contents: `**${ word }** - CSS property\n\n${ property.documentation }`, range: ctx.lineIndex.rangeAt(start, start + word.length) };
}

/** Whether the caret is anywhere inside a styleMap object (key or value). */
export function inStyleMap(source: string, offset: number): boolean
{
    return styleMapPositionAt(source, offset) !== null;
}

/**
 * Content spans of every top-level string *value* in every `styleMap({ ... })`
 * in the source. Powers color swatches on string color values; non-color values
 * simply contribute no swatch.
 */
export function styleMapColorValueSpans(source: string): { start: number; end: number }[]
{
    const spans: { start: number; end: number }[] = [];
    const open = /\bstyleMap\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = open.exec(source)) !== null)
    {
        const objStart = objectStart(source, match.index + match[0].length - 1);
        if (objStart === -1)
        {
            open.lastIndex = match.index + match[0].length;
            continue;
        }
        let i = objStart + 1;
        let depth = 0;
        let afterColon = false;
        for (; i < source.length; i++)
        {
            const ch = source[i];
            if (ch === '"' || ch === '\'' || ch === '`')
            {
                const end = skipStringContent(source, i);
                if (depth === 0 && afterColon)
                {
                    spans.push({ start: i + 1, end });
                }
                i = end;
                continue;
            }
            if (ch === '{' || ch === '(' || ch === '[')
            {
                depth++;
            }
            else if (ch === '}' || ch === ')' || ch === ']')
            {
                if (depth === 0)
                {
                    break;
                }
                depth--;
            }
            else if (depth === 0)
            {
                if (ch === ',')
                {
                    afterColon = false;
                }
                else if (ch === ':')
                {
                    afterColon = true;
                }
            }
        }
        open.lastIndex = i;
    }
    return spans;
}

// --- detection ---

/** Classifies the caret within an enclosing styleMap object, or null. */
function styleMapPositionAt(source: string, offset: number): StyleMapPosition | null
{
    const call = openStyleMapCall(source, offset);
    if (call === null)
    {
        return null;
    }
    const objStart = objectStart(source, call);
    if (objStart === -1 || objStart >= offset)
    {
        return null;
    }

    let i = objStart + 1;
    let depth = 0;
    let entryStart = i;
    let colon = -1;
    while (i < offset)
    {
        const ch = source[i];
        if (ch === '"' || ch === '\'' || ch === '`')
        {
            const end = skipStringContent(source, i);
            if (offset > i && offset <= end)
            {
                // The caret is inside this string: a value (after `:`) at the
                // object's top level is a CSS value; anything else isn't ours.
                if (depth === 0 && colon !== -1)
                {
                    const property = cssPropertyKey(source.slice(entryStart, colon));
                    return property === null ? null : { kind: 'valueString', property, valueStart: i + 1, valueEnd: end };
                }
                return null;
            }
            i = end + 1;
            continue;
        }
        if (ch === '{' || ch === '(' || ch === '[')
        {
            depth++;
        }
        else if (ch === '}' || ch === ')' || ch === ']')
        {
            if (depth === 0)
            {
                return null;
            }
            depth--;
        }
        else if (depth === 0)
        {
            if (ch === ',')
            {
                entryStart = i + 1;
                colon = -1;
            }
            else if (ch === ':' && colon === -1)
            {
                colon = i;
            }
        }
        i++;
    }
    if (depth !== 0)
    {
        return null;
    }
    return colon === -1 ? { kind: 'key' } : { kind: 'valueExpr' };
}

/** The offset of an unclosed `styleMap(`'s `(` enclosing `offset`, or null. */
function openStyleMapCall(source: string, offset: number): number | null
{
    const open = /\bstyleMap\s*\(/g;
    let best: number | null = null;
    let match: RegExpExecArray | null;
    while ((match = open.exec(source)) !== null)
    {
        const paren = match.index + match[0].length - 1;
        if (paren >= offset)
        {
            break;
        }
        let depth = 0;
        for (let i = paren; i < offset && i < source.length; i++)
        {
            const ch = source[i];
            // Skip string/template content so a paren inside a value (e.g. a CSS
            // `calc(...)`/`url(...)` or a `)` in a content string) doesn't desync
            // the depth count - matching the main object-scan loop above.
            if (ch === '"' || ch === '\'' || ch === '`')
            {
                i = skipStringContent(source, i);
                continue;
            }
            if (ch === '(')
            {
                depth++;
            }
            else if (ch === ')')
            {
                depth--;
            }
        }
        if (depth > 0)
        {
            best = paren;
        }
    }
    return best;
}

/** The `{` offset of the object literal that is `styleMap(`'s argument, or -1. */
function objectStart(source: string, paren: number): number
{
    let i = paren + 1;
    while (i < source.length && isWhitespace(source[i]))
    {
        i++;
    }
    return source[i] === '{' ? i : -1;
}

/**
 * Normalises a styleMap object key to a plain CSS property name, or null when it
 * isn't one - a computed `[expr]` key, a spread, or any non-identifier - so we
 * never feed a bogus property to the CSS value engine.
 */
function cssPropertyKey(raw: string): string | null
{
    let key = raw.trim();
    const quote = key[0];
    if ((quote === '\'' || quote === '"' || quote === '`') && key[key.length - 1] === quote)
    {
        key = key.slice(1, -1);
    }
    // A real property is camelCase or kebab-case; reject computed keys, spreads,
    // and anything with brackets/dots/spaces.
    return /^-?[A-Za-z][A-Za-z0-9-]*$/.test(key) ? key : null;
}

/** Offset of the closing quote of the string opening at `quote`. */
function skipStringContent(source: string, quote: number): number
{
    const q = source[quote];
    let j = quote + 1;
    while (j < source.length && source[j] !== q && source[j] !== '\n')
    {
        if (source[j] === '\\')
        {
            j++;
        }
        j++;
    }
    return j;
}

/** The JS identifier the caret sits within, or `''`. */
function identifierAround(source: string, offset: number): string
{
    let start = offset;
    while (start > 0 && isIdentPart(source[start - 1]))
    {
        start--;
    }
    let end = offset;
    while (end < source.length && isIdentPart(source[end]))
    {
        end++;
    }
    return source.slice(start, end);
}

// --- vocabulary ---

/** CSS property completions, computed once and reused. */
function properties(): CompletionItem[]
{
    if (camelProperties === null)
    {
        camelProperties = cssPropertyCompletions().map(item => ({
            ...item,
            label: toCamel(item.label),
            insertText: toCamel(item.label),
            kind: CompletionItemKind.Property,
            filterText: toCamel(item.label)
        }));
    }
    return camelProperties;
}

/** Property-name completions for a styleMap key, each inserting `name: `. */
function keyCompletions(): CompletionItem[]
{
    return properties().map(item => ({
        ...item,
        insertText: `${ item.label }: `,
        sortText: `0_${ item.label }`
    }));
}

/** `background-color` -> `backgroundColor` (and `-webkit-x` -> `WebkitX`). */
function toCamel(kebab: string): string
{
    return kebab.replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase());
}

/** `backgroundColor` -> `background-color` (and `WebkitX` -> `-webkit-x`). */
function toKebab(camel: string): string
{
    return camel.replace(/[A-Z]/g, match => `-${ match.toLowerCase() }`);
}
