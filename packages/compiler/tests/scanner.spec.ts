// @vitest-environment node
//
// Real-execution coverage for the scanner: the predicate/skip helpers and
// findMarkupStart's expression-position detection (markup vs less-than vs
// generic arrow, and non-code span skipping). No mocks - the real scanner.
import { describe, it, expect } from 'vitest';
import {
    findMarkupStart,
    isWhitespace,
    isIdentStart,
    isIdentPart,
    skipBalanced,
    skipString,
    skipTemplate,
    skipLineComment,
    skipBlockComment,
    skipRegex
} from '@azerothjs/compiler';

describe('scanner - character predicates', () =>
{
    it('isWhitespace recognises only ASCII whitespace forms', () =>
    {
        for (const ch of [' ', '\t', '\n', '\r', '\f', '\v'])
        {
            expect(isWhitespace(ch)).toBe(true);
        }
        expect(isWhitespace('x')).toBe(false);
        expect(isWhitespace('_')).toBe(false);
    });

    it('isIdentStart accepts letters, underscore, and dollar but not digits', () =>
    {
        expect(isIdentStart('h')).toBe(true);
        expect(isIdentStart('Z')).toBe(true);
        expect(isIdentStart('_')).toBe(true);
        expect(isIdentStart('$')).toBe(true);
        expect(isIdentStart('1')).toBe(false);
        expect(isIdentStart('-')).toBe(false);
    });

    it('isIdentPart additionally accepts digits but still rejects punctuation', () =>
    {
        expect(isIdentPart('a')).toBe(true);
        expect(isIdentPart('1')).toBe(true);
        expect(isIdentPart('$')).toBe(true);
        expect(isIdentPart('-')).toBe(false);
        expect(isIdentPart('.')).toBe(false);
    });
});

describe('scanner - skip helpers', () =>
{
    it('skipLineComment stops at the newline (not past it)', () =>
    {
        const src = 'a // note\nb';
        const end = skipLineComment(src, 2);
        expect(src[end]).toBe('\n');
        expect(end).toBe(9);
    });

    it('skipBlockComment returns the index just past the close, clamped at EOF', () =>
    {
        const src = '/* hi */x';
        const end = skipBlockComment(src, 0);
        expect(src[end]).toBe('x');
        // An unterminated block comment clamps to the source length.
        const open = '/* never closed';
        expect(skipBlockComment(open, 0)).toBe(open.length);
    });

    it('skipString consumes through escapes and the closing quote', () =>
    {
        const src = 'x = "a\\"b" + y';
        const end = skipString(src, 4);
        // Just past the closing quote of "a\"b".
        expect(src.slice(4, end)).toBe('"a\\"b"');
    });

    it('skipTemplate handles ${ ... } substitutions and nested braces', () =>
    {
        const src = 'tag`a${ b + { c: 1 }.c }z` + d';
        const end = skipTemplate(src, 3);
        expect(src[end - 1]).toBe('`');
        expect(src.slice(end)).toBe(' + d');
    });

    it('skipRegex consumes the body, a character class, and trailing flags', () =>
    {
        const src = 'x = /a[/]b/gi;';
        const end = skipRegex(src, 4);
        expect(src.slice(4, end)).toBe('/a[/]b/gi');
    });

    it('skipBalanced matches nested brackets across strings and comments', () =>
    {
        const src = '{ a: { b: "}" /* } */ } } rest';
        const end = skipBalanced(src, 0);
        expect(src.slice(end)).toBe(' rest');
    });

    it('skipBalanced on an unbalanced open runs to EOF', () =>
    {
        const src = '{ a: 1';
        expect(skipBalanced(src, 0)).toBe(src.length);
    });

    // The scanner consumes regex literals and embedded markup as units. Scanned as chars
    // instead, a regex or an apostrophe inside a hole desyncs the brace scanner (an inner
    // apostrophe triggers a string skip that runs to EOF), hard-failing the whole build
    // with a bogus "Unclosed tag".
    it('skipBalanced treats a regex literal in expression position as a unit', () =>
    {
        const src = '{ name.replace(/\'/g, "") } rest';
        const end = skipBalanced(src, 0);
        expect(src.slice(end)).toBe(' rest');
    });

    it('skipBalanced skips a regex whose body contains braces and parens', () =>
    {
        const src = '{ s.match(/[{}()]/) ? 1 : 0 } rest';
        const end = skipBalanced(src, 0);
        expect(src.slice(end)).toBe(' rest');
    });

    it('skipBalanced still treats `/` after a value as division, not a regex', () =>
    {
        const src = '{ a / b } rest';
        const end = skipBalanced(src, 0);
        expect(src.slice(end)).toBe(' rest');
    });

    it('skipBalanced skips embedded markup whose TEXT contains an apostrophe', () =>
    {
        const src = '{ ok ? <span>Don\'t</span> : <span>Do</span> } rest';
        const end = skipBalanced(src, 0);
        expect(src.slice(end)).toBe(' rest');
    });

    it('skipBalanced skips a self-closing element and a void element in a hole', () =>
    {
        expect('{ show ? <br> : <hr/> } rest'.slice(skipBalanced('{ show ? <br> : <hr/> } rest', 0))).toBe(' rest');
    });

    it('skipBalanced skips nested markup with holes and closing tags', () =>
    {
        const src = '{ <ul><li>{ item(\'a\') }</li></ul> } rest';
        const end = skipBalanced(src, 0);
        expect(src.slice(end)).toBe(' rest');
    });
});

describe('findMarkupStart - expression position detection', () =>
{
    it('finds a tag in return position', () =>
    {
        expect(findMarkupStart('return <h1>Hi</h1>;', 0)).toBe(7);
    });

    it('finds a fragment in expression position', () =>
    {
        expect(findMarkupStart('x = <>hi</>', 0)).toBe(4);
    });

    it('rejects a less-than operator (a < b)', () =>
    {
        expect(findMarkupStart('a < b', 0)).toBe(-1);
    });

    it('finds markup after a block close (the effect{}/dispose{} then render shape)', () =>
    {
        // A reactive block closes with `}`, and the trailing markup must read as markup -
        // not as a less-than off the `}`. This is what the editor's markup model relies on.
        const src = 'effect { run(); } <div>hi</div>';
        expect(src[findMarkupStart(src, 0)]).toBe('<');
        expect(findMarkupStart(src, 0)).toBe(src.indexOf('<div>'));
    });

    it('still rejects a spaced comparison after a `}` (object literal `< b`)', () =>
    {
        // `{a:1} < b` is a comparison: a markup `<` must be immediately followed by `>` or an
        // identifier, and here it is followed by a space, so it stays a less-than.
        expect(findMarkupStart('({a:1}) < b', 0)).toBe(-1);
    });

    it('does not look inside string literals', () =>
    {
        expect(findMarkupStart('const s = "<p>";', 0)).toBe(-1);
    });

    it('does not look inside template literals', () =>
    {
        expect(findMarkupStart('const s = `<p>`;', 0)).toBe(-1);
    });

    it('does not look inside line or block comments', () =>
    {
        expect(findMarkupStart('// <p>\n', 0)).toBe(-1);
        expect(findMarkupStart('/* <p> */', 0)).toBe(-1);
    });

    it('does not look inside a regex literal', () =>
    {
        // The `/` is in expression position, so `<p>` lives inside the regex.
        expect(findMarkupStart('x = /<p>/;', 0)).toBe(-1);
    });

    it('skips a generic arrow type-parameter list but still finds later markup', () =>
    {
        const src = 'const f = <T>(x: T) => x;';
        expect(findMarkupStart(src, 0)).toBe(-1);
        // The arrow body after the type-params is ordinary code that may contain markup.
        const src2 = 'const f = <T>(x: T) => <p>{x}</p>;';
        expect(src2[findMarkupStart(src2, 0)]).toBe('<');
        expect(findMarkupStart(src2, 0)).toBe(src2.indexOf('<p>'));
    });

    it('returns -1 at end of input', () =>
    {
        expect(findMarkupStart('const x = 1;', 0)).toBe(-1);
    });

    it('resumes scanning from the given offset', () =>
    {
        const src = 'return <a/>; return <b/>;';
        const first = findMarkupStart(src, 0);
        expect(src.slice(first, first + 2)).toBe('<a');
        const second = findMarkupStart(src, first + 1);
        expect(src.slice(second, second + 2)).toBe('<b');
    });
});
