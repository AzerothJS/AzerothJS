// ============================================================================
// AZEROTHJS COMPILER — Context-Aware Source Scanner
// ============================================================================
//
// Low-level lexing helpers that let us find AzerothJS markup inside arbitrary
// JS/TS WITHOUT a full parser. The two jobs:
//
//   1. Skip "non-code" spans correctly — line/block comments,
//      single/double-quoted strings, template literals (with nested
//      `${ … }`), and regex literals — so a `<`, `{`, or `}` inside
//      them is never mistaken for syntax.
//
//   2. Decide whether a `<` (or `/`) sits in EXPRESSION POSITION,
//      which is what distinguishes AzerothJS markup from a less-than operator
//      (and a regex from a divide). We track the previous significant
//      token to make that call — the same trick hand-written AzerothJS markup
//      transforms use.
//
// These are pure functions over (src, index) → nextIndex, shared by
// the parser (which also needs balanced-brace capture for `{…}`
// holes and `(…)`/`[…]`).
//
// ============================================================================

export function isWhitespace(ch: string): boolean
{
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

export function isIdentStart(ch: string): boolean
{
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
}

export function isIdentPart(ch: string): boolean
{
    return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

/** Skips a `// …` line comment; returns the index of the newline (or EOF). */
export function skipLineComment(src: string, i: number): number
{
    i += 2;
    while (i < src.length && src[i] !== '\n')
    {
        i++;
    }
    return i;
}

/** Skips a block comment (slash-star … star-slash); returns the index just after it. */
export function skipBlockComment(src: string, i: number): number
{
    i += 2;
    while (i < src.length && !(src[i] === '*' && src[i + 1] === '/'))
    {
        i++;
    }
    return Math.min(i + 2, src.length);
}

/** Skips a quoted string (`'` or `"`); `i` points at the opening quote. */
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
 * Handles `${ … }` substitutions by recursing through `skipBalanced`
 * (which itself re-enters here for nested templates).
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
            // The substitution is balanced like any `{ … }` block.
            i = skipBalanced(src, i + 1);
            continue;
        }
        i++;
    }
    return i;
}

/** Skips a regex literal; `i` points at the leading `/`. */
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
            break; // unterminated — bail rather than run away
        }
        i++;
    }
    // Trailing flags (g, i, m, …).
    while (i < src.length && isIdentPart(src[i]))
    {
        i++;
    }
    return i;
}

/**
 * Given `i` at an opening bracket (`(`, `[`, or `{`), returns the
 * index just AFTER the matching close — skipping strings, templates,
 * comments, and nested brackets so braces inside them don't count.
 */
export function skipBalanced(src: string, openIndex: number): number
{
    const open = src[openIndex];
    const close = open === '(' ? ')' : open === '[' ? ']' : '}';
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
        if (ch === open)
        {
            depth++;
            i++;
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
            continue;
        }
        i++;
    }

    return i; // unbalanced — caller treats as EOF
}

/** Keywords after which a `<` or `/` begins an expression (AzerothJS markup / regex). */
const EXPR_KEYWORDS = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'do', 'else',
    'yield', 'await', 'case', 'delete', 'void', 'new'
]);

/** Punctuators after which an expression (hence AzerothJS markup / regex) can start. */
const EXPR_CHARS = new Set([
    '', '(', '{', '[', ',', ';', ':', '?', '=', '>', '<',
    '&', '|', '!', '~', '+', '-', '*', '/', '%', '^', '\n'
]);

/**
 * Whether a `<` / `/` at the current point is in expression position
 * (AzerothJS markup / regex) rather than a binary operator. Based on the previous
 * significant token: an identifier or literal that ENDS an expression
 * means binary; a punctuator/keyword that EXPECTS an operand means
 * expression.
 */
function isExpressionPosition(prevChar: string, prevWord: string): boolean
{
    if (prevWord !== '')
    {
        return EXPR_KEYWORDS.has(prevWord);
    }
    return EXPR_CHARS.has(prevChar);
}

/**
 * Finds the next `<` that begins a AzerothJS markup element/fragment in expression
 * position, scanning from `from` and correctly skipping all non-code
 * spans. Returns its index, or -1 if there is no more AzerothJS markup.
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
            while (j < src.length && isIdentPart(src[j]))
            {
                j++;
            }
            prevWord = src.slice(i, j);
            prevChar = src[j - 1];
            i = j;
            continue;
        }

        prevChar = ch;
        prevWord = '';
        i++;
    }

    return -1;
}
