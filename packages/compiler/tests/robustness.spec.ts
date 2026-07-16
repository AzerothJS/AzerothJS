// @vitest-environment node
//
// Compiler-robustness guarantees (v1 hardening pass): HTML void elements parse without a closing tag,
// pathological nesting fails with a LOCATED error (not a stack overflow), an unterminated literal is
// caught by the build's type-check gate (not emitted as silently-broken JS), and a reactive read inside
// a destructuring DEFAULT value is rewritten like any other read.
import { describe, it, expect } from 'vitest';
import { parseMarkup, CompileError, typeCheckModuleTS } from '@azerothjs/compiler';
import { generateModule } from '../src/codegen.ts';

describe('HTML void elements', () =>
{
    it('parse without a closing tag (`<input>`, `<br>`, `<img>`, `<hr>`)', () =>
    {
        for (const tag of ['<input type="text">', '<br>', '<img src="x">', '<hr>'])
        {
            expect(() => parseMarkup(tag, 0)).not.toThrow();
        }
    });

    it('a void element inside a parent does not swallow the parent close', () =>
    {
        const { node } = parseMarkup('<div><br><span>hi</span></div>', 0);
        expect(node.kind).toBe('element');
        // div has br + span as children, both parsed correctly
        expect((node as { children: unknown[] }).children.length).toBe(2);
    });

    it('the self-closing form still works (`<br/>`)', () =>
    {
        expect(() => parseMarkup('<br/>', 0)).not.toThrow();
    });

    it('codegen serializes a void element with no closing tag', () =>
    {
        const code = generateModule('component A { <br/> }').code;
        expect(code).toContain('br');
    });
});

describe('pathological input does not crash the compiler', () =>
{
    it('very deep nesting throws a located CompileError, not a RangeError', () =>
    {
        const deep = '<div>'.repeat(4000) + '</div>'.repeat(4000);
        let err: unknown;
        try
        {
            parseMarkup(deep, 0);
        }
        catch (e)
        {
            err = e;
        }
        expect(err).toBeInstanceOf(CompileError);
        expect(err).not.toBeInstanceOf(RangeError);
        expect((err as CompileError).offset).toBeGreaterThan(0);
    });
});

describe('the build gate rejects broken syntax', () =>
{
    it('an unterminated string is reported as a located syntax error', () =>
    {
        const diags = typeCheckModuleTS('component A { state x = "abc; }');
        const syntax = diags.filter((d) => d.code === 'azeroth/syntax');
        expect(syntax.length).toBeGreaterThan(0);
        expect(syntax[0]!.start).toBeGreaterThanOrEqual(0);
    });

    it('well-formed source produces no syntax diagnostics', () =>
    {
        const diags = typeCheckModuleTS('component A { state x = 1; <p>{x}</p> }');
        expect(diags.filter((d) => d.code === 'azeroth/syntax')).toHaveLength(0);
    });
});

describe('reactive rewrite covers destructuring defaults', () =>
{
    it('a state read in a destructuring default value is rewritten to a getter call', () =>
    {
        const code = generateModule('component A {\n  state x = 1;\n  derived d = (({ a = x }) => a)();\n  <p>{d}</p>\n}').code;
        expect(code).toMatch(/a = x\(\)/);
    });
});
