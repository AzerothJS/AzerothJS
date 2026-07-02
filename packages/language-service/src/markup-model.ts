// Understands *where* a caret sits inside a `.azeroth` file so the providers
// can ask the right question: a tag-name position wants element/component
// suggestions, an attribute-name position wants the tag's attributes, and an
// expression position (`{ ... }` hole or `attr={ ... }`) is plain TypeScript
// that the type bridge answers.
//
// It reuses the compiler's scanner (findMarkupStart) and parser (parseMarkup)
// to locate and descend markup - including markup nested inside expression
// holes, which it re-scans recursively the same way the compiler does. Parsing
// is wrapped in try/catch because an editor buffer is constantly half-typed
// (`<div clas`); when the region under the caret doesn't parse yet, a resilient
// local scan still classifies it so completion keeps working as you type.

import { findMarkupStart, skipBalanced, skipString, skipTemplate, isIdentPart, isWhitespace, parseModule } from '@azerothjs/compiler';
import { parseMarkup, CompileError } from '@azerothjs/compiler';
import type { MarkupElement, MarkupFragment, MarkupChild } from '@azerothjs/compiler';

/** The syntactic role of a caret position, used to pick a completion strategy. */
export type PositionContext =
    /** Typing an element/component tag name (after `<` or `</`). */
    | { kind: 'tagName'; partial: string; closing: boolean }
    /** Typing an attribute/event name inside an opening tag. */
    | { kind: 'attributeName'; tag: string; partial: string }
    /** Inside a static `attr="..."` value. */
    | { kind: 'attributeValue'; tag: string; attribute: string }
    /** Inside a `{ ... }` hole or `attr={ ... }` - plain TypeScript. */
    | { kind: 'expression' }
    /** Element text content. */
    | { kind: 'text' }
    /** Outside any markup - plain TypeScript. */
    | { kind: 'script' };

/**
 * Classifies the caret at `offset`. Resilient to incomplete markup.
 *
 * @example
 * ```ts
 * classifyPosition('const x = <div cla', 18); // { kind: 'attributeName', tag: 'div', partial: 'cla' }
 * classifyPosition('const x = <di', 13);       // { kind: 'tagName', partial: 'di', closing: false }
 * classifyPosition('const x = <p>{count(', 20);// { kind: 'expression' }
 * ```
 */
export function classifyPosition(source: string, offset: number): PositionContext
{
    // A tag name being typed (`<div`, `</sec`, `<Cou`) is detected directly,
    // independent of whether the surrounding markup currently parses - while
    // you type a new element the region is momentarily broken, and the
    // structural walk below would otherwise misread the caret as text/script.
    const typed = tagNameBeingTyped(source, offset);
    if (typed !== null)
    {
        return { kind: 'tagName', partial: typed.partial, closing: typed.closing };
    }
    return classifyInRange(source, 0, source.length, offset, 'script');
}

/** Keywords after which a `<` begins an expression (so markup, not a compare). */
const TAG_EXPR_KEYWORDS = new Set
([
    'return', 'do', 'else', 'yield', 'await', 'case', 'delete', 'void', 'new', 'in', 'of', 'typeof', 'instanceof'
]);

/**
 * If the caret sits at the end of a tag-name run that follows `<` (or `</`) in
 * expression position, returns the partial name; otherwise null. The
 * expression-position test distinguishes `<div` (a tag) from `a < b` or
 * `createSignal<Todo` (a comparison / generic).
 */
function tagNameBeingTyped(source: string, offset: number): { partial: string; closing: boolean } | null
{
    let i = offset;
    while (i > 0 && (isIdentPart(source[i - 1]) || source[i - 1] === '.' || source[i - 1] === '-'))
    {
        i--;
    }

    let lt: number;
    let closing = false;
    if (i > 0 && source[i - 1] === '<')
    {
        lt = i - 1;
    }
    else if (i > 1 && source[i - 1] === '/' && source[i - 2] === '<')
    {
        lt = i - 2;
        closing = true;
    }
    else
    {
        return null;
    }

    // Significant character before the `<` decides tag vs. operator.
    let k = lt - 1;
    while (k >= 0 && (source[k] === ' ' || source[k] === '\t'))
    {
        k--;
    }
    const partial = source.slice(i, offset);
    if (k < 0)
    {
        return { partial, closing };
    }
    const prev = source[k];
    if (isIdentPart(prev))
    {
        // An identifier/number before `<` means a compare/generic - unless it's
        // a keyword like `return` after which an expression (markup) begins.
        let w = k;
        while (w >= 0 && isIdentPart(source[w]))
        {
            w--;
        }
        return TAG_EXPR_KEYWORDS.has(source.slice(w + 1, k + 1)) ? { partial, closing } : null;
    }
    if (prev === ')' || prev === ']')
    {
        return null;
    }
    return { partial, closing };
}

/**
 * Walks `[lo, hi)` looking for the markup region containing `offset`. `base` is
 * the context that applies to plain text in this range: `script` at the top
 * level, `expression` inside an expression hole.
 */
function classifyInRange(source: string, lo: number, hi: number, offset: number, base: 'script' | 'expression'): PositionContext
{
    let i = lo;
    for (;;)
    {
        const m = findMarkupStart(source, i);
        if (m === -1 || m >= hi || m > offset)
        {
            return { kind: base };
        }

        let node: MarkupElement | MarkupFragment;
        let end: number;
        try
        {
            ({ node, end } = parseMarkup(source, m));
        }
        catch (err)
        {
            // Incomplete markup under or before the caret: fall back to a
            // resilient local scan so completion still fires mid-type.
            if (err instanceof CompileError && offset >= m)
            {
                return localScan(source, m, offset);
            }
            return { kind: base };
        }

        if (offset < end)
        {
            return classifyNode(source, node, offset);
        }
        i = end;
    }
}

/** Classifies a caret known to fall within a parsed element/fragment. */
function classifyNode(source: string, node: MarkupElement | MarkupFragment, offset: number): PositionContext
{
    if (node.kind === 'element')
    {
        const nameStart = node.start + 1;
        const nameEnd = nameStart + node.tag.length;

        if (offset >= nameStart && offset <= nameEnd)
        {
            return { kind: 'tagName', partial: source.slice(nameStart, offset), closing: false };
        }

        const openEnd = openTagEnd(source, node);
        if (offset <= openEnd)
        {
            for (const attr of node.attributes)
            {
                if (attr.value.kind === 'expression' || attr.spread)
                {
                    const brace = source.indexOf('{', attr.start);
                    const close = attr.end;
                    if (offset > brace && offset < close)
                    {
                        return classifyInRange(source, brace + 1, close - 1, offset, 'expression');
                    }
                }
                else if (attr.value.kind === 'static')
                {
                    // Within the quoted value (attr.end is just past the close quote).
                    const eq = source.indexOf('=', attr.start);
                    if (eq !== -1 && offset > eq && offset < attr.end)
                    {
                        return { kind: 'attributeValue', tag: node.tag, attribute: attr.name ?? '' };
                    }
                }
            }
            return { kind: 'attributeName', tag: node.tag, partial: identifierBefore(source, offset) };
        }
    }

    for (const child of node.children)
    {
        if (offset >= child.start && offset < child.end)
        {
            return classifyChild(source, child, offset);
        }
    }
    return { kind: 'text' };
}

/** Classifies a caret within a specific child node. */
function classifyChild(source: string, child: MarkupChild, offset: number): PositionContext
{
    if (child.kind === 'expression')
    {
        return classifyInRange(source, child.start + 1, child.end - 1, offset, 'expression');
    }
    if (child.kind === 'element' || child.kind === 'fragment')
    {
        return classifyNode(source, child, offset);
    }
    return { kind: 'text' };
}

/**
 * Last-resort classifier for an unparseable (half-typed) tag starting at the
 * `<` index `ltIndex`. Lexes forward to the caret, tracking whether we're in
 * the tag name, an attribute name, a quoted value, or an expression value.
 */
function localScan(source: string, ltIndex: number, offset: number): PositionContext
{
    let i = ltIndex + 1;
    const closing = source[i] === '/';
    if (closing)
    {
        i++;
    }

    const nameStart = i;
    while (i < offset && (isIdentPart(source[i]) || source[i] === '.' || source[i] === '-'))
    {
        i++;
    }
    const tag = source.slice(nameStart, i);

    if (offset <= i)
    {
        return { kind: 'tagName', partial: source.slice(nameStart, offset), closing };
    }

    // Past the tag name: lex attributes up to the caret.
    while (i < offset)
    {
        const ch = source[i];
        if (ch === '>')
        {
            return { kind: 'text' };
        }
        if (ch === '=')
        {
            // The attribute name is the identifier run just before the `=` (after
            // any whitespace) - captured so a half-typed `class="...`/`style="...`
            // still routes to the right value vocabulary before the tag closes.
            const attribute = attributeNameBefore(source, i);
            i++;
            while (i < offset && isWhitespace(source[i]))
            {
                i++;
            }
            const v = source[i];
            if (v === '{')
            {
                return classifyInRange(source, i + 1, offset + 1, offset, 'expression');
            }
            if (v === '"' || v === '\'')
            {
                let j = i + 1;
                while (j < offset && source[j] !== v)
                {
                    j++;
                }
                if (j >= offset)
                {
                    return { kind: 'attributeValue', tag, attribute };
                }
                i = j + 1;
                continue;
            }
            i++;
            continue;
        }
        i++;
    }
    return { kind: 'attributeName', tag, partial: identifierBefore(source, offset) };
}

/** The attribute name immediately before `eq` (an `=`), skipping whitespace. */
function attributeNameBefore(source: string, eq: number): string
{
    let end = eq - 1;
    while (end >= 0 && isWhitespace(source[end]))
    {
        end--;
    }
    let start = end + 1;
    while (start > 0 && (isIdentPart(source[start - 1]) || source[start - 1] === '-' || source[start - 1] === ':'))
    {
        start--;
    }
    return source.slice(start, end + 1);
}

/** Returns the identifier-ish run ending at `offset` (what the user has typed). */
function identifierBefore(source: string, offset: number): string
{
    let s = offset;
    while (s > 0 && (isIdentPart(source[s - 1]) || source[s - 1] === '-' || source[s - 1] === ':'))
    {
        s--;
    }
    return source.slice(s, offset);
}

/** Offset just past an element's opening tag (`>` or `/>`). */
function openTagEnd(source: string, node: MarkupElement): number
{
    let p = node.start + 1 + node.tag.length;
    for (const attr of node.attributes)
    {
        if (attr.end > p)
        {
            p = attr.end;
        }
    }
    const gt = source.indexOf('>', p);
    return gt === -1 ? source.length : gt + 1;
}

/**
 * Collects every markup node in the file, descending into expression holes,
 * skipping regions that don't parse. Powers folding ranges and semantic
 * highlighting.
 *
 * @example
 * ```ts
 * collectMarkupNodes('const x = <ul>{items.map(i => <li/>)}</ul>;').length; // 2
 * ```
 */
export function collectMarkupNodes(source: string): (MarkupElement | MarkupFragment)[]
{
    const nodes: (MarkupElement | MarkupFragment)[] = [];
    collectInRange(source, 0, source.length, nodes);
    return nodes;
}

/**
 * Scans `source` between `lo` and `hi` for markup that begins there, handing
 * each parsed node to {@link collectNode}. Split out from the public
 * {@link collectMarkupNodes} so the recursion can re-enter any sub-range - the
 * inside of an attribute or child expression's braces - and find markup nested
 * within it. A parse failure ends the scan for this range instead of throwing.
 */
function collectInRange(source: string, lo: number, hi: number, out: (MarkupElement | MarkupFragment)[]): void
{
    let i = lo;
    for (;;)
    {
        const m = findMarkupStart(source, i);
        if (m === -1 || m >= hi)
        {
            return;
        }
        let node: MarkupElement | MarkupFragment;
        let end: number;
        try
        {
            ({ node, end } = parseMarkup(source, m));
        }
        catch
        {
            return;
        }
        collectNode(source, node, out);
        i = end;
    }
}

/**
 * Adds `node` to `out`, then descends into the expression slots it owns - an
 * element's `{ ... }` attribute values and children, a fragment's children - so
 * markup written inside those expressions is collected as well.
 */
function collectNode(source: string, node: MarkupElement | MarkupFragment, out: (MarkupElement | MarkupFragment)[]): void
{
    out.push(node);
    if (node.kind === 'element')
    {
        for (const attr of node.attributes)
        {
            if (attr.value.kind === 'expression' || attr.spread)
            {
                const brace = source.indexOf('{', attr.start);
                if (brace !== -1)
                {
                    collectInRange(source, brace + 1, skipBalanced(source, brace) - 1, out);
                }
            }
        }
    }
    for (const child of node.children)
    {
        if (child.kind === 'expression')
        {
            collectInRange(source, child.start + 1, child.end - 1, out);
        }
        else if (child.kind === 'element' || child.kind === 'fragment')
        {
            collectNode(source, child, out);
        }
    }
}

/**
 * The innermost element whose *opening tag* contains `offset` (so the caret is
 * in its attribute area), searching markup nested in holes too. Used to resolve
 * a component's props type for attribute completion/hover.
 *
 * @example
 * ```ts
 * enclosingElement('const x = <Counter start={0}/>;', 20)?.tag; // 'Counter'
 * ```
 */
/**
 * When `offset` sits inside a `with { ... }` options clause, returns the authoring keyword that owns
 * it (`state` | `derived` | `deferred` | `effect` | `watch` | `resource` | `stream` | `selector`); null
 * otherwise. A provider maps the
 * returned keyword to its option set. The compiler parser supplies the clause's exact span, so this
 * is accurate across brace styles and nesting (no hand-rolled brace matching). The parser is total
 * (it never throws), but a malformed buffer is guarded all the same.
 */
/** A caret sitting inside a keyword's `with { ... }` options clause. */
export interface WithClauseContext
{
    /** The owning declaration keyword (`state`, `form`, ...). */
    keyword: string;
    /** Offset of the clause's opening `{`. */
    optionsStart: number;
    /** Offset of the clause's closing `}`. */
    optionsEnd: number;
    /**
     * True when the caret is at a top-level OPTION-KEY position - directly in the options object, before any
     * `:`, so a NEW key is being typed. False when the caret is inside a value expression (e.g. a
     * `validateForm: (values) => ...` body), where option-key completion must NOT fire so TypeScript's own
     * completion (member access on the typed value) takes over.
     */
    atOptionKey: boolean;
}

/** The `with { ... }` clause whose braces enclose `offset`, or null. */
export function withClauseAt(source: string, offset: number): WithClauseContext | null
{
    let module;
    try
    {
        module = parseModule(source);
    }
    catch
    {
        return null;
    }
    for (const item of module.items)
    {
        if (item.kind !== 'component')
        {
            continue;
        }
        for (const bodyItem of item.body)
        {
            if ('optionsStart' in bodyItem
                && bodyItem.optionsStart !== null
                && bodyItem.optionsEnd !== null
                && offset > bodyItem.optionsStart
                && offset < bodyItem.optionsEnd)
            {
                return {
                    keyword: bodyItem.kind,
                    optionsStart: bodyItem.optionsStart,
                    optionsEnd: bodyItem.optionsEnd,
                    atOptionKey: atTopLevelOptionKey(source, bodyItem.optionsStart, offset)
                };
            }
        }
    }
    return null;
}

/** The owning keyword of the `with { ... }` clause enclosing `offset`, or null. */
export function withClauseKeyword(source: string, offset: number): string | null
{
    return withClauseAt(source, offset)?.keyword ?? null;
}

/**
 * Scans the options object from its `{` to the caret, tracking nesting depth (skipping strings, templates,
 * and comments). The caret is at a top-level KEY position iff it is at depth 0 (directly in the object, not
 * inside a nested `{`/`(`/`[`) AND no top-level `:` has appeared since the object start or the last top-level
 * `,` - i.e. a key is being typed, not a value. So `with { validate: {...}, |x }` is a key position, but
 * `with { validateForm: (values) => values.| }` is not (a `:` precedes the caret at top level).
 */
function atTopLevelOptionKey(source: string, optionsStart: number, offset: number): boolean
{
    let i = optionsStart + 1;
    let depth = 0;
    let sawColon = false;
    while (i < offset)
    {
        const ch = source[i];
        if (ch === '"' || ch === '\'')
        {
            i = skipString(source, i);
            continue;
        }
        if (ch === '`')
        {
            i = skipTemplate(source, i);
            continue;
        }
        if (ch === '/' && source[i + 1] === '/')
        {
            while (i < offset && source[i] !== '\n')
            {
                i++;
            }
            continue;
        }
        if (ch === '/' && source[i + 1] === '*')
        {
            i += 2;
            while (i < offset && !(source[i] === '*' && source[i + 1] === '/'))
            {
                i++;
            }
            i += 2;
            continue;
        }
        if (ch === '{' || ch === '(' || ch === '[')
        {
            depth++;
        }
        else if (ch === '}' || ch === ')' || ch === ']')
        {
            depth--;
        }
        else if (depth === 0 && ch === ',')
        {
            sawColon = false;
        }
        else if (depth === 0 && ch === ':')
        {
            sawColon = true;
        }
        i++;
    }
    return depth === 0 && !sawColon;
}

/**
 * Finds the innermost markup element whose span contains `offset`, or null when the offset is not
 * inside any element. Used by the providers that need the element under the cursor (attribute
 * completion, hover on a tag, and the like).
 *
 * @param source - The full `.azeroth` source.
 * @param offset - A source offset (caret position).
 * @returns The innermost containing element, or null.
 */
export function enclosingElement(source: string, offset: number): MarkupElement | null
{
    let best: MarkupElement | null = null;
    for (const node of collectMarkupNodes(source))
    {
        if (node.kind !== 'element')
        {
            continue;
        }
        const openEnd = openTagEnd(source, node);
        if (offset >= node.start && offset <= openEnd && (best === null || node.start > best.start))
        {
            best = node;
        }
    }
    return best;
}
