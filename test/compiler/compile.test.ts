import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compile, findMarkupStart, vlqEncode } from '@azerothjs/compiler';

/** Compiles and returns just the code (trimmed of the auto h-import). */
function body(src: string): string
{
    return compile(src).code;
}

describe('compile() - elements & text', () =>
{
    it('compiles a simple element with text', () =>
    {
        expect(body('const x = <div>hi</div>;'))
            .toContain('h(\'div\', {  }, \'hi\')');
    });

    it('auto-injects the h import when markup is present', () =>
    {
        expect(body('const x = <div/>;')).toMatch(/^import \{ h \} from '@azerothjs\/core';/);
    });

    it('does NOT inject h when there is no markup', () =>
    {
        const src = 'const a = 1 + 2;';
        expect(compile(src).code).toBe(src);
    });

    it('does NOT re-inject h when already imported', () =>
    {
        const src = 'import { h } from \'@azerothjs/core\';\nconst x = <div/>;';
        expect(compile(src).code.match(/import \{ h \}/g)?.length).toBe(1);
    });

    it('wraps a dynamic text hole as a reactive getter', () =>
    {
        expect(body('const x = <h1>Count: {count()}</h1>;'))
            .toContain('h(\'h1\', {  }, \'Count: \', () => (count()))');
    });

    it('nests elements', () =>
    {
        expect(body('const x = <div><span>a</span></div>;'))
            .toContain('h(\'div\', {  }, h(\'span\', {  }, \'a\'))');
    });

    it('supports self-closing and fragments', () =>
    {
        expect(body('const x = <br/>;')).toContain('h(\'br\', {  })');
        expect(body('const x = <><a/><b/></>;')).toContain('[h(\'a\', {  }), h(\'b\', {  })]');
    });
});

describe('compile() - attributes & events', () =>
{
    it('keeps static string attributes as literals', () =>
    {
        expect(body('const x = <a href="/x" class="link">y</a>;'))
            .toContain('h(\'a\', { href: \'/x\', class: \'link\' }, \'y\')');
    });

    it('wraps a dynamic attribute expression as a getter', () =>
    {
        expect(body('const x = <a href={url()}>y</a>;')).toContain('href: () => (url())');
    });

    it('passes event handlers through verbatim', () =>
    {
        expect(body('const x = <button onClick={inc}>+</button>;')).toContain('onClick: inc');
        expect(body('const x = <button onClick={() => inc()}>+</button>;'))
            .toContain('onClick: () => inc()');
    });

    it('passes a bare-identifier attribute through (e.g. a signal getter)', () =>
    {
        expect(body('const x = <input value={draft}/>;')).toContain('value: draft');
    });

    it('renders a boolean (bare) attribute as true', () =>
    {
        expect(body('const x = <button disabled>x</button>;')).toContain('disabled: true');
    });

    it('handles attribute spread', () =>
    {
        expect(body('const x = <input {...rest}/>;')).toContain('...rest');
    });
});

describe('compile() - JS in markup', () =>
{
    it('compiles a .map() list with nested markup', () =>
    {
        const out = body('const x = <ul>{items().map(i => <li>{i.name}</li>)}</ul>;');
        // `i.name` is a bare reference, passed through (static per item);
        // the whole .map() hole is wrapped so the list stays reactive.
        expect(out).toContain('h(\'li\', {  }, i.name)');
        expect(out).toContain('() => (items().map(i => h(\'li\'');
    });

    it('compiles a && short-circuit with nested markup', () =>
    {
        const out = body('const x = <div>{ok() && <p>yes</p>}</div>;');
        expect(out).toContain('() => (ok() && h(\'p\', {  }, \'yes\'))');
    });
});

describe('compile() - components', () =>
{
    it('compiles a capitalized tag to a component call', () =>
    {
        expect(body('const x = <Counter start={0}/>;')).toContain('Counter({ start: () => (0) })');
    });

    it('passes a function-as-child as the children render function', () =>
    {
        const out = body('const x = <For each={items()}>{(item) => <li>{item}</li>}</For>;');
        expect(out).toContain('children: (item) => h(\'li\', {  }, item)');
        expect(out).toContain('each: () => (items())');
    });

    it('passes element children as a thunk', () =>
    {
        const out = body('const x = <Show when={ok()}><p>hi</p></Show>;');
        expect(out).toContain('when: () => (ok())');
        expect(out).toContain('children: () => h(\'p\', {  }, \'hi\')');
    });
});

describe('compile() - built-in control flow & auto-import', () =>
{
    it('auto-imports built-in components used in markup', () =>
    {
        const out = body('const x = <Show when={a()}><p>hi</p></Show>;');
        expect(out).toMatch(/^import \{ h, Show \} from '@azerothjs\/core';/);
    });

    it('does NOT auto-import user components', () =>
    {
        const out = body('const x = <Counter start={0}/>;');
        // Only h is injected; Counter is the user's to import.
        expect(out).toMatch(/^import \{ h \} from/);
        expect(out).not.toMatch(/import \{[^}]*Counter/);
    });

    it('does NOT re-import an already-imported built-in', () =>
    {
        const src = 'import { Show } from \'@azerothjs/core\';\nconst x = <Show when={a()}><p/></Show>;';
        const out = compile(src).code;
        // The injected line imports only h (Show already imported).
        expect(out).toMatch(/^import \{ h \} from/);
    });

    it('Show: when -> getter, fallback -> thunk, children -> thunk', () =>
    {
        const out = body('const x = <Show when={n() > 1} fallback={<i>f</i>}>{<b>y</b>}</Show>;');
        expect(out).toContain('when: () => (n() > 1)');
        expect(out).toContain('fallback: () => (h(\'i\'');
        expect(out).toContain('children: () =>');
    });

    it('For: each -> getter, key -> as-is, function child -> children fn', () =>
    {
        const out = body('const x = <For each={items()} key={k}>{(i) => <li>{i}</li>}</For>;');
        expect(out).toContain('each: () => (items())');
        expect(out).toContain('key: k');
        expect(out).toContain('children: (i) => h(\'li\'');
    });

    it('Switch: children is a thunk returning the Match cases', () =>
    {
        const out = body('const x = <Switch><Match when={a()}><p>A</p></Match><Match when={b()}><p>B</p></Match></Switch>;');
        expect(out).toContain('children: () => [Match(');
        expect(out).toContain('Match({ when: () => (a())');
    });

    it('Suspense: an array prop (on) is NOT wrapped as a getter', () =>
    {
        const out = body('const x = <Suspense on={[r]} fallback={<i/>}>{<p/>}</Suspense>;');
        expect(out).toContain('on: [r]');
        expect(out).not.toContain('on: () => [r]');
    });
});

describe('findMarkupStart - does not mistake operators for markup', () =>
{
    it('leaves a less-than comparison untouched', () =>
    {
        const src = 'const a = x < y && y > z;';
        expect(compile(src).code).toBe(src);
        expect(findMarkupStart(src, 0)).toBe(-1);
    });

    it('ignores < inside strings, templates, and comments', () =>
    {
        expect(findMarkupStart('const s = "<div>";', 0)).toBe(-1);
        expect(findMarkupStart('const s = `a <b> c`;', 0)).toBe(-1);
        expect(findMarkupStart('// <div> in a comment', 0)).toBe(-1);
        expect(findMarkupStart('/* <div> */', 0)).toBe(-1);
    });

    it('finds markup in expression position (after return / =)', () =>
    {
        expect(findMarkupStart('return <div/>;', 0)).toBeGreaterThan(-1);
        expect(findMarkupStart('const x = <div/>;', 0)).toBeGreaterThan(-1);
    });
});

describe('compile() - source maps', () =>
{
    it('encodes VLQ values correctly', () =>
    {
        expect(vlqEncode(0)).toBe('A');
        expect(vlqEncode(1)).toBe('C');
        expect(vlqEncode(-1)).toBe('D');
        expect(vlqEncode(16)).toBe('gB');
    });

    it('returns a null map when there is no markup', () =>
    {
        expect(compile('const a = 1;').map).toBeNull();
    });

    it('produces a v3 map referencing the source file', () =>
    {
        const r = compile('const x = <div>hi</div>;', 'Foo.azeroth');
        expect(r.map).not.toBeNull();
        expect(r.map!.version).toBe(3);
        expect(r.map!.sources).toEqual(['Foo.azeroth']);
        expect(r.map!.sourcesContent[0]).toContain('<div>');
        expect(r.map!.mappings.length).toBeGreaterThan(0);
    });

    it('emits one mapping group per output line', () =>
    {
        const src = 'const a = 1;\nconst x = <div/>;\nconst b = 2;';
        const r = compile(src);
        const outputLines = r.code.split('\n').length;
        const mappingGroups = r.map!.mappings.split(';').length;
        expect(mappingGroups).toBe(outputLines);
    });
});

describe('compile() - example .azeroth files', () =>
{
    for (const name of ['Showcase'])
    {
        it(`compiles examples/${ name }.azeroth with no residual markup`, () =>
        {
            const src = readFileSync(`packages/compiler/examples/${ name }.azeroth`, 'utf8');
            const out = compile(src).code;

            // Produced real h() calls...
            expect(out).toContain('h(\'');
            // ...and the non-markup script (imports, types) survived.
            expect(out).toContain('@azerothjs/core');
            // ...and no uncompiled `return ( <` markup remains.
            expect(/return\s*\(\s*</.test(out)).toBe(false);
        });
    }
});
