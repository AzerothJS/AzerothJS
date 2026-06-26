// @vitest-environment node
//
// Real-execution coverage for the optimize pipeline (constant folding): literal
// text holes and constant attributes are evaluated at compile time and baked into
// the template, their bindings dropped; non-constant bindings are preserved. Also
// covers the evalConstant / tryEvalConstant primitives directly.
import { describe, it, expect } from 'vitest';
import { parseModule } from '@azerothjs/compiler';
import { analyzeComponent } from '../src/analyze.ts';
import { lowerComponent } from '../src/lower.ts';
import { optimize, foldConstants, tryEvalConstant, evalConstant } from '../src/optimize.ts';
import type { ComponentDecl } from '@azerothjs/compiler';
import type { RenderPlan, TemplateElement } from '../src/ir.ts';

function lower(src: string): { src: string; plan: RenderPlan }
{
    const c = parseModule(src).items.find(i => i.kind === 'component') as ComponentDecl;
    const plan = lowerComponent(src, c, analyzeComponent(src, c)) as RenderPlan;
    return { src, plan };
}

describe('foldConstants - text holes', () =>
{
    it('folds a literal arithmetic hole into static text and drops the binding', () =>
    {
        const { src, plan } = lower('component C { <p>{1 + 2}</p> }');
        const folded = optimize(src, plan);
        const root = folded.template as TemplateElement;
        expect(root.children[0]).toMatchObject({ kind: 'text', value: '3' });
        expect(folded.bindings).toHaveLength(0);
    });

    it('folds a string-concat hole', () =>
    {
        const { src, plan } = lower('component C { <p>{"a" + "b"}</p> }');
        const folded = optimize(src, plan);
        expect((folded.template as TemplateElement).children[0]).toMatchObject({ kind: 'text', value: 'ab' });
    });

    it('does not fold a hole that reads a reactive source', () =>
    {
        const { src, plan } = lower('component C { state n = 0; <p>{n + 1}</p> }');
        const folded = optimize(src, plan);
        // The hole stays a hole and its binding survives.
        expect((folded.template as TemplateElement).children[0].kind).toBe('hole');
        expect(folded.bindings).toHaveLength(1);
    });

    it('returns the SAME plan instance when nothing folds', () =>
    {
        const { src, plan } = lower('component C { state n = 0; <p>{n}</p> }');
        expect(foldConstants(src, plan)).toBe(plan);
    });
});

describe('foldConstants - attributes', () =>
{
    it('folds a constant numeric attribute into a static template attribute', () =>
    {
        const { src, plan } = lower('component C { <a tabindex={5}>x</a> }');
        const folded = optimize(src, plan);
        const root = folded.template as TemplateElement;
        expect(root.attrs).toContainEqual({ name: 'tabindex', value: '5' });
        expect(folded.bindings).toHaveLength(0);
    });

    it('folds a true boolean attribute to a bare attribute', () =>
    {
        const { src, plan } = lower('component C { <input disabled={true} /> }');
        const folded = optimize(src, plan);
        expect((folded.template as TemplateElement).attrs).toContainEqual({ name: 'disabled', value: true });
    });

    it('drops a false boolean attribute entirely (absent)', () =>
    {
        const { src, plan } = lower('component C { <input disabled={false} /> }');
        const folded = optimize(src, plan);
        const root = folded.template as TemplateElement;
        expect(root.attrs.some(a => a.name === 'disabled')).toBe(false);
        expect(folded.bindings).toHaveLength(0);
    });
});

describe('evalConstant / tryEvalConstant', () =>
{
    it('evaluates literal arithmetic and concat to a value', () =>
    {
        expect(evalConstant('1 + 2')).toBe(3);
        expect(evalConstant('"a" + "b"')).toBe('ab');
        expect(evalConstant('true')).toBe(true);
        expect(evalConstant('10 % 3')).toBe(1);
        expect(evalConstant('-5')).toBe(-5);
    });

    it('returns null for anything non-constant or unsafe', () =>
    {
        expect(evalConstant('count()')).toBeNull();
        expect(evalConstant('n + 1')).toBeNull();
        expect(evalConstant('1 / 0')).toBeNull();
    });

    it('tryEvalConstant stringifies string/number constants but not booleans', () =>
    {
        expect(tryEvalConstant('1 + 2')).toBe('3');
        expect(tryEvalConstant('"a" + "b"')).toBe('ab');
        // Booleans render specially in text, so they are not folded into text.
        expect(tryEvalConstant('true')).toBeNull();
        expect(tryEvalConstant('count()')).toBeNull();
    });
});
