// @vitest-environment node
//
// Real-execution coverage for parseMarkup + CompileError: elements, attributes
// (static/expression/boolean/spread), expression holes, fragments, components,
// text normalisation, and the documented error cases (mismatched/unclosed tags,
// stray '<', missing attribute value, line comments in markup).
import { describe, it, expect } from 'vitest';
import { parseMarkup, CompileError } from '@azerothjs/compiler';
import type { MarkupElement, MarkupFragment, MarkupExpression, MarkupText } from '@azerothjs/compiler';

function el(src: string): MarkupElement
{
    const { node } = parseMarkup(src, 0);
    expect(node.kind).toBe('element');
    return node as MarkupElement;
}

describe('parseMarkup - elements', () =>
{
    it('parses a simple element with text, reporting the end offset', () =>
    {
        const { node, end } = parseMarkup('<h1>Hi</h1>', 0);
        expect(node.kind).toBe('element');
        const e = node as MarkupElement;
        expect(e.tag).toBe('h1');
        expect(e.isComponent).toBe(false);
        expect(end).toBe(11);
        expect(e.children).toHaveLength(1);
        expect((e.children[0] as MarkupText).kind).toBe('text');
        expect((e.children[0] as MarkupText).value).toBe('Hi');
    });

    it('parses a self-closing element with no children', () =>
    {
        const e = el('<br/>');
        expect(e.tag).toBe('br');
        expect(e.children).toHaveLength(0);
    });

    it('marks a capitalised tag as a component', () =>
    {
        expect(el('<Counter/>').isComponent).toBe(true);
        expect(el('<Foo.Bar/>').isComponent).toBe(true);
        expect(el('<my-elem/>').isComponent).toBe(false);
    });

    it('keeps an apostrophe in text as literal text (not a JS string)', () =>
    {
        const e = el('<p>it\'s me</p>');
        expect((e.children[0] as MarkupText).value).toBe('it\'s me');
    });

    it('collapses whitespace runs containing a newline to a single space', () =>
    {
        const e = el('<p>a\n   b</p>');
        expect((e.children[0] as MarkupText).value).toBe('a b');
    });

    it('drops whitespace-only text between elements', () =>
    {
        const e = el('<div>\n   <span/>\n</div>');
        // Only the <span> child remains - the surrounding whitespace text drops.
        expect(e.children).toHaveLength(1);
        expect((e.children[0] as MarkupElement).tag).toBe('span');
    });
});

describe('parseMarkup - attributes', () =>
{
    it('parses static, expression, and boolean attributes', () =>
    {
        const e = el('<input class="x" value={v} disabled />');
        expect(e.attributes).toHaveLength(3);

        const cls = e.attributes[0];
        expect(cls.name).toBe('class');
        expect(cls.value).toEqual({ kind: 'static', value: 'x' });
        expect(cls.spread).toBe(false);

        const val = e.attributes[1];
        expect(val.name).toBe('value');
        expect(val.value).toEqual({ kind: 'expression', code: 'v' });

        const dis = e.attributes[2];
        expect(dis.name).toBe('disabled');
        expect(dis.value).toEqual({ kind: 'none' });
    });

    it('trims the expression code inside an attribute brace', () =>
    {
        const e = el('<a href={  url + path  }>x</a>');
        expect(e.attributes[0].value).toEqual({ kind: 'expression', code: 'url + path' });
    });

    it('parses a spread attribute (name null, spread true, ... stripped)', () =>
    {
        const e = el('<div {...props}>x</div>');
        const spread = e.attributes[0];
        expect(spread.name).toBeNull();
        expect(spread.spread).toBe(true);
        expect(spread.value).toEqual({ kind: 'expression', code: 'props' });
    });

    it('accepts hyphen/colon attribute names (data-*, aria-*)', () =>
    {
        const e = el('<div data-id="7" aria-label="go">x</div>');
        expect(e.attributes.map(a => a.name)).toEqual(['data-id', 'aria-label']);
    });
});

describe('parseMarkup - holes, fragments, components', () =>
{
    it('captures an expression hole as raw code (verbatim, untrimmed)', () =>
    {
        const e = el('<p>{ count() }</p>');
        const hole = e.children[0] as MarkupExpression;
        expect(hole.kind).toBe('expression');
        expect(hole.code).toBe(' count() ');
    });

    it('drops a comment-only hole', () =>
    {
        const e = el('<p>{/* note */}</p>');
        expect(e.children).toHaveLength(0);
    });

    it('parses a fragment with mixed children', () =>
    {
        const { node } = parseMarkup('<>a{b}<c/></>', 0);
        expect(node.kind).toBe('fragment');
        const f = node as MarkupFragment;
        expect(f.children.map(c => c.kind)).toEqual(['text', 'expression', 'element']);
    });

    it('nests elements and preserves spans', () =>
    {
        const e = el('<ul><li>a</li><li>b</li></ul>');
        expect(e.children).toHaveLength(2);
        expect(e.start).toBe(0);
        expect(e.end).toBe('<ul><li>a</li><li>b</li></ul>'.length);
    });
});

describe('parseMarkup - CompileError cases', () =>
{
    it('throws on a mismatched closing tag with the offending offset', () =>
    {
        let err: CompileError | null = null;
        try
        {
            parseMarkup('<a></b>', 0);
        }
        catch (e)
        {
            err = e as CompileError;
        }
        expect(err).toBeInstanceOf(CompileError);
        expect(err!.name).toBe('CompileError');
        expect(err!.message).toContain('Mismatched closing tag');
        expect(err!.offset).toBe(6);
    });

    it('throws on an unclosed element at EOF', () =>
    {
        expect(() => parseMarkup('<a>', 0)).toThrow(CompileError);
    });

    it('throws on a missing attribute value', () =>
    {
        let err: CompileError | null = null;
        try
        {
            parseMarkup('<div class=>x</div>', 0);
        }
        catch (e)
        {
            err = e as CompileError;
        }
        expect(err).toBeInstanceOf(CompileError);
        expect(err!.message).toContain('Expected a value for attribute');
    });

    it('throws on a stray < in markup text with a helpful message', () =>
    {
        let err: CompileError | null = null;
        try
        {
            parseMarkup('<p>a < b</p>', 0);
        }
        catch (e)
        {
            err = e as CompileError;
        }
        expect(err).toBeInstanceOf(CompileError);
        expect(err!.message).toContain('Unexpected \'<\'');
    });

    it('throws on a line comment used inside markup text', () =>
    {
        let err: CompileError | null = null;
        try
        {
            parseMarkup('<p>// not a comment</p>', 0);
        }
        catch (e)
        {
            err = e as CompileError;
        }
        expect(err).toBeInstanceOf(CompileError);
        expect(err!.message).toContain('Line comments');
    });
});
