// Unit tests for the two load-bearing pieces the rest of the service is built
// on: the virtual-code generator (does the compiled TS match the compiler, and
// is the offset mapping precise?) and the markup model (does it classify the
// caret correctly, including on half-typed input?).

import { describe, it, expect } from 'vitest';
import {
    generateVirtualCode,
    classifyPosition,
    collectMarkupNodes
} from '@azerothjs/language-service';
import { compile } from '@azerothjs/compiler';

describe('generateVirtualCode - matches the compiler and maps precisely', () =>
{
    it('compiles markup to h() calls and declares the h binding', () =>
    {
        const { code } = generateVirtualCode('const x = <h1>Count: {count()}</h1>;');
        expect(code).toContain("h('h1', {  }, 'Count: ', () => (count()))");
        // h is provided as an ambient declaration APPENDED after the user code,
        // not a real import - so TypeScript's auto-import has no same-module
        // merge target in generated code (see finalize()), and a new import
        // lands in the user's own section at the top. The user code is therefore
        // still first, byte-for-byte.
        expect(code).toMatch(/^const x = h\('h1'/);
        expect(code).toContain("declare const h: typeof import('@azerothjs/core').h;");
    });

    // Regression: the type-check (virtual) output and the runtime (compiler)
    // output MUST emit the same component call. They once diverged - virtual
    // emitted `Comp({ })` while the compiler emitted `Comp()` - so a `<Comp/>`
    // whose component required a props object type-checked clean yet crashed at
    // runtime on `props` being undefined. An attribute-less tag is a bare call.
    it('emits a bare zero-arg component call, identical to the compiler', () =>
    {
        const src = 'const x = <Spinner/>;';
        const virtual = generateVirtualCode(src).code;
        const runtime = compile(src, 'x.azeroth').code;
        expect(virtual).toContain('Spinner()');
        expect(virtual).not.toContain('Spinner({');
        expect(runtime).toContain('Spinner()');
    });

    it('leaves a markup-free module byte-for-byte identical (1:1 mapping)', () =>
    {
        const src = 'const a = 1 + 2;\nexport const b = a;';
        const { code, mapping } = generateVirtualCode(src);
        expect(code).toBe(src);
        // Every original offset maps to the same generated offset.
        for (let o = 0; o < src.length; o++)
        {
            expect(mapping.toGenerated(o)).toBe(o);
        }
    });

    it('maps an expression-hole identifier back to its exact source span', () =>
    {
        const src = 'const x = <p>{value}</p>;';
        const { code, mapping } = generateVirtualCode(src);
        const sourceOffset = src.indexOf('value');
        const generatedOffset = mapping.toGenerated(sourceOffset);
        expect(generatedOffset).not.toBeNull();
        expect(code.slice(generatedOffset!, generatedOffset! + 5)).toBe('value');
        // Round-trips back.
        expect(mapping.toOriginal(generatedOffset!)).toBe(sourceOffset);
    });

    it('maps a component tag name (enabling go-to-definition on components)', () =>
    {
        const src = 'const x = <Counter start={0}/>;';
        const { code, mapping } = generateVirtualCode(src);
        const sourceOffset = src.indexOf('Counter');
        const generatedOffset = mapping.toGenerated(sourceOffset);
        expect(generatedOffset).not.toBeNull();
        expect(code.slice(generatedOffset!, generatedOffset! + 7)).toBe('Counter');
    });

    it('does not throw on half-typed markup (degrades gracefully)', () =>
    {
        expect(() => generateVirtualCode('const x = <di')).not.toThrow();
        expect(() => generateVirtualCode('const x = <div class=')).not.toThrow();
    });
});

describe('classifyPosition - context detection', () =>
{
    it('detects a tag-name position', () =>
    {
        const ctx = classifyPosition('const x = <di', 13);
        expect(ctx.kind).toBe('tagName');
    });

    it('detects a tag typed inside otherwise-broken markup', () =>
    {
        // A freshly-typed `<div` child makes the region unparseable; the caret
        // must still classify as a tag name (not text/script).
        const src = 'const x = <section><h1>a</h1>\n  <div\n</section>;';
        const ctx = classifyPosition(src, src.indexOf('<div') + 4);
        expect(ctx).toMatchObject({ kind: 'tagName', partial: 'div' });
    });

    it('does not treat a comparison or generic as a tag', () =>
    {
        expect(classifyPosition('const x = a<b;', 12).kind).toBe('script');
        expect(classifyPosition('createSignal<Todo>(x)', 17).kind).toBe('script');
    });

    it('detects an attribute-name position (even unparseable)', () =>
    {
        const ctx = classifyPosition('const x = <div cla', 18);
        expect(ctx).toMatchObject({ kind: 'attributeName', tag: 'div' });
    });

    it('detects an expression position inside a hole', () =>
    {
        const src = 'const x = <p>{count()}</p>;';
        expect(classifyPosition(src, src.indexOf('count')).kind).toBe('expression');
    });

    it('detects an expression position inside an attribute value', () =>
    {
        const src = 'const x = <a href={url()}>y</a>;';
        expect(classifyPosition(src, src.indexOf('url')).kind).toBe('expression');
    });

    it('treats code outside markup as script', () =>
    {
        expect(classifyPosition('const a = 1;', 6).kind).toBe('script');
    });
});

describe('collectMarkupNodes - descends into holes', () =>
{
    it('finds nested markup inside a .map() hole', () =>
    {
        const nodes = collectMarkupNodes('const x = <ul>{items.map(i => <li>{i}</li>)}</ul>;');
        const tags = nodes.filter(n => n.kind === 'element').map(n => (n as { tag: string }).tag);
        expect(tags).toContain('ul');
        expect(tags).toContain('li');
    });
});
