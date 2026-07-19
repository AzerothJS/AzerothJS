/**
 * MODULE: compiler/markup-parser - the markup region parser
 *
 * Parses one markup region (an element or fragment) starting at a `<` into the AST from types.ts.
 * Expression holes (`{ ... }`) and attribute expressions are captured as RAW source - nested markup
 * inside them is handled later by lowering/codegen, which recursively compiles the hole text. That
 * keeps the parser focused purely on markup structure.
 *
 * @see {@link parseMarkup} - the parse entry point
 * @see {@link CompileError} - thrown on malformed markup
 */

import type {
    MarkupElement,
    MarkupFragment,
    MarkupChild,
    MarkupAttribute,
    MarkupText
} from './types.ts';
import {
    isIdentStart,
    isIdentPart,
    isWhitespace,
    skipBalanced,
    skipString
} from './scanner.ts';

/**
 * Thrown when the markup is malformed. Carries the source offset.
 *
 * @example
 * ```ts
 * try
 * {
 *     parseMarkup('<a></b>', 0); // mismatched closing tag
 * }
 * catch (err)
 * {
 *     if (err instanceof CompileError) console.log(err.offset); // source index of the error
 * }
 * ```
 */
export class CompileError extends Error
{
    /**
     * True when the failure happened AFTER the parser committed to markup - it had completed an
     * opening tag (`<tag>`), or seen other markup-only evidence (a fragment `<>`, a self-close `/>`,
     * an attribute, a closing tag `</`). Scanners use this to turn malformed markup into a located
     * hard error. `.azeroth` disallows angle-bracket casts (write `expr as Foo`), so a completed
     * `<Foo>` opening tag commits; the only angle-bracket TS form that still falls back to opaque
     * token scanning is a generic arrow with its disambiguating comma (`<T,>(v) => v`), which throws
     * while reading attributes before the opening tag completes. Set by {@link parseMarkup}.
     */
    public committed = false;

    public readonly offset: number;

    constructor(message: string, offset: number)
    {
        super(message);
        this.name = 'CompileError';
        this.offset = offset;
    }
}

/**
 * HTML void elements: they have no children and no closing tag. In `.azeroth` markup they may be
 * written either self-closed (`<br/>`) or HTML-style (`<br>`); both parse to a childless element.
 * Shared with the SSR serializer (codegen) so the parser and the emitter agree on which tags close
 * themselves.
 */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set
([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/**
 * Maximum markup nesting depth. Real component trees are nowhere near this; the cap exists so a
 * pathological or adversarial input (thousands of unclosed `<div>`s) fails with a located
 * {@link CompileError} instead of overflowing the recursive parser's stack.
 */
const MAX_MARKUP_DEPTH = 500;

class MarkupParser
{
    /**
     * Becomes true once the OUTERMOST element commits to markup - it completed an opening tag, or
     * showed other markup-only evidence (see {@link CompileError.committed}). A generic arrow
     * (`<T,>(v) => v`) never sets it: the `,` makes readAttributeName throw before the opening tag
     * completes. Angle-bracket casts are NOT exempt - `<Foo>bar` commits and a missing close is an
     * error.
     *
     * Only depth-0 (outer) commitment counts: a nested child is parsed one level deeper so its own
     * tag does not stand in for the outer element's commitment - hence the depth guard.
     */
    public committed = false;

    /** Nesting depth while parsing children; 0 is the outermost element. @internal */
    #depth = 0;

    readonly #src: string;

    public pos: number;

    constructor(src: string, pos: number)
    {
        this.#src = src;
        this.pos = pos;
    }

    /** Entry point; `pos` must be at the opening `<`. */
    public parse(): MarkupElement | MarkupFragment
    {
        return this.#parseElement();
    }

    #peek(offset = 0): string
    {
        return this.#src[this.pos + offset] ?? '';
    }

    #skipWs(): void
    {
        while (this.pos < this.#src.length && isWhitespace(this.#src[this.pos]))
        {
            this.pos++;
        }
    }

    #expect(ch: string): void
    {
        if (this.#peek() !== ch)
        {
            throw new CompileError(
                `Expected '${ ch }' but found '${ this.#peek() || 'EOF' }'`,
                this.pos
            );
        }
        this.pos++;
    }

    /** `pos` at `<`. Parses an element or `<>...</>` fragment. */
    #parseElement(): MarkupElement | MarkupFragment
    {
        const start = this.pos;
        this.#expect('<');

        // Fragment: `<>` (not valid TS, so this is unambiguously markup).
        if (this.#peek() === '>')
        {
            if (this.#depth === 0)
            {
                this.committed = true;
            }
            this.pos++; // past '>'
            const children = this.#parseChildren();
            this.#expectClosingTag(''); // </>
            return { kind: 'fragment', children, start, end: this.pos };
        }

        // An HTML comment gets its own message (field-reported confusion): the generic
        // literal-'<' hint reads as nonsense when the author wrote `<!-- -->`.
        if (this.#peek() === '!')
        {
            throw new CompileError(
                'HTML comments (<!-- -->) are not supported in .azeroth markup - remove the '
                + 'comment (use a // or /* */ comment in the surrounding code instead).',
                start
            );
        }

        // A `<` that is neither a fragment, a closing tag, nor the start of a
        // tag name is a literal less-than in markup text - the single most
        // common authoring mistake. Diagnose it where it sits instead of the
        // opaque "Expected a tag name".
        if (this.#peek() !== '/' && !isIdentStart(this.#peek()))
        {
            throw new CompileError(
                'Unexpected \'<\' in markup; write a literal \'<\' as {\'<\'} or &lt;',
                start
            );
        }

        const tag = this.#readTagName();
        const attributes = this.#parseAttributes();
        this.#skipWs();

        // Self-closing: `<tag ... />` (the `/>` is unambiguously markup).
        if (this.#peek() === '/')
        {
            if (this.#depth === 0)
            {
                this.committed = true;
            }
            this.pos++;
            this.#expect('>');
            return {
                kind: 'element',
                tag,
                isComponent: MarkupParser.#isComponentTag(tag),
                attributes,
                children: [],
                start,
                end: this.pos
            };
        }

        this.#expect('>');
        // A completed opening tag `<tag>` is markup. `.azeroth` follows the TSX rule: angle-bracket
        // type assertions (`<Foo>expr`) and bare generic arrows (`<T>(v) => v`) are NOT allowed -
        // write `expr as Foo` and `<T,>(v) => v`. So once we've consumed a full opening tag at the
        // OUTERMOST level we commit to markup, which turns a forgotten closing tag into a located
        // error instead of letting it fall back to an (now-disallowed) opaque cast. Depth-guarded so
        // only the outer tag commits; a generic with a comma (`<T,>`) throws in readAttributeName
        // before reaching here, so it still falls back.
        if (this.#depth === 0)
        {
            this.committed = true;
        }

        // HTML void element written without a self-closing slash (`<br>`, `<input ...>`): it has no
        // children and no closing tag, so finish here rather than scanning for a `</br>` that will
        // never come. `<br/>` is handled by the self-closing branch above; both forms are accepted.
        if (VOID_ELEMENTS.has(tag))
        {
            return {
                kind: 'element',
                tag,
                isComponent: false,
                attributes,
                children: [],
                start,
                end: this.pos
            };
        }

        const children = this.#parseChildren();
        this.#expectClosingTag(tag);

        return {
            kind: 'element',
            tag,
            isComponent: MarkupParser.#isComponentTag(tag),
            attributes,
            children,
            start,
            end: this.pos
        };
    }

    static #isComponentTag(tag: string): boolean
    {
        return /[A-Z]/.test(tag[0] ?? '') || tag.includes('.');
    }

    /** Reads a tag name: identifiers plus `.` (`Foo.Bar`) and `-` (custom elements). */
    #readTagName(): string
    {
        const start = this.pos;
        if (!isIdentStart(this.#peek()))
        {
            throw new CompileError('Expected a tag name after `<`, e.g. `<div>` or `<Component>`.', this.pos);
        }
        this.pos++;
        while (this.pos < this.#src.length)
        {
            const ch = this.#src[this.pos];
            if (isIdentPart(ch) || ch === '.' || ch === '-')
            {
                this.pos++;
            }
            else
            {
                break;
            }
        }
        return this.#src.slice(start, this.pos);
    }

    #parseAttributes(): MarkupAttribute[]
    {
        const attrs: MarkupAttribute[] = [];

        for (;;)
        {
            this.#skipWs();
            const ch = this.#peek();

            // End of the opening tag.
            if (ch === '>' || ch === '/' || ch === '')
            {
                break;
            }

            const attrStart = this.pos;

            // Spread: `{...expr}` (a `{` here is unambiguously a markup attribute).
            if (ch === '{')
            {
                if (this.#depth === 0)
                {
                    this.committed = true;
                }
                const end = skipBalanced(this.#src, this.pos);
                const inner = this.#src.slice(this.pos + 1, end - 1).trim();
                this.pos = end;
                const code = inner.startsWith('...') ? inner.slice(3).trim() : inner;
                attrs.push({
                    kind: 'attribute',
                    name: null,
                    value: { kind: 'expression', code },
                    spread: true,
                    start: attrStart,
                    end
                });
                continue;
            }

            // Named attribute. readAttributeName throws for a non-name char (e.g. the `,`
            // in a generic `<T,>`), so commit only AFTER it succeeds - a real attribute
            // name is unambiguously markup, but a generic/cast must still be able to fall back.
            const name = this.#readAttributeName();
            if (this.#depth === 0)
            {
                this.committed = true;
            }
            this.#skipWs();

            if (this.#peek() !== '=')
            {
                // Bare attribute -> boolean true.
                attrs.push({
                    kind: 'attribute',
                    name,
                    value: { kind: 'none' },
                    spread: false,
                    start: attrStart,
                    end: this.pos
                });
                continue;
            }

            this.pos++; // past '='
            this.#skipWs();
            const valueChar = this.#peek();

            if (valueChar === '{')
            {
                const end = skipBalanced(this.#src, this.pos);
                const code = this.#src.slice(this.pos + 1, end - 1).trim();
                this.pos = end;
                attrs.push({
                    kind: 'attribute',
                    name,
                    value: { kind: 'expression', code },
                    spread: false,
                    start: attrStart,
                    end
                });
            }
            else if (valueChar === '"' || valueChar === '\'')
            {
                const end = skipString(this.#src, this.pos);
                const value = this.#src.slice(this.pos + 1, end - 1);
                this.pos = end;
                attrs.push({
                    kind: 'attribute',
                    name,
                    value: { kind: 'static', value },
                    spread: false,
                    start: attrStart,
                    end
                });
            }
            else
            {
                throw new CompileError(
                    `Expected a value for attribute \`${ name }\` - write \`${ name }="..."\` or \`${ name }={...}\`, or drop the \`=\` for a boolean attribute.`,
                    this.pos
                );
            }
        }

        return attrs;
    }

    /** Attribute names: identifiers plus `-` and `:` (`data-x`, `aria-label`). */
    #readAttributeName(): string
    {
        const start = this.pos;
        while (this.pos < this.#src.length)
        {
            const ch = this.#src[this.pos];
            if (isIdentPart(ch) || ch === '-' || ch === ':')
            {
                this.pos++;
            }
            else
            {
                break;
            }
        }
        if (this.pos === start)
        {
            throw new CompileError('Expected an attribute name here, e.g. `class` or `onClick`.', this.pos);
        }
        return this.#src.slice(start, this.pos);
    }

    #parseChildren(): MarkupChild[]
    {
        const children: MarkupChild[] = [];

        while (this.pos < this.#src.length)
        {
            // Closing tag -> stop.
            if (this.#peek() === '<' && this.#peek(1) === '/')
            {
                break;
            }

            if (this.#peek() === '<')
            {
                // Parse the child one level deeper, so its markup-only evidence does NOT
                // commit the outer element (an unclosed cast must stay able to fall back even
                // after greedily absorbing following markup as a "child").
                this.#depth++;
                if (this.#depth > MAX_MARKUP_DEPTH)
                {
                    throw new CompileError(
                        `Markup nested deeper than ${ MAX_MARKUP_DEPTH } levels. This is almost ` +
                        'always an unclosed tag; check that every element has a matching closing tag.',
                        this.pos
                    );
                }
                children.push(this.#parseElement());
                this.#depth--;
                continue;
            }

            if (this.#peek() === '{')
            {
                const start = this.pos;
                const end = skipBalanced(this.#src, this.pos);
                const code = this.#src.slice(this.pos + 1, end - 1);
                this.pos = end;
                // Drop comment-only / empty holes (e.g. `{/* note */}`).
                if (!MarkupParser.#isEmptyExpression(code))
                {
                    children.push({ kind: 'expression', code, start, end });
                }
                continue;
            }

            const text = this.#readText();
            if (text)
            {
                children.push(text);
            }
        }

        return children;
    }

    /** Reads raw text up to the next `<` or `{`, normalised the usual way. */
    #readText(): MarkupText | null
    {
        const start = this.pos;
        while (this.pos < this.#src.length && this.#peek() !== '<' && this.#peek() !== '{')
        {
            this.pos++;
        }
        const raw = this.#src.slice(start, this.pos);

        // A `//` at the head of a text child is almost always a misplaced line
        // comment (markup has no `//` comments; only `{/* ... */}`). A real
        // URL never trips this: its scheme (`https:`) precedes the `//`. Point
        // at the `//` rather than letting it render as literal text.
        const lead = raw.length - raw.trimStart().length;
        if (raw.slice(lead).startsWith('//'))
        {
            throw new CompileError(
                'Line comments (//) are not allowed in markup; use {/* ... */} instead',
                start + lead
            );
        }

        const value = MarkupParser.#normalizeText(raw);
        if (value === '')
        {
            return null;
        }
        return { kind: 'text', value, start, end: this.pos };
    }

    /**
     * Markup whitespace handling: collapse runs that are purely formatting
     * (whitespace containing a newline) to a single space, and preserve
     * meaningful same-line spacing like `Count: `.
     */
    static #normalizeText(raw: string): string
    {
        if (/^\s*$/.test(raw))
        {
            return '';
        }
        return raw.replace(/\s*\n\s*/g, ' ');
    }

    /** True when a `{ ... }` hole has no actual expression (only comments/space). */
    static #isEmptyExpression(code: string): boolean
    {
        const stripped = code
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '')
            .trim();
        return stripped === '';
    }

    /** Consumes `</tag>` (or `</>` when `tag === ''`). */
    #expectClosingTag(tag: string): void
    {
        // We reach here at a `</` close or at EOF (parseChildren only stops on those). A non-`<`
        // here means the element was never closed - the common "forgot the closing tag" mistake.
        if (this.#peek() !== '<')
        {
            throw new CompileError(
                tag === ''
                    ? 'Unclosed fragment: expected a closing </>'
                    : `Unclosed <${ tag }>: expected a closing </${ tag }>`,
                this.pos
            );
        }
        this.#expect('<');
        this.#expect('/');
        // A `</` close token on the OUTERMOST element is unambiguously markup (a cast has no
        // close). Depth-guarded so an absorbed child's valid close can't commit the outer.
        if (this.#depth === 0)
        {
            this.committed = true;
        }
        this.#skipWs();
        if (tag !== '')
        {
            const closing = this.#readTagName();
            if (closing !== tag)
            {
                throw new CompileError(
                    `Mismatched closing tag: expected </${ tag }> but found </${ closing }>`,
                    this.pos
                );
            }
        }
        this.#skipWs();
        this.#expect('>');
    }
}

/**
 * parseMarkup
 *
 * PURPOSE:
 * Parses the markup element/fragment beginning at `start` (the `<`) into an AST node, returning the
 * node and the offset just after it.
 *
 * WHY IT EXISTS:
 * Once the scanner locates a region, something must turn its `<...>` text into structure. This is that
 * step - the single markup grammar, shared by codegen, lint, and lowering, so they all see the same
 * tree.
 *
 * COMPILER / RUNTIME ROLE:
 * Compiler, parsing stage; consumes a {@link findMarkupStart} index and produces a {@link MarkupElement}
 * or {@link MarkupFragment}.
 *
 * INPUT CONTRACT:
 * - src: the module source.
 * - start: the offset of the region's opening `<`.
 *
 * OUTPUT CONTRACT:
 * - `{ node, end }`: the parsed markup node and the offset just past the region. Throws
 *   {@link CompileError} (with a source offset) on malformed markup.
 *
 * WHY THIS DESIGN:
 * Expression holes and attribute expressions are captured as RAW spans, not recursively parsed here -
 * nested markup inside them is lowered/compiled later. Keeping the parser to pure markup structure
 * makes it small and keeps the one JS grammar (TypeScript) responsible for expression interiors.
 *
 * WHEN TO USE:
 * Parsing a region whose start you got from {@link findMarkupStart}.
 *
 * WHEN NOT TO USE:
 * Locating a region (that's findMarkupStart); parsing a whole module's components (that's parseModule).
 *
 * EDGE CASES:
 * - Mismatched/unclosed tags throw {@link CompileError} with the offending offset.
 * - Whitespace-only text between tags is dropped.
 *
 * PERFORMANCE NOTES:
 * A single recursive-descent pass over the region; hole/attribute interiors are sliced, not parsed.
 *
 * DEVELOPER WARNING:
 * `start` MUST point at the opening `<` - calling it elsewhere throws or mis-parses. Callers that scan
 * a module should catch {@link CompileError} (lintSource does) so a half-typed region doesn't abort.
 *
 * @param src - The module source.
 * @param start - The offset of the opening `<`.
 * @returns The parsed markup node and the offset just after the region.
 * @see {@link findMarkupStart}
 * @see {@link CompileError}
 *
 * @example
 * ```ts
 * const { node, end } = parseMarkup('<h1>Hi</h1>', 0);
 * node.kind; // 'element'
 * node.tag;  // 'h1'
 * end;       // 11 (offset just past '</h1>')
 * ```
 */
export function parseMarkup(src: string, start: number): { node: MarkupElement | MarkupFragment; end: number }
{
    const parser = new MarkupParser(src, start);
    try
    {
        const node = parser.parse();
        return { node, end: parser.pos };
    }
    catch (err)
    {
        // Surface whether the parser had committed to markup, so scanners can hard-error
        // on malformed markup while still falling back for an ambiguous TS cast/generic.
        if (err instanceof CompileError)
        {
            err.committed = parser.committed;
        }
        throw err;
    }
}
