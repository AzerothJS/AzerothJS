// Parses one markup region (an element or fragment) starting at a `<` into the
// AST from types.ts. Expression holes (`{ ... }`) and attribute expressions
// are captured as raw source - nested markup inside them is handled later by
// codegen, which recursively compiles the hole text. That keeps the parser
// focused purely on markup structure.

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
    constructor(message: string, public readonly offset: number)
    {
        super(message);
        this.name = 'CompileError';
    }
}

class MarkupParser
{
    constructor(private readonly src: string, public pos: number)
    {}

    /** Entry point; `pos` must be at the opening `<`. */
    public parse(): MarkupElement | MarkupFragment
    {
        return this.parseElement();
    }

    private peek(offset = 0): string
    {
        return this.src[this.pos + offset] ?? '';
    }

    private skipWs(): void
    {
        while (this.pos < this.src.length && isWhitespace(this.src[this.pos]))
        {
            this.pos++;
        }
    }

    private expect(ch: string): void
    {
        if (this.peek() !== ch)
        {
            throw new CompileError(
                `Expected '${ ch }' but found '${ this.peek() || 'EOF' }'`,
                this.pos
            );
        }
        this.pos++;
    }

    /** `pos` at `<`. Parses an element or `<>...</>` fragment. */
    private parseElement(): MarkupElement | MarkupFragment
    {
        const start = this.pos;
        this.expect('<');

        // Fragment: `<>`
        if (this.peek() === '>')
        {
            this.pos++; // past '>'
            const children = this.parseChildren();
            this.expectClosingTag(''); // </>
            return { kind: 'fragment', children, start, end: this.pos };
        }

        // A `<` that is neither a fragment, a closing tag, nor the start of a
        // tag name is a literal less-than in markup text - the single most
        // common authoring mistake. Diagnose it where it sits instead of the
        // opaque "Expected a tag name".
        if (this.peek() !== '/' && !isIdentStart(this.peek()))
        {
            throw new CompileError(
                'Unexpected \'<\' in markup; write a literal \'<\' as {\'<\'} or &lt;',
                start
            );
        }

        const tag = this.readTagName();
        const attributes = this.parseAttributes();
        this.skipWs();

        // Self-closing: `<tag ... />`
        if (this.peek() === '/')
        {
            this.pos++;
            this.expect('>');
            return {
                kind: 'element',
                tag,
                isComponent: MarkupParser.isComponentTag(tag),
                attributes,
                children: [],
                start,
                end: this.pos
            };
        }

        this.expect('>');
        const children = this.parseChildren();
        this.expectClosingTag(tag);

        return {
            kind: 'element',
            tag,
            isComponent: MarkupParser.isComponentTag(tag),
            attributes,
            children,
            start,
            end: this.pos
        };
    }

    private static isComponentTag(tag: string): boolean
    {
        return /[A-Z]/.test(tag[0] ?? '') || tag.includes('.');
    }

    /** Reads a tag name: identifiers plus `.` (`Foo.Bar`) and `-` (custom elements). */
    private readTagName(): string
    {
        const start = this.pos;
        if (!isIdentStart(this.peek()))
        {
            throw new CompileError('Expected a tag name', this.pos);
        }
        this.pos++;
        while (this.pos < this.src.length)
        {
            const ch = this.src[this.pos];
            if (isIdentPart(ch) || ch === '.' || ch === '-')
            {
                this.pos++;
            }
            else
            {
                break;
            }
        }
        return this.src.slice(start, this.pos);
    }

    private parseAttributes(): MarkupAttribute[]
    {
        const attrs: MarkupAttribute[] = [];

        for (;;)
        {
            this.skipWs();
            const ch = this.peek();

            // End of the opening tag.
            if (ch === '>' || ch === '/' || ch === '')
            {
                break;
            }

            const attrStart = this.pos;

            // Spread: `{...expr}`
            if (ch === '{')
            {
                const end = skipBalanced(this.src, this.pos);
                const inner = this.src.slice(this.pos + 1, end - 1).trim();
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

            // Named attribute.
            const name = this.readAttributeName();
            this.skipWs();

            if (this.peek() !== '=')
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
            this.skipWs();
            const valueChar = this.peek();

            if (valueChar === '{')
            {
                const end = skipBalanced(this.src, this.pos);
                const code = this.src.slice(this.pos + 1, end - 1).trim();
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
                const end = skipString(this.src, this.pos);
                const value = this.src.slice(this.pos + 1, end - 1);
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
                    `Expected a value for attribute '${ name }'`,
                    this.pos
                );
            }
        }

        return attrs;
    }

    /** Attribute names: identifiers plus `-` and `:` (`data-x`, `aria-label`). */
    private readAttributeName(): string
    {
        const start = this.pos;
        while (this.pos < this.src.length)
        {
            const ch = this.src[this.pos];
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
            throw new CompileError('Expected an attribute name', this.pos);
        }
        return this.src.slice(start, this.pos);
    }

    private parseChildren(): MarkupChild[]
    {
        const children: MarkupChild[] = [];

        while (this.pos < this.src.length)
        {
            // Closing tag -> stop.
            if (this.peek() === '<' && this.peek(1) === '/')
            {
                break;
            }

            if (this.peek() === '<')
            {
                children.push(this.parseElement());
                continue;
            }

            if (this.peek() === '{')
            {
                const start = this.pos;
                const end = skipBalanced(this.src, this.pos);
                const code = this.src.slice(this.pos + 1, end - 1);
                this.pos = end;
                // Drop comment-only / empty holes (e.g. `{/* note */}`).
                if (!MarkupParser.isEmptyExpression(code))
                {
                    children.push({ kind: 'expression', code, start, end });
                }
                continue;
            }

            const text = this.readText();
            if (text)
            {
                children.push(text);
            }
        }

        return children;
    }

    /** Reads raw text up to the next `<` or `{`, normalised the usual way. */
    private readText(): MarkupText | null
    {
        const start = this.pos;
        while (this.pos < this.src.length && this.peek() !== '<' && this.peek() !== '{')
        {
            this.pos++;
        }
        const raw = this.src.slice(start, this.pos);

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

        const value = MarkupParser.normalizeText(raw);
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
    private static normalizeText(raw: string): string
    {
        if (/^\s*$/.test(raw))
        {
            return '';
        }
        return raw.replace(/\s*\n\s*/g, ' ');
    }

    /** True when a `{ ... }` hole has no actual expression (only comments/space). */
    private static isEmptyExpression(code: string): boolean
    {
        const stripped = code
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '')
            .trim();
        return stripped === '';
    }

    /** Consumes `</tag>` (or `</>` when `tag === ''`). */
    private expectClosingTag(tag: string): void
    {
        this.expect('<');
        this.expect('/');
        this.skipWs();
        if (tag !== '')
        {
            const closing = this.readTagName();
            if (closing !== tag)
            {
                throw new CompileError(
                    `Mismatched closing tag: expected </${ tag }> but found </${ closing }>`,
                    this.pos
                );
            }
        }
        this.skipWs();
        this.expect('>');
    }
}

/**
 * Parses the markup element/fragment beginning at `start` (the `<`). Returns
 * the AST node and the offset just after it.
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
    const node = parser.parse();
    return { node, end: parser.pos };
}
