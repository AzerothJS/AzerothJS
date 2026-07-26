/**
 * MODULE: compiler/scanner - context-aware lexing helpers
 *
 * Finds markup inside arbitrary JS/TS WITHOUT a full parser. Two jobs:
 *   1. Skip non-code spans correctly - line/block comments, single/double quoted strings, template
 *      literals (with nested `${ ... }`), and regex literals - so a `<`, `{`, or `}` inside them is
 *      never mistaken for syntax.
 *   2. Decide whether a `<` (or `/`) sits in EXPRESSION position, which distinguishes markup from a
 *      less-than operator (and a regex from a divide). The previous significant token is tracked to
 *      make that call - the same trick hand-written markup transforms use.
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
    while (i < src.length && src[i] !== '\n')
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
export function skipTemplate(src: string, i: number): number
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
            i = skipBalanced(src, i + 1);
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
        else if (ch === '\n')
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

/** HTML void elements: no closing tag and no children (`<br>`, `<img>`, ...). */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/**
 * HTML raw-text elements: their content is CDATA, not markup. `<style>`/`<script>` carry `{`, `<`,
 * and `&` that must stay LITERAL - the markup parser reads their content verbatim (no `{ ... }` holes,
 * no nested tags) and the serializers emit it unescaped, so CSS and JSON-LD survive intact.
 */
export const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style']);

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
function skipMarkupRegion(src: string, start: number): number
{
    let i = start;
    let depth = 0;

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
            depth--;
            continue;
        }
        if (src[i] === '<')
        {
            // Opening tag or `<>` fragment. Scan to the end of the open tag, tracking
            // self-closing, and only descend for a container element.
            const opened = scanOpenTag(src, i);
            i = opened.end;
            if (!opened.selfClosing && !VOID_ELEMENTS.has(opened.tag))
            {
                depth++;
            }
            continue;
        }
        if (src[i] === '{')
        {
            // A hole (or `{/* comment */}`); its braces are balanced independently.
            i = skipBalanced(src, i);
            continue;
        }
        // Ordinary text: apostrophes, slashes, and quotes here are literal content.
        i++;
    }
    while (depth > 0);

    return i;
}

/**
 * @internal Given `i` at the `<` of an opening tag (or `<>`), returns `{ end, selfClosing, tag }`.
 * Attribute `{...}` expressions and quoted values are skipped whole. On malformed input it bails
 * as self-closing at end-of-input rather than looping.
 */
function scanOpenTag(src: string, i: number): { end: number; selfClosing: boolean; tag: string }
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

    for (;;)
    {
        if (i >= src.length)
        {
            return { end: i, selfClosing: true, tag };
        }
        const ch = src[i];
        if (ch === '/' && src[i + 1] === '>')
        {
            return { end: i + 2, selfClosing: true, tag };
        }
        if (ch === '>')
        {
            return { end: i + 1, selfClosing: false, tag };
        }
        if (ch === '{')
        {
            i = skipBalanced(src, i); // attribute expression or {...spread}
            continue;
        }
        if (ch === '"' || ch === '\'')
        {
            i = skipString(src, i); // quoted attribute value
            continue;
        }
        i++; // attribute name chars, '=', directives (class:x, bind:value)
    }
}

/**
 * Given `i` at an opening bracket (`(`, `[`, or `{`), returns the index just
 * after the matching close, skipping strings, templates, comments, regex literals, and
 * embedded MARKUP regions so their contents (braces, apostrophes, slashes) don't count.
 * Regex-vs-divide and markup-vs-less-than are disambiguated by the previous significant
 * token, exactly as {@link findMarkupStart} does.
 *
 * @example
 * ```ts
 * const src = '{ a: { b: 1 } } rest';
 * skipBalanced(src, 0); // 15 (just past the matching outer '}')
 * ```
 */
export function skipBalanced(src: string, openIndex: number): number
{
    const open = src[openIndex];
    const close = open === '(' ? ')' : open === '[' ? ']' : '}';
    let depth = 0;
    let i = openIndex;
    let prevChar = '';
    let prevWord = '';

    while (i < src.length)
    {
        const ch = src[i] ?? '';

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
        // A `/` in expression position starts a REGEX literal; consume it whole so an
        // apostrophe, brace, or paren inside (`/'/g`, `/\{/`) cannot desync the scan.
        if (ch === '/' && isExpressionPosition(prevChar, prevWord))
        {
            i = skipRegex(src, i);
            prevChar = ')'; // a regex value has ended: a following `/` is division
            prevWord = '';
            continue;
        }
        if (ch === '"' || ch === '\'')
        {
            i = skipString(src, i);
            prevChar = ')';
            prevWord = '';
            continue;
        }
        if (ch === '`')
        {
            i = skipTemplate(src, i);
            prevChar = ')';
            prevWord = '';
            continue;
        }
        // A `<` in expression position begins MARKUP (unless it is a generic arrow's type
        // parameters); skip the whole region so its text/tags never touch the brace depth.
        if (ch === '<' && isExpressionPosition(prevChar, prevWord))
        {
            const next = src[i + 1];
            if (next === '>' || isIdentStart(next))
            {
                if (next !== '>')
                {
                    const past = tryGenericArrow(src, i);
                    if (past !== -1)
                    {
                        i = past; // only the `<...>` list; the arrow body still scans normally
                        prevChar = '>';
                        prevWord = '';
                        continue;
                    }
                }
                i = skipMarkupRegion(src, i);
                prevChar = ')'; // a markup value has ended
                prevWord = '';
                continue;
            }
        }
        if (ch === open)
        {
            depth++;
            i++;
            prevChar = ch;
            prevWord = '';
            continue;
        }
        if (ch === close)
        {
            depth--;
            i++;
            if (depth === 0)
            {
                return i;
            }
            prevChar = ch;
            prevWord = '';
            continue;
        }
        if (isWhitespace(ch))
        {
            i++; // whitespace does not change the previous significant token
            continue;
        }
        if (isIdentStart(ch))
        {
            let j = i + 1;
            while (j < src.length && isIdentPart(src[j] ?? ''))
            {
                j++;
            }
            prevWord = src.slice(i, j);
            prevChar = src[j - 1] ?? '';
            i = j;
            continue;
        }
        prevChar = ch;
        prevWord = '';
        i++;
    }

    return i; // unbalanced - caller treats as EOF
}

/** Keywords after which a `<` or `/` begins an expression (markup / regex). */
const EXPR_KEYWORDS = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'do', 'else',
    'yield', 'await', 'case', 'delete', 'void', 'new'
]);

/**
 * Punctuators after which an expression (hence markup / regex) can start. `}` is here for the
 * block-then-render shape (`effect { ... } <div>...`): the markup after a reactive block must
 * read as markup, not as a less-than off the `}`.
 */
const EXPR_CHARS = new Set([
    '', '(', '{', '[', ',', ';', ':', '?', '=', '>', '<',
    '&', '|', '!', '~', '+', '-', '*', '/', '%', '^', '\n', '}'
]);

/**
 * Whether a `<` / `/` at the current point is in expression position
 * (markup / regex) rather than a binary operator. Based on the previous
 * significant token: an identifier or literal that ends an expression means
 * binary; a punctuator/keyword that expects an operand means expression.
 */
export function isExpressionPosition(prevChar: string, prevWord: string): boolean
{
    if (prevWord !== '')
    {
        return EXPR_KEYWORDS.has(prevWord);
    }
    return EXPR_CHARS.has(prevChar);
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
    while (k < src.length && isWhitespace(src[k]))
    {
        k++;
    }
    if (src[k] !== '(')
    {
        return -1;
    }

    let m = skipBalanced(src, k);
    while (m < src.length && isWhitespace(src[m]))
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
 * findMarkupStart
 *
 * PURPOSE:
 * Finds the next `<` that begins a markup element/fragment in EXPRESSION position, scanning from
 * `from` and correctly skipping all non-code spans. Returns its index, or -1 if there is no more
 * markup.
 *
 * WHY IT EXISTS:
 * Markup is embedded in arbitrary JS/TS, so the compiler must locate a region's start without a full
 * JS grammar - and without false-positiving on `a < b`, a `<` inside a string/comment/regex, or a
 * generic. This is the scanner's entry that all markup-region consumers (codegen, lint, lower) call
 * to step through a module's regions.
 *
 * COMPILER / RUNTIME ROLE:
 * Compiler, scanning stage; the front of the markup pipeline (its result feeds parseMarkup).
 *
 * INPUT CONTRACT:
 * - src: the module source.
 * - from: the index to start scanning at (callers loop, passing the previous region's end).
 *
 * OUTPUT CONTRACT:
 * - The index of the next markup-opening `<`, or -1 when none remains.
 *
 * WHY THIS DESIGN:
 * It tracks the previous significant character/word so it can decide expression position (markup vs
 * less-than) the way hand-written transforms do, and it reuses the skip* helpers to jump over strings,
 * templates, comments, and regex - so syntax inside those is never mistaken for a tag.
 *
 * WHEN TO USE:
 * Iterating the markup regions of a module (`from` = 0, then the prior region's end each time).
 *
 * WHEN NOT TO USE:
 * Parsing the region itself - that's {@link parseMarkup}, which takes this index.
 *
 * EDGE CASES:
 * - `a < b` (operator), a `<` inside a string/comment/regex, and (heuristically) generics return -1
 *   at that position.
 * - Returns -1 at end of input.
 *
 * PERFORMANCE NOTES:
 * A single left-to-right scan; skip helpers advance in O(span length).
 *
 * DEVELOPER WARNING:
 * Expression-position detection is HEURISTIC (token-based, not a real parser). It is tuned for the
 * markup the language accepts; exotic generic/operator combinations could in principle misclassify.
 *
 * @param src - The module source.
 * @param from - The index to start scanning from.
 * @returns The index of the next markup-opening `<`, or -1.
 * @see {@link parseMarkup}
 *
 * @example
 * ```ts
 * findMarkupStart('return <h1>Hi</h1>;', 0); // 7 (the '<' of <h1>)
 * findMarkupStart('a < b', 0);               // -1 (a less-than operator, not markup)
 * findMarkupStart('const s = "<p>";', 0);    // -1 (the '<' is inside a string)
 * ```
 */
export function findMarkupStart(src: string, from: number): number
{
    let i = from;
    let prevChar = '';
    let prevWord = '';

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
            prevChar = '"';
            prevWord = '';
            continue;
        }
        if (ch === '`')
        {
            i = skipTemplate(src, i);
            prevChar = '`';
            prevWord = '';
            continue;
        }
        if (ch === '/' && isExpressionPosition(prevChar, prevWord))
        {
            i = skipRegex(src, i);
            prevChar = '/';
            prevWord = '';
            continue;
        }
        if (isWhitespace(ch))
        {
            if (ch === '\n')
            {
                // A newline only matters for the very specific ASI
                // cases; keep prevChar so `a\n< b` stays a compare.
            }
            i++;
            continue;
        }
        if (ch === '<')
        {
            const next = src[i + 1];
            if (isExpressionPosition(prevChar, prevWord) && (next === '>' || isIdentStart(next)))
            {
                // A `<Ident...` in expression position is ambiguous: markup, or
                // a generic arrow's type-parameter list (`<T>(x) => x`). The
                // `<>` fragment is never a generic arrow, so only probe when a
                // name follows.
                if (next !== '>')
                {
                    const past = tryGenericArrow(src, i);
                    if (past !== -1)
                    {
                        // Skip only the `<...>` list; the arrow body after it is
                        // ordinary code that may still contain markup.
                        prevChar = '>';
                        prevWord = '';
                        i = past;
                        continue;
                    }
                }
                return i;
            }
            prevChar = '<';
            prevWord = '';
            i++;
            continue;
        }
        if (isIdentStart(ch))
        {
            let j = i + 1;
            while (j < src.length && isIdentPart(src[j] ?? ''))
            {
                j++;
            }
            prevWord = src.slice(i, j);
            prevChar = src[j - 1] ?? '';
            i = j;
            continue;
        }

        prevChar = ch ?? '';
        prevWord = '';
        i++;
    }

    return -1;
}
