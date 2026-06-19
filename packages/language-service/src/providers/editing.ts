// Markup editing behaviours that make `.azeroth` feel like a first-class
// markup-aware language:
//
//   - auto-close tags: typing the `>` of `<div>` returns `</div>` so the editor
//     can complete the pair;
//   - linked editing: renaming an opening tag updates its closing tag live, and
//     vice-versa.
//
// Both reuse the compiler's scanner (to skip strings/expressions correctly) and
// parser (to understand structure), so a `<` inside an attribute expression
// like `title={a < b}` is never mistaken for a tag.

import { findMarkupStart, skipBalanced, skipString, isIdentStart, isIdentPart, isWhitespace } from '@azerothjs/compiler';
import { parseMarkup } from '@azerothjs/compiler';
import type { MarkupElement } from '@azerothjs/compiler';
import { collectMarkupNodes } from '../markup-model.ts';
import type { Range } from '../protocol.ts';
import type { RequestContext } from '../request.ts';

/** Void HTML elements have no closing tag, so they are never auto-closed. */
const VOID_ELEMENTS = new Set
([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/**
 * After the user types `>`, returns a snippet that closes the just-opened tag
 * (`$0</div>`), or null when there's nothing to close (self-closing tag, void
 * element, fragment, or a `>` that wasn't a tag end).
 *
 * `offset` is the position immediately after the typed `>`.
 */
export function getAutoCloseTag(ctx: RequestContext, offset: number): string | null
{
    const source = ctx.source;
    if (source[offset - 1] !== '>')
    {
        return null;
    }

    // Find the markup region the caret is in, then walk its tags forward to the
    // one whose opening tag ends exactly at the caret.
    let i = 0;
    for (;;)
    {
        const start = findMarkupStart(source, i);
        if (start === -1 || start >= offset)
        {
            return null;
        }
        let parsedEnd: number | null;
        try
        {
            parsedEnd = parseMarkup(source, start).end;
        }
        catch
        {
            parsedEnd = null;
        }

        if (parsedEnd === null || (start < offset && parsedEnd >= offset))
        {
            // This region contains (or is) the incomplete tag being typed.
            const tag = tagEndingAt(source, start, offset);
            if (tag === null || tag === '' || VOID_ELEMENTS.has(tag))
            {
                return null;
            }
            return `$0</${ tag }>`;
        }
        i = parsedEnd;
    }
}

/**
 * Walks markup tags forward from a region start, returning the name of the
 * opening tag whose `>` lands at `offset` (skipping completed children and
 * expression holes), or null.
 */
function tagEndingAt(source: string, start: number, offset: number): string | null
{
    let i = start;
    while (i < offset)
    {
        const ch = source[i];
        if (ch === '{')
        {
            i = skipBalanced(source, i);
            continue;
        }
        if (ch !== '<')
        {
            i++;
            continue;
        }

        const next = source[i + 1];
        if (next === '/')
        {
            const gt = source.indexOf('>', i);
            i = gt === -1 ? source.length : gt + 1;
            continue;
        }
        if (next === '>' || isIdentStart(next))
        {
            const open = readOpenTag(source, i);
            if (open === null)
            {
                return null;
            }
            if (open.end === offset)
            {
                return open.selfClosing ? null : open.tag;
            }
            i = open.end;
            continue;
        }
        i++;
    }
    return null;
}

/** Reads a `<...>` opening tag, returning its name, end offset, and self-closing flag. */
function readOpenTag(source: string, ltIndex: number): { tag: string; end: number; selfClosing: boolean } | null
{
    let i = ltIndex + 1;
    if (source[i] === '>')
    {
        return { tag: '', end: i + 1, selfClosing: false };
    }
    if (!isIdentStart(source[i]))
    {
        return null;
    }
    const nameStart = i;
    i++;
    while (i < source.length && (isIdentPart(source[i]) || source[i] === '.' || source[i] === '-'))
    {
        i++;
    }
    const tag = source.slice(nameStart, i);

    while (i < source.length)
    {
        const ch = source[i];
        if (isWhitespace(ch))
        {
            i++;
            continue;
        }
        if (ch === '>')
        {
            return { tag, end: i + 1, selfClosing: false };
        }
        if (ch === '/' && source[i + 1] === '>')
        {
            return { tag, end: i + 2, selfClosing: true };
        }
        if (ch === '{')
        {
            i = skipBalanced(source, i);
            continue;
        }
        if (ch === '"' || ch === '\'')
        {
            i = skipString(source, i);
            continue;
        }
        i++;
    }
    return null;
}

/**
 * Returns the opening- and closing-tag name ranges for the element under the
 * caret, so the editor can edit them together (linked editing). Null unless the
 * caret is on a tag name of an element that has a matching closing tag.
 */
export function getLinkedEditingRanges(ctx: RequestContext, offset: number): Range[] | null
{
    for (const node of collectMarkupNodes(ctx.source))
    {
        if (node.kind !== 'element' || node.tag === '')
        {
            continue;
        }
        const ranges = tagNameRanges(ctx, node);
        if (ranges === null)
        {
            continue;
        }
        const [open, close] = ranges;
        if (within(open, offset) || within(close, offset))
        {
            return [ctx.lineIndex.rangeAt(open.start, open.end), ctx.lineIndex.rangeAt(close.start, close.end)];
        }
    }
    return null;
}

/** Computes the opening/closing tag-name offset spans for an element, if it has a close tag. */
function tagNameRanges(ctx: RequestContext, node: MarkupElement): [{ start: number; end: number }, { start: number; end: number }] | null
{
    const source = ctx.source;
    const openStart = node.start + 1;
    const openEnd = openStart + node.tag.length;

    // A closing tag occupies `</tag>` ending at node.end. Verify it's really there
    // (self-closing elements end with `/>` and have no closing tag).
    const closeEnd = node.end - 1;
    const closeStart = closeEnd - node.tag.length;
    if (closeStart < openEnd
        || source[closeStart - 1] !== '/'
        || source.slice(closeStart, closeEnd) !== node.tag)
    {
        return null;
    }
    return [{ start: openStart, end: openEnd }, { start: closeStart, end: closeEnd }];
}

/** True when `offset` is inside (or touching) `[start, end]`. */
function within(span: { start: number; end: number }, offset: number): boolean
{
    return offset >= span.start && offset <= span.end;
}
