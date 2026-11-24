/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Context-aware lexing helpers that find markup inside arbitrary JS/TS without a full parser.
 * Two jobs:
 *   1. Skip non-code spans correctly - line/block comments, single/double quoted strings, template
 *      literals (with nested `${ ... }`), and regex literals - so a `<`, `{`, or `}` inside them is
 *      never mistaken for syntax.
 *   2. Decide whether a `<` (or `/`) sits in EXPRESSION position, which distinguishes markup from a
 *      less-than operator, and a regex from a divide. The shared structural cursor tracks the lexical
 *      goal across tokens, delimiters and statement heads.
 *
 * These are pure functions over (src, index) -> nextIndex, shared with the parser (which also needs
 * balanced-brace capture for `{...}` holes and `(...)`/`[...]`).
 *
 * The predicates (isWhitespace/isIdentStart/isIdentPart) and skip helpers (skipString/skipTemplate/
 * skipRegex/skipLineComment/skipBlockComment/skipBalanced) are a family of small public utilities;
 * {@link findMarkupStart} is the substantive entry point.
 *
 * @see {@link findMarkupStart}
 */

import { codeWalker, type Step } from './code-walker.ts';
import { VOID_ELEMENTS, contentModel, elementNamespace, hostChildContext, hostEventType, hostNamespaceForTag, isComponentTag, resolveMarkupContext, type MarkupContext } from 'azerothjs/semantics';

/** Component prop values and spreads can supply renderable children in the incoming namespace. */
export function attributeParsingContext(isComponent: boolean, name: string | null, parent?: MarkupContext): MarkupContext | undefined
{
    return isComponent && (name === null || (hostEventType(name) === null && !name.startsWith('bind:'))) ? parent : undefined;
}

/**
 * The named HTML character references decoded in text content. Numeric references (`&#38;`,
 * `&#x26;`) are handled generically; this table covers the common named set (an unknown name is
 * left verbatim). The five XML built-ins plus the entities real markup routinely carries -
 * spaces, dashes, quotes, symbols, arrows, and common accents.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ',
    copy: '©', reg: '®', trade: '™', hellip: '…',
    mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
    ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
    times: '×', divide: '÷', plusmn: '±', deg: '°',
    micro: 'µ', para: '¶', sect: '§', middot: '·',
    bull: '•', dagger: '†', Dagger: '‡', permil: '‰',
    prime: '′', Prime: '″', euro: '€', pound: '£',
    cent: '¢', yen: '¥', curren: '¤', frac12: '½',
    frac14: '¼', frac34: '¾', larr: '←', uarr: '↑',
    rarr: '→', darr: '↓', harr: '↔', hearts: '♥',
    spades: '♠', clubs: '♣', diams: '♦', check: '✓',
    cross: '✗', star: '★', ensp: ' ', emsp: ' ',
    thinsp: ' ', zwnj: '‌', zwj: '‍', shy: '­',
    iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º',
    aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó',
    uacute: 'ú', ntilde: 'ñ', uuml: 'ü', ouml: 'ö',
    auml: 'ä', szlig: 'ß', ccedil: 'ç', agrave: 'à',
    egrave: 'è'
};

/**
 * Decodes numeric and supported named character references in ordinary markup text and quoted
 * attributes. Unknown names keep their original spelling. Raw element bodies bypass this step.
 */
export function decodeEntities(text: string): string
{
    if (!text.includes('&'))
    {
        return text;
    }
    return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) =>
    {
        if (body.charCodeAt(0) === 35) // '#'
        {
            const code = body[1] === 'x' || body[1] === 'X'
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole;
        }
        const named = NAMED_ENTITIES[body];
        return named !== undefined ? named : whole;
    });
}

/**
 * True for a single whitespace character (space, tab, newline, etc.).
 *
 * @example
 * ```ts
 * isWhitespace(' '); // true
 * isWhitespace('x'); // false
 * ```
 */
export function isWhitespace(ch: string | undefined): boolean
{
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

const codeWhitespace = /\s/u;
const lineEnd = /[\r\n\u2028\u2029]/;

/** JavaScript trivia, including Unicode separators. HTML keeps its own whitespace rules. */
export function isCodeWhitespace(ch: string | undefined): boolean
{
    return ch !== undefined && codeWhitespace.test(ch);
}

/**
 * True for a character that can begin an identifier (letter, `_`, or `$`).
 *
 * @example
 * ```ts
 * isIdentStart('h'); // true
 * isIdentStart('1'); // false (digits cannot start an identifier)
 * ```
 */
export function isIdentStart(ch: string | undefined): boolean
{
    // An out-of-bounds read (undefined) is simply "not a match" - callers scan with
    // `source[i]` and rely on that, mirroring isTagOrFragmentStart in the parser.
    return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$');
}

/**
 * True for a character allowed inside an identifier (an ident-start char or a digit).
 *
 * @example
 * ```ts
 * isIdentPart('1'); // true (digits are fine after the first char)
 * isIdentPart('-'); // false
 * ```
 */
export function isIdentPart(ch: string | undefined): boolean
{
    return isIdentStart(ch) || (ch !== undefined && ch >= '0' && ch <= '9');
}

/**
 * Skips a `//` line comment; returns the index of the newline (or EOF).
 *
 * @example
 * ```ts
 * const src = 'a // note\nb';
 * skipLineComment(src, 2); // 9 (the index of the '\n')
 * ```
 */
export function skipLineComment(src: string, i: number): number
{
    i += 2;
    while (i < src.length && !lineEnd.test(src[i] as string))
    {
        i++;
    }
    return i;
}

/**
 * Skips a block comment (slash-star to star-slash); returns the index just after it.
 *
 * @example
 * ```ts
 * const src = '/* hi *' + '/x';
 * skipBlockComment(src, 0); // points just past the comment, at 'x'
 * ```
 */
export function skipBlockComment(src: string, i: number): number
{
    i += 2;
    while (i < src.length && !(src[i] === '*' && src[i + 1] === '/'))
    {
        i++;
    }
    return Math.min(i + 2, src.length);
}

/**
 * Skips a quoted string (`'` or `"`); `i` points at the opening quote.
 * Returns the index just after the closing quote.
 *
 * @example
 * ```ts
 * const src = 'x = "hi" + y';
 * skipString(src, 4); // 8 (just past the closing '"')
 * ```
 */
export function skipString(src: string, i: number): number
{
    const quote = src[i];
    i++;
    while (i < src.length)
    {
        const ch = src[i];
        if (ch === '\\')
        {
            i += 2;
            continue;
        }
        if (ch === quote)
        {
            return i + 1;
        }
        i++;
    }
    return i;
}

/**
 * Skips a template literal; `i` points at the opening backtick.
 * Handles `${ ... }` substitutions by recursing through `skipBalanced`
 * (which itself re-enters here for nested templates).
 *
 * @example
 * ```ts
 * const src = 'tag`a${ b }c` + d';
 * skipTemplate(src, 3); // 13 (just past the closing backtick)
 * ```
 */
export function skipTemplate(src: string, i: number, context?: MarkupContext): number
{
    i++; // past opening `
    while (i < src.length)
    {
        const ch = src[i];
        if (ch === '\\')
        {
            i += 2;
            continue;
        }
        if (ch === '`')
        {
            return i + 1;
        }
        if (ch === '$' && src[i + 1] === '{')
        {
            // The substitution is balanced like any `{ ... }` block.
            i = skipBalanced(src, i + 1, context);
            continue;
        }
        i++;
    }
    return i;
}

/**
 * Skips a regex literal (including trailing flags); `i` points at the leading `/`.
 * Returns the index just after the last flag.
 *
 * @example
 * ```ts
 * const src = 'x = /ab+/gi;';
 * skipRegex(src, 4); // 11 (just past the 'gi' flags)
 * ```
 */
export function skipRegex(src: string, i: number): number
{
    i++; // past /
    let inClass = false;
    while (i < src.length)
    {
        const ch = src[i];
        if (ch === '\\')
        {
            i += 2;
            continue;
        }
        if (ch === '[')
        {
            inClass = true;
        }
        else if (ch === ']')
        {
            inClass = false;
        }
        else if (ch === '/' && !inClass)
        {
            i++;
            break;
        }
        else if (lineEnd.test(ch as string))
        {
            break; // unterminated - bail rather than run away
        }
        i++;
    }
    // Trailing flags (g, i, m, ...).
    while (i < src.length && isIdentPart(src[i]))
    {
        i++;
    }
    return i;
}

/** Characters that continue a tag name: identifiers plus `.` (`Foo.Bar`) and `-` (custom elements). */
function isTagNameChar(ch: string): boolean
{
    return isIdentPart(ch) || ch === '.' || ch === '-';
}

/**
 * Given `i` at a `<` that begins a markup element or fragment (in EXPRESSION position),
 * returns the index just past the region's end. Consumes the whole tree - attribute
 * expressions and holes via {@link skipBalanced}, nested elements recursively, text (including
 * apostrophes and slashes) as OPAQUE - so nothing inside a markup region is mistaken for a
 * string, regex, or stray brace by the surrounding brace scanner. This is what lets
 * `{ok ? <span>Don't</span> : <span>Do</span>}` scan correctly: the apostrophe in text is
 * markup content, not a string delimiter.
 *
 * @internal
 */
function skipMarkupRegion(src: string, start: number, context?: MarkupContext): number
{
    let i = start;
    const contexts: (MarkupContext | undefined)[] = [];

    do
    {
        if (i >= src.length)
        {
            break;
        }
        if (src[i] === '<' && src[i + 1] === '/')
        {
            // Closing tag `</name>` or `</>`.
            i += 2;
            while (i < src.length && src[i] !== '>')
            {
                i++;
            }
            if (src[i] === '>')
            {
                i++;
            }
            contexts.pop();
            continue;
        }
        if (src[i] === '<')
        {
            // Opening tag or `<>` fragment. Scan to the end of the open tag, tracking
            // self-closing, and only descend for a container element.
            const parent = contexts.length === 0 ? context : contexts[contexts.length - 1];
            const opened = scanOpenTag(src, i, parent);
            i = opened.end;
            const inherited = parent === undefined ? hostNamespaceForTag(opened.tag) : resolveMarkupContext(parent, opened.tag);
            const ns = elementNamespace(opened.tag, inherited);
            if (!opened.selfClosing && !(ns === 'html' && VOID_ELEMENTS.has(opened.tag)))
            {
                const transparent = opened.tag === '' || isComponentTag(opened.tag);
                contexts.push(transparent ? parent : hostChildContext(opened.tag, ns, opened.encoding));
                const model = transparent ? null : contentModel(opened.tag, ns);
                if (model === 'raw-text' || model === 'foreign-text')
                {
                    i = rawTextEnd(src, i, opened.tag);
                }
            }
            continue;
        }
        if (src[i] === '{')
        {
            // A hole (or `{/* comment */}`); its braces are balanced independently.
            i = skipBalanced(src, i, contexts[contexts.length - 1]);
            continue;
        }
        // Ordinary text: apostrophes, slashes, and quotes here are literal content.
        i++;
    }
    while (contexts.length > 0);

    return i;
}

/** The first matching raw-body close tag, using the markup language's case-sensitive spelling. */
export function rawTextEnd(src: string, start: number, tag: string): number
{
    const close = '</' + tag;
    let at = src.indexOf(close, start);
    while (at !== -1)
    {
        const after = src[at + close.length];
        if (after === undefined || after === '>' || after === '/' || isWhitespace(after))
        {
            return at;
        }
        at = src.indexOf(close, at + close.length);
    }
    return src.length;
}

/**
 * @internal Given `i` at the `<` of an opening tag (or `<>`), returns `{ end, selfClosing, tag }`.
 * Attribute `{...}` expressions and quoted values are skipped whole. On malformed input it bails
 * as self-closing at end-of-input rather than looping.
 */
function scanOpenTag(src: string, i: number, context?: MarkupContext, strict = false): { end: number; selfClosing: boolean; tag: string; encoding?: string }
{
    i++; // past '<'
    if (src[i] === '>')
    {
        return { end: i + 1, selfClosing: false, tag: '' }; // fragment <>
    }
    const nameStart = i;
    while (i < src.length && isTagNameChar(src[i] ?? ''))
    {
        i++;
    }
    const tag = src.slice(nameStart, i);
    const annotation = tag.toLowerCase() === 'annotation-xml';
    let encoding: string | undefined;

    for (;;)
    {
        if (i >= src.length)
        {
            return { end: i, selfClosing: !strict, tag };
        }
        const ch = src[i];
        if (ch === '/' && src[i + 1] === '>')
        {
            return { end: i + 2, selfClosing: true, tag };
        }
        if (ch === '>')
        {
            return { end: i + 1, selfClosing: false, tag, ...(encoding !== undefined && { encoding }) };
        }
        if (ch === '{')
        {
            i = skipBalanced(src, i, attributeParsingContext(isComponentTag(tag), null, context));
            continue;
        }
        if (!isIdentStart(ch))
        {
            if (strict && !isWhitespace(ch))
            {
                return { end: i, selfClosing: false, tag };
            }
            i++;
            continue;
        }
        const attrStart = i++;
        while (isIdentPart(src[i]) || src[i] === '-' || src[i] === ':')
        {
            i++;
        }
        const name = src.slice(attrStart, i);
        while (isWhitespace(src[i]))
        {
            i++;
        }
        if (src[i] !== '=')
        {
            continue;
        }
        i++;
        while (isWhitespace(src[i]))
        {
            i++;
        }
        if (src[i] === '{')
        {
            i = skipBalanced(src, i, attributeParsingContext(isComponentTag(tag), name, context));
        }
        else if (src[i] === '"' || src[i] === '\'')
        {
            const end = skipString(src, i);
            if (annotation && name.toLowerCase() === 'encoding')
            {
                encoding = decodeEntities(src.slice(i + 1, end - 1));
            }
            i = end;
        }
        else if (strict)
        {
            return { end: i, selfClosing: false, tag };
        }
    }
}

/**
 * Given `i` at an opening bracket (`(`, `[`, or `{`), returns the index just
 * after the matching close, skipping strings, templates, comments, regex literals, and
 * embedded MARKUP regions so their contents (braces, apostrophes, slashes) don't count.
 * Regex-vs-divide and markup-vs-less-than use the same lexical context as {@link findMarkupStart} does.
 *
 * @example
 * ```ts
 * const src = '{ a: { b: 1 } } rest';
 * skipBalanced(src, 0); // 15 (just past the matching outer '}')
 * ```
 */
export function skipBalanced(src: string, openIndex: number, context?: MarkupContext): number
{
    const open = src[openIndex];
    const close = open === '(' ? ')' : open === '[' ? ']' : '}';
    const walk = markupWalker(src, openIndex + 1, src.length, true, i => skipMarkupRegion(src, i, context), true, context);
    let depth = 1;
    let i = openIndex + 1;
    while (i < src.length)
    {
        const unit = walk(i);
        if (unit.kind === 'open' && unit.text === open)
        {
            depth++;
        }
        else if (unit.kind === 'close' && unit.text === close && --depth === 0)
        {
            return unit.next;
        }
        i = unit.next;
    }
    return i;
}

/** Share JS tokens and expression context while leaving markup consumption to its owner. */
export function markupWalker(src: string, from: number, limit: number, expression: boolean,
    readMarkup: (i: number) => number, genericArrows: boolean, context?: MarkupContext): (i: number) => Step
{
    return codeWalker(src, from, limit, expression, i => skipTemplate(src, i, context), readMarkup,
        genericArrows ? i => tryGenericArrow(src, i) : undefined, i =>
        {
            // After an operand, `<name` may compare, whereas `<>` and a complete
            // self-closing opener cannot. Keep both adjacent roots in malformed values.
            if (src[i + 1] === '>')
            {
                return true;
            }
            const opening = scanOpenTag(src, i, context, true);
            return opening.selfClosing;
        });
}

/**
 * Given `i` at a `<` that opens a possible type-parameter list, scans to the
 * index just past the matching `>`, or -1 if it doesn't balance as an
 * angle-bracket region. Nested generics (`Array<Map<K, V>>`) nest the depth;
 * an `=>` inside a function-type constraint (`<T extends () => void>`) is
 * stepped over so its `>` doesn't close the list; and `(...)`/`[...]`/`{...}`
 * regions (e.g. an object-literal default `<T = { a: 1 }>`) are skipped whole
 * so their contents never affect the angle depth.
 *
 * @internal
 */
export function scanTypeParams(src: string, openIndex: number): number
{
    let depth = 0;
    let i = openIndex;

    while (i < src.length)
    {
        const ch = src[i];

        if (ch === '/' && src[i + 1] === '/')
        {
            i = skipLineComment(src, i);
            continue;
        }
        if (ch === '/' && src[i + 1] === '*')
        {
            i = skipBlockComment(src, i);
            continue;
        }
        if (ch === '"' || ch === '\'')
        {
            i = skipString(src, i);
            continue;
        }
        if (ch === '`')
        {
            i = skipTemplate(src, i);
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{')
        {
            i = skipBalanced(src, i);
            continue;
        }
        // An arrow inside a function-type constraint - step over it so the `>`
        // of `=>` isn't counted as a closing angle bracket.
        if (ch === '=' && src[i + 1] === '>')
        {
            i += 2;
            continue;
        }
        if (ch === '<')
        {
            depth++;
            i++;
            continue;
        }
        if (ch === '>')
        {
            depth--;
            i++;
            if (depth === 0)
            {
                return i;
            }
            continue;
        }
        i++;
    }

    return -1;
}

/**
 * Decides whether a `<` in expression position opens a generic arrow function's
 * type-parameter list (`<T>(x) => x`, `<T extends U>(a: T): T => a`) rather than
 * markup. Mixing `<...>` markup with TypeScript generics creates this ambiguity;
 * it is resolved structurally: a type-parameter list is followed by the arrow's
 * parameter parenthesis, and then
 * either a return-type annotation (`:`) or the arrow itself (`=>`). Markup never
 * has that shape, so requiring all three keeps real elements (`<div>(x)</div>`)
 * out.
 *
 * Returns the index just past the `<...>` type-parameter list when it is a
 * generic arrow (so the caller can resume scanning the arrow body, which may
 * itself contain markup), or -1 otherwise.
 *
 * @internal
 */
function tryGenericArrow(src: string, i: number): number
{
    const afterAngles = scanTypeParams(src, i);
    if (afterAngles === -1)
    {
        return -1;
    }

    let k = afterAngles;
    while (k < src.length && isCodeWhitespace(src[k]))
    {
        k++;
    }
    if (src[k] !== '(')
    {
        return -1;
    }

    let m = skipBalanced(src, k);
    while (m < src.length && isCodeWhitespace(src[m]))
    {
        m++;
    }
    if (src[m] === ':' || (src[m] === '=' && src[m + 1] === '>'))
    {
        return afterAngles;
    }

    return -1;
}

/**
 * Finds the first markup opening in a fresh statement scan beginning at `from`.
 * Use {@link createMarkupSearch} to visit successive regions with the same JS context.
 *
 * @param src - The module source.
 * @param from - Where the statement scan begins.
 * @returns The offset of the markup-opening `<`, or -1 when none remains.
 * @example
 * findMarkupStart('return <h1>Hi</h1>;', 0); // 7, the '<' of <h1>
 * findMarkupStart('a < b', 0);               // -1, a less-than operator
 * findMarkupStart('const s = "<p>";', 0);    // -1, inside a string
 *
 * @see {@link parseMarkup}, which takes this index.
 */
export function findMarkupStart(src: string, from: number): number
{
    return createMarkupSearch(src, from, src.length)(from);
}

/**
 * Creates a forward search over `[start, end)` for one source. Set `expression` for a
 * markup hole or another expression span. Module and function bodies use statement grammar.
 * Call the returned function with `start` first. For each offset it returns, parse the
 * region with {@link parseMarkup} and pass its exclusive end to the same function.
 * It returns -1 when the span contains no further markup.
 */
export function createMarkupSearch(src: string, start: number, end: number, expression = false): (from: number) => number
{
    const walk = markupWalker(src, start, end, expression, i => i + 1, true);
    return from =>
    {
        for (let i = from; i < end;)
        {
            const unit = walk(i);
            if (unit.kind === 'markup')
            {
                return i;
            }
            i = unit.next;
        }
        return -1;
    };
}
