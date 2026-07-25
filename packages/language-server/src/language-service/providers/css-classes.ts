// CSS class intelligence inside markup: completion, hover, and go-to-definition
// for the class names a `.azeroth` file references. The names come from the
// project's own stylesheets and css`` templates via the workspace StyleIndex;
// this module's job is purely to recognise *where* a class is being written and
// *which* token the caret sits on.
//
// Three authoring forms count as a class value:
// - a static attribute:        class="btn btn-lg"
// - the reactive helper's keys: class={classList({ 'btn': true, active: f })}
// - any string in the binding:  class={cond ? 'on' : 'off'}
//
// Tailwind utilities are deliberately NOT handled here - Tailwind ships its own
// first-class editor tooling (the VS Code "Tailwind CSS IntelliSense" extension,
// JetBrains' bundled support), which the editors expose to `.azeroth` files via
// their language registration. This provider is for the project's *own* classes.

import { isWhitespace } from '@azerothjs/compiler';
import { classifyPosition } from '../markup-model.ts';
import { pathToUri } from '../uri.ts';
import { CompletionItemKind, type CompletionItem, type Hover, type Location } from '../protocol.ts';
import type { RequestContext } from '../request.ts';

/** A class token under the caret, with the enclosing value's bounds. */
interface ClassToken
{
    /** Offset of the token's first character. */
    start: number;
    /** Offset just past the token's last character. */
    end: number;
    /** The whole class name the caret sits on (`''` between tokens). */
    word: string;
    /** Bounds of the surrounding class value (attribute value or string body). */
    valueStart: number;
    valueEnd: number;
}

/** Class-name completions for the caret, or `[]` when it isn't in a class value. */
export function classCompletions(ctx: RequestContext, offset: number): CompletionItem[]
{
    if (classValue(ctx.source, offset) === null)
    {
        return [];
    }
    return ctx.project.getStyleIndex().unique().map(def => ({
        label: def.name,
        kind: CompletionItemKind.Value,
        detail: `class - ${ basename(def.file) }`,
        documentation: fence(def.rule),
        sortText: `0_${ def.name }`,
        filterText: def.name
    }));
}

/** Hover for the class name under the caret (its CSS rule(s)), or null. */
export function classHover(ctx: RequestContext, offset: number): Hover | null
{
    const token = classTokenAt(ctx.source, offset);
    if (token === null || token.word === '')
    {
        return null;
    }
    const defs = ctx.project.getStyleIndex().byName(token.word);
    if (defs.length === 0)
    {
        return null;
    }
    const contents = defs
        .map(def => `${ fence(def.rule) }\n\n*${ basename(def.file) }*`)
        .join('\n\n---\n\n');
    return { contents, range: ctx.lineIndex.rangeAt(token.start, token.end) };
}

/** Definition location(s) of the class name under the caret. */
export function classDefinition(ctx: RequestContext, offset: number): Location[]
{
    const token = classTokenAt(ctx.source, offset);
    if (token === null || token.word === '')
    {
        return [];
    }
    return ctx.project.getStyleIndex().byName(token.word).map(def => ({
        uri: pathToUri(def.file),
        range: def.range
    }));
}

/** Whether the caret sits inside any class value (static attribute or binding string). */
export function inClassValue(source: string, offset: number): boolean
{
    return classValue(source, offset) !== null;
}

// --- context detection ---

/** The class value (attribute value or string body) the caret is in, or null. */
function classValue(source: string, offset: number): { start: number; end: number } | null
{
    // Static `class="..."`: the markup model already classifies the caret.
    const context = classifyPosition(source, offset);
    if (context.kind === 'attributeValue' && context.attribute === 'class')
    {
        const span = quotedValueSpan(source, offset);
        if (span !== null)
        {
            return span;
        }
    }
    // `classList({ '...': ... })` or `class={ '...' }`: a string in the binding.
    const construct = classConstructStart(source, offset);
    if (construct !== null)
    {
        return stringSpanFrom(source, construct, offset);
    }
    return null;
}

/** The class token the caret sits on within its value, or null. */
function classTokenAt(source: string, offset: number): ClassToken | null
{
    const value = classValue(source, offset);
    if (value === null)
    {
        return null;
    }
    let start = offset;
    while (start > value.start && !isWhitespace(source[start - 1]))
    {
        start--;
    }
    let end = offset;
    while (end < value.end && !isWhitespace(source[end]))
    {
        end++;
    }
    return { start, end, word: source.slice(start, end), valueStart: value.start, valueEnd: value.end };
}

/** Span of a quoted attribute value containing `offset` (content only), or null. */
function quotedValueSpan(source: string, offset: number): { start: number; end: number } | null
{
    let i = offset - 1;
    while (i >= 0 && source[i] !== '"' && source[i] !== '\'' && source[i] !== '\n' && source[i] !== '>')
    {
        i--;
    }
    if (i < 0 || (source[i] !== '"' && source[i] !== '\''))
    {
        return null;
    }
    const quote = source[i];
    let j = offset;
    while (j < source.length && source[j] !== quote && source[j] !== '\n' && source[j] !== '>')
    {
        j++;
    }
    return { start: i + 1, end: j };
}

/**
 * If the caret is inside an open `classList(` call or an open `class={` binding,
 * returns the offset of that opener; otherwise null. "Open" means the bracket it
 * introduces is still unbalanced at `offset`, so only the construct the caret is
 * actually nested in qualifies.
 */
function classConstructStart(source: string, offset: number): number | null
{
    const call = openConstruct(source, offset, /\bclassList\s*\(/g, '(', ')');
    if (call !== null)
    {
        return call;
    }
    return openConstruct(source, offset, /\bclass\s*=\s*\{/g, '{', '}');
}

/**
 * The opener offset of the innermost match of `pattern` whose `open` bracket is
 * still unbalanced at `offset`. The opener is the last character of the match
 * (the `(` or `{`).
 */
function openConstruct(source: string, offset: number, pattern: RegExp, open: string, close: string): number | null
{
    pattern.lastIndex = 0;
    let best: number | null = null;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null)
    {
        const opener = match.index + match[0].length - 1;
        if (opener >= offset)
        {
            break;
        }
        if (isUnbalanced(source, opener, offset, open, close))
        {
            best = opener;
        }
    }
    return best;
}

/**
 * Whether `open` at `from` is still unclosed at `offset` (bracket depth > 0).
 * Skips string literals so a bracket inside one - `classList({ ')': true })` -
 * doesn't throw off the count.
 */
function isUnbalanced(source: string, from: number, offset: number, open: string, close: string): boolean
{
    let depth = 0;
    for (let i = from; i < offset && i < source.length; i++)
    {
        const ch = source[i];
        if (ch === '"' || ch === '\'' || ch === '`')
        {
            i = skipStringLiteral(source, i);
            continue;
        }
        if (ch === open)
        {
            depth++;
        }
        else if (ch === close)
        {
            depth--;
        }
    }
    return depth > 0;
}

/** Index of the closing quote of the string opening at `quote` (single-line). */
function skipStringLiteral(source: string, quote: number): number
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

/**
 * Scanning forward from `from`, the content span of the string literal the caret
 * sits in, or null. Strings are bounded to a single line so a half-typed
 * `'btn` never swallows the rest of the file.
 */
function stringSpanFrom(source: string, from: number, offset: number): { start: number; end: number } | null
{
    let i = from;
    while (i < source.length)
    {
        const ch = source[i];
        if (ch === '"' || ch === '\'' || ch === '`')
        {
            const start = i + 1;
            let j = start;
            while (j < source.length && source[j] !== ch && source[j] !== '\n')
            {
                if (source[j] === '\\')
                {
                    j++;
                }
                j++;
            }
            if (offset > i && offset <= j)
            {
                return { start, end: j };
            }
            i = j + 1;
            continue;
        }
        i++;
    }
    return null;
}

/** Last path segment of a forward-slashed or back-slashed path. */
function basename(file: string): string
{
    const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
    return slash === -1 ? file : file.slice(slash + 1);
}

/** Wraps CSS in a fenced markdown block for hover/documentation. */
function fence(css: string): string
{
    return `\`\`\`css\n${ css }\n\`\`\``;
}
