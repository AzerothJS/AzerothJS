/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
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
    attributeParsingContext,
    decodeEntities,
    findMarkupStart,
    rawTextEnd,
    isIdentStart,
    isIdentPart,
    isWhitespace,
    skipBalanced,
    skipString
} from './scanner.ts';
import {
    VOID_ELEMENTS, contentModel, elementNamespace, hostChildContext, hostNamespaceForTag,
    isComponentTag, resolveMarkupContext, voidChildrenMessage, type MarkupContext
} from 'azerothjs/semantics';

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

    /**
     * True only for the depth-cap failure ({@link markupDepthError}). A walker that DEGRADES on a parse
     * error - half-typed markup is the normal editor state - must RETHROW this one: it is raised by the
     * walker's own recursion, so swallowing it would emit the raw markup text as if it were code, and
     * the next level up would swallow it again all the way to a silently corrupt module.
     */
    public depthExceeded = false;

    public readonly offset: number;

    constructor(message: string, offset: number)
    {
        super(message);
        this.name = 'CompileError';
        this.offset = offset;
    }
}

/**
 * Maximum markup nesting depth. Real component trees are nowhere near this; the cap exists so a
 * pathological or adversarial input (thousands of unclosed `<div>`s) fails with a located
 * {@link CompileError} instead of overflowing the recursive parser's stack.
 */
export const MAX_MARKUP_DEPTH = 500;

/**
 * The located failure the depth cap raises. Exported because the cap is per {@link parseMarkup} call
 * and nesting through an expression hole re-enters the parser at depth 0 - so the hole walkers
 * (codegen's and the projection's) count their own recursion against the same cap and raise the same
 * error, instead of letting the stack overflow with an unlocated RangeError.
 */
export function markupDepthError(offset: number): CompileError
{
    const error = new CompileError(
        `Markup nested deeper than ${ MAX_MARKUP_DEPTH } levels. This is almost ` +
        'always an unclosed tag; check that every element has a matching closing tag.',
        offset
    );
    error.depthExceeded = true;
    return error;
}

/** Last attribute that can set the encoding, in prop application order. */
export function annotationEncoding(node: MarkupElement): MarkupAttribute | undefined
{
    return node.attributes.findLast(attr => attr.spread || attr.name?.toLowerCase() === 'encoding' || attr.name?.toLowerCase() === 'bind:encoding');
}

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
    public parse(parentNamespace?: MarkupContext): MarkupElement | MarkupFragment
    {
        return this.#parseElement(parentNamespace);
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
    #parseElement(parent?: MarkupContext): MarkupElement | MarkupFragment
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
            const children = this.#parseChildren(parent);
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
        const context = parent === undefined ? undefined : resolveMarkupContext(parent, tag);
        const isComponent = isComponentTag(tag);
        const namespace = isComponent ? context : elementNamespace(tag, context ?? hostNamespaceForTag(tag));
        const attributes = this.#parseAttributes(isComponent, parent);
        const node: MarkupElement = { kind: 'element', tag, isComponent, attributes, children: [], start, end: this.pos };
        if (namespace !== undefined)
        {
            node.namespace = namespace;
        }
        if (isComponent && parent !== undefined && parent !== namespace)
        {
            node.context = parent;
        }
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
            node.end = this.pos;
            return node;
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
        // Authored children ARE a located error, not leftovers: without the lookahead below, a root
        // `<input>text</input>` ends the markup region at the void tag and `text</input>` leaks into
        // the surrounding code as garbage the author is then blamed for.
        if (namespace === 'html' && VOID_ELEMENTS.has(tag))
        {
            this.#rejectVoidChildren(tag);
            node.end = this.pos;
            return node;
        }

        // Both text models keep CSS and JSON-LD free of hole parsing. Only foreign text has CDATA sections.
        const model = isComponent ? null : contentModel(tag, namespace);
        if (model === 'raw-text' || model === 'foreign-text')
        {
            node.children = this.#parseRawText(tag, model === 'foreign-text');
        }
        else
        {
            const encoding = tag.toLowerCase() === 'annotation-xml' ? annotationEncoding(node)?.value : undefined;
            const childContext = isComponent ? parent : hostChildContext(tag, namespace ?? 'html', encoding?.kind === 'static' ? encoding.value : undefined);
            node.children = this.#parseChildren(childContext);
        }
        this.#expectClosingTag(tag);
        node.end = this.pos;
        return node;
    }

    /**
     * Reads a raw-text element's content verbatim, stopping at the matching close tag (`</tag`
     * followed by whitespace / `/` / `>` / EOF). No hole or nested-tag parsing: `{`, `<`, `&` are
     * literal, so CSS and JSON-LD survive intact. The tag match is case-sensitive, consistent with
     * {@link #expectClosingTag} (a `</Style>` close on a `<style>` is a mismatch, as `</DIV>` is on a
     * `<div>`). Returns a single text child (or none, for an empty element); `pos` is left at the `<`
     * of the close tag for {@link #expectClosingTag}.
     */
    #parseRawText(tag: string, foreign: boolean): MarkupChild[]
    {
        const start = this.pos;
        this.pos = rawTextEnd(this.#src, start, tag);
        let value = this.#src.slice(start, this.pos);
        if (foreign && value.includes('<![CDATA['))
        {
            const pieces: string[] = [];
            let cursor = 0;
            let section = value.indexOf('<![CDATA[');
            while (section !== -1)
            {
                const content = section + '<![CDATA['.length;
                const close = value.indexOf(']]>', content);
                if (close === -1)
                {
                    throw new CompileError(`Unclosed CDATA section in <${ tag }>; end the section with ]]>`, start + section);
                }
                pieces.push(value.slice(cursor, section), value.slice(content, close));
                cursor = close + ']]>'.length;
                section = value.indexOf('<![CDATA[', cursor);
            }
            pieces.push(value.slice(cursor));
            value = pieces.join('');
        }
        return value === '' ? [] : [{ kind: 'text', value, start, end: this.pos }];
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

    #parseAttributes(isComponent: boolean, context?: MarkupContext): MarkupAttribute[]
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
                const end = skipBalanced(this.#src, this.pos, attributeParsingContext(isComponent, null, context));
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
                const end = skipBalanced(this.#src, this.pos, attributeParsingContext(isComponent, name, context));
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
                // Decoded like text content (HTML decodes references in both places), so
                // `title="Tom &amp; Jerry"` carries the `&` the author meant instead of reaching the
                // emitter as literal entity text and being escaped a second time. NOT normalised:
                // whitespace collapse is text-node-specific, an attribute value keeps its spacing.
                const value = decodeEntities(this.#src.slice(this.pos + 1, end - 1));
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

    #parseChildren(parent?: MarkupContext): MarkupChild[]
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
                    throw markupDepthError(this.pos);
                }
                children.push(this.#parseElement(parent));
                this.#depth--;
                continue;
            }

            if (this.#peek() === '{')
            {
                const start = this.pos;
                const end = skipBalanced(this.#src, this.pos, parent);
                const code = this.#src.slice(this.pos + 1, end - 1);
                this.pos = end;
                // Drop comment-only / empty holes (e.g. `{/* note */}`).
                if (!MarkupParser.#isEmptyExpression(code))
                {
                    children.push({ kind: 'expression', code, start, end, ...(parent !== undefined && { namespace: parent }) });
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
        // Only ASCII spacing is marked: a character reference or a non-ASCII space is text.
        return /^[ \t\f\v\r]+$/.test(raw)
            ? { kind: 'text', value, start, end: this.pos, spacing: true }
            : { kind: 'text', value, start, end: this.pos };
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
            // Only FORMATTING whitespace (a run containing a newline - indentation
            // between block-ish children) disappears. A same-line space between two
            // inline children (`{ label } <span>`) is authored spacing and must
            // survive as a single-space text node, or the neighbours render fused.
            return raw.includes('\n') ? '' : ' ';
        }
        // The newline test runs in JS, not in the pattern: a `\s*\n\s*` (or `[^\S\n]*\n[^\S\n]*`)
        // shape makes a newline-free whitespace run quadratic - the leading quantifier consumes the
        // whole run at every start offset and hands it back one character at a time. Measured at
        // 160000 spaces: 4.6s for the pattern form, 0.2ms for this one. It matters because lintSource
        // and generateVirtualCode re-normalise the region on every keystroke.
        return decodeEntities(raw.replace(/\s+/g, run => run.includes('\n') ? ' ' : run));
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

    /**
     * Lookahead after a completed void tag (nothing consumed): a text run followed by the void
     * tag's OWN closing tag means the author wrote children. Rejecting here, with the content's
     * position, is the difference between a clear rule and the markup region silently ending at
     * the void element - which re-parses `text</input>` as surrounding CODE and blames the
     * author with an unrelated syntax error.
     */
    #rejectVoidChildren(tag: string): void
    {
        let i = this.pos;
        while (i < this.#src.length && this.#src[i] !== '<' && this.#src[i] !== '}')
        {
            i++;
        }
        if (!this.#src.startsWith('</', i))
        {
            return;
        }
        let j = i + 2;
        while (j < this.#src.length && isWhitespace(this.#src[j]))
        {
            j++;
        }
        if (this.#src.slice(j, j + tag.length).toLowerCase() === tag && !isIdentPart(this.#src[j + tag.length] ?? ''))
        {
            throw new CompileError(voidChildrenMessage(tag), this.pos);
        }
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
 * Parses the element or fragment beginning at `start` into an AST node. This is the single
 * markup grammar, shared by codegen, lint and lowering, so all three see the same tree.
 *
 * Expression holes and attribute expressions are captured as RAW spans rather than parsed
 * here; nested markup inside them is compiled later. Keeping this to pure markup structure is
 * what leaves TypeScript as the one grammar responsible for expression interiors.
 *
 * Whitespace-only text between tags is dropped.
 *
 * @param src - The module source.
 * @param start - MUST be the offset of the opening `<`. Anywhere else throws or mis-parses.
 * @param parentNamespace - The insertion context for embedded markup. A standalone root uses its tag.
 * @returns The parsed node, and the offset just past the region.
 * @throws {CompileError} On malformed markup - a mismatched or unclosed tag - carrying the
 *                        offending offset. A caller scanning a whole module should catch it,
 *                        as lintSource does, so a half-typed region does not abort the scan.
 * @example
 * const { node, end } = parseMarkup('<h1>Hi</h1>', 0);
 * node.kind; // 'element'
 * node.tag;  // 'h1'
 * end;       // 11, just past '</h1>'
 *
 * @see {@link findMarkupStart}, which supplies `start`.
 */
export function parseMarkup(src: string, start: number, parentNamespace?: MarkupContext): { node: MarkupElement | MarkupFragment; end: number }
{
    const parser = new MarkupParser(src, start);
    try
    {
        const node = parser.parse(parentNamespace);
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

/**
 * Replaces every markup region in `source[start..end)` with `0` plus spaces, keeping all
 * offsets stable, so TypeScript can parse the surrounding statements cleanly. Markup is not TS;
 * an unblanked parse swallows whatever follows it.
 */
export function blankMarkupRegions(source: string, start: number, end: number): string
{
    let out = source.slice(start, end);
    let pos = start;
    for (;;)
    {
        const at = findMarkupStart(source, pos);
        if (at === -1 || at >= end)
        {
            return out;
        }
        let regionEnd: number;
        try
        {
            regionEnd = parseMarkup(source, at).end;
        }
        catch
        {
            return out;
        }
        const stop = Math.min(regionEnd, end);
        out = out.slice(0, at - start) + '0' + ' '.repeat(stop - at - 1) + out.slice(stop - start);
        pos = regionEnd;
    }
}
