// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createEffect, createRoot, createSignal } from 'azerothjs';
import { diagnoseModule, findMarkupStart, generateVirtualCode, parseModule, skipBalanced } from '@azerothjs/compiler';
import { findConstructs, splitTopLevelCommas } from '../src/lower-reactive.ts';
import { compileComponent } from './conformance/executor.ts';

describe('TypeScript lexical context at markup boundaries', () =>
{
    const operands = [
        ['non-null assertion', 'props.n! / 2', '6'],
        ['postfix increment', 'props.n++ / 2', '6'],
        ['postfix decrement', 'props.n-- / 2', '6'],
        ['operator-named member', 'props.in / 2', '6'],
        ['optional member', 'props?.of / 2', '6'],
        ['contextual name', 'of / 2', '6'],
        ['astral identifier', '𐐀in / 2', '6'],
        ['Unicode space', 'props.n!\u00a0/ 2', '6'],
        ['ordinary division', '(props.n) / 2', '6'],
        ['template substitution', '`qty ${props.n! / 2}`', 'qty 6']
    ];

    it.each(operands)('keeps the closing brace after %s', (_label, expression, value) =>
    {
        const component = (surface: string): string =>
            `component App(props) { const of = 12; const 𐐀in = 12; ${ surface } }`;
        const hole = component(`<p>{${ expression }}</p>`);
        const attribute = component(`<p title={${ expression }}/> `);
        expect(skipBalanced(`{${ expression }} tail`, 0)).toBe(expression.length + 2);
        for (const source of [hole, attribute])
        {
            expect(diagnoseModule(source).filter(d => d.severity === 'error')).toEqual([]);
            expect(generateVirtualCode(source).code).toContain('App');
            for (const ssr of [true, false])
            {
                const app = compileComponent(source, 'App', { ssr }, true);
                const el = app({ n: 12, in: 12, of: 12 }) as HTMLElement;
                expect(source === hole ? el.textContent : el.title).toBe(value);
            }
        }
    });

    it.each([
        'const result = 1 <<o.p;',
        'const result = x-- <o.p;',
        'const result = obj.in <o.p;',
        'const result = 1..in <o.p;',
        'const result = 1. .in <o.p;',
        'const result = /one/ <o.p;',
        'const result = {} <o.p;',
        'if (enabled) /<widget>/.test(s);',
        'const args = [.../<widget>/.exec(s)];',
        'function go() { throw /<widget>/; }',
        'const result = obj.if(true) / 2;'
    ])('finds only the authored output after %s', before =>
    {
        const source = before + ' return <output/>';
        expect(findMarkupStart(source, 0)).toBe(source.indexOf('<output'));
    });

    it.each(['if (true) {} else {}', '{}', 'try {} finally {}'])('keeps a component following a statement block %s', block =>
    {
        const source = `component First { ${ block } <p>it's OK</p> } component Second { <output/> }`;
        expect(parseModule(source).items.flatMap(item => item.kind === 'component' ? [item.name] : [])).toEqual(['First', 'Second']);
        expect(generateVirtualCode(source).code).toContain('function Second');
        expect((compileComponent(source, 'First')() as Element).textContent).toBe("it's OK");
    });

    it('keeps a later component after an HTML-style void element and valid division', () =>
    {
        const source = `component First { <input disabled> }
            function read(width: number) {
                let matched: boolean
                /[)}]/.test('x');
                return width! / 2;
            }
            component Second { <p>{read(12)}</p> }`;
        expect(parseModule(source).items.flatMap(item => item.kind === 'component' ? [item.name] : [])).toEqual(['First', 'Second']);
        expect((compileComponent(source, 'Second', {}, true)() as Element).textContent).toBe('6');
    });

    it('recognizes a regex after a private-field brand check', () =>
    {
        const source = 'class C { #field=0; check(){ if (#field in /[}]/) {} } } component App { <p/> }';
        expect(parseModule(source).items.flatMap(item => item.kind === 'component' ? [item.name] : [])).toEqual(['App']);
        expect(generateVirtualCode(source).code).toContain('function App');
    });

    it.each(['outer: {}', '0\nouter: {}', 'const k = 4\nouter: {}', 'class Shelf<T> {}'])(
        'reads a prefix bang after %s and a postfix bang after an object', block =>
        {
            const source = `component App() {
            const run = () => { ${ block }! /[^/]+/.test('parcel'); };
            const amount = { valueOf() { return 12; } }! / 2;
            <button onClick={run}>{amount}</button>
        }`;
            const app = compileComponent(source, 'App', {}, true);
            expect((app() as Element).textContent).toBe('6');
            expect(generateVirtualCode(source).code).toContain('button');
        });

    it.each(['<p/>', '<input disabled>', '<input disabled> || value', '0'])('keeps the declaration list after initializer %s', initializer =>
    {
        const source = `function check(){ let a = ${ initializer }, b: boolean\n/[}]/.test("");
            label: { batch\n{ go(); } } } component App { <p/> }`;
        expect(parseModule(source).items.some(item => item.kind === 'component' && item.name === 'App')).toBe(true);
        expect(generateVirtualCode(source).code).not.toMatch(/\bbatch\s*\{/);
    });

    it.each(['width as Box<string, number>', 'width satisfies Box<string, number>', '<input disabled> as Box<string, number>'])(
        'keeps division after the generic expression %s', cast =>
        {
            const source = `function f(){ const n = ${ cast } / 2 + "km/h".length;
                label: { batch\n{ go(); } } } component App { <p/> }`;
            expect(parseModule(source).items.some(item => item.kind === 'component' && item.name === 'App')).toBe(true);
            expect(generateVirtualCode(source).code).not.toMatch(/\bbatch\s*\{/);
        });

    it('splits dependencies without splitting regexes, templates or nested calls', () =>
    {
        const first = '(() => { if (yes) /[),]/.test(text); })()';
        const second = '`value ${n! / 2}`';
        expect(splitTopLevelCommas(`${ first }, ${ second }, props.in / 2`)).toEqual([first, second, 'props.in / 2']);
    });

    it('keeps braces and commas inside a regex in a template substitution', () =>
    {
        const expression = "`size ${[.../[},]/.exec(',')!].length}`";
        const source = `component App { <p title={${ expression }}/> }`;
        const app = compileComponent(source, 'App', {}, true);
        expect((app() as HTMLElement).title).toBe('size 1');
    });

    it('treats a bare object at the beginning of a markup hole as an operand', () =>
    {
        const hole = '{ {} / 2 + "km/h".length }';
        expect(skipBalanced(hole + ' tail', 0)).toBe(hole.length);
        const source = 'component App(props) { <p>{{} <props.value ? "lt" : "ge"}</p> }';
        expect((compileComponent(source, 'App')({ value: 3 }) as Element).textContent).toBe('ge');
    });

    it('lowers module markup following a standalone block and a regex statement', () =>
    {
        const source = '{ const q = 1; } /[\']/g.test("x"); const badge = <p>HI</p>; component App { <div>{badge}</div> }';
        expect(generateVirtualCode(source).code).not.toContain('<p>HI</p>');
        expect((compileComponent(source, 'App')() as Element).textContent).toBe('HI');
    });

    it('divides a markup result and lowers the next markup in the same module', () =>
    {
        const source = 'function Measure(){return 12;} const half = <Measure/> / 2; const badge = <b>{half}</b>; component App { <div>{badge}</div> }';
        expect(generateVirtualCode(source).code).not.toContain('<b>{half}</b>');
        expect((compileComponent(source, 'App')() as Element).textContent).toBe('6');
    });

    it('keeps a comparison after markup inside an object-valued declaration', () =>
    {
        const source = `function Count(){ return 2; }
            component App(props) {
                const limit = 4;
                derived d = { a: {} <props.value ? <Count/><limit > 0 : false };
                <p>{String(d.a)}</p>
            }`;
        const app = compileComponent(source, 'App');
        expect((app({ value: 3 }) as Element).textContent).toBe('false');
        expect((app({ value: 'z' }) as Element).textContent).toBe('true');
    });

    it.each(['section', 'Panel'])('maps the entire %s spread when regex or comment text contains a brace', tag =>
    {
        for (const expression of ['(/[}]/.test("x") ? { id: "yes" } : {})', '(/*}*/ { id: "yes" })'])
        {
            const source = `component App { <${ tag } {...${ expression }}/> }`;
            const { code, mapping } = generateVirtualCode(source);
            expect(code).toContain(expression);
            const original = source.indexOf('"yes"');
            const generated = mapping.toGenerated(original);
            expect(generated).not.toBeNull();
            expect(mapping.toOriginal(generated!)).toBe(original);
        }
    });
});

describe('framework statements after lexical ambiguities', () =>
{
    it.each([' ', '\n'])('batches both writes with the authored brace separator %j', separator =>
    {
        const source = `function other() { batch { } }
            component App(props) {
                <button onClick={() => {
                    let matched: boolean
                    /class Foo/.test('class Foo')
                    outer: { batch${ separator }{ props.write(1); props.write(2); } }
                }}>Update</button>
            }`;
        expect(diagnoseModule(source).filter(d => d.severity === 'error')).toEqual([]);
        expect(generateVirtualCode(source).code).not.toMatch(/\bbatch\s*\{/);
        for (const ssr of [true, false])
        {
            const app = compileComponent(source, 'App', { ssr }, true);
            createRoot(dispose =>
            {
                const host = document.body.appendChild(document.createElement('div'));
                try
                {
                    const [read, write] = createSignal(0);
                    const seen: number[] = [];
                    createEffect(() =>
                    {
                        seen.push(read());
                    });
                    host.appendChild(app({ write }) as HTMLButtonElement).click();
                    expect(seen).toEqual([0, 2]);
                }
                finally
                {
                    host.remove();
                    dispose();
                }
            });
        }
    });

    it.each([
        'let a: boolean\n/[)}]/.test("}")',
        'type Row = number\n/class Word/.test("x")',
        'const n = width as Box<number> / 2 + "km/h".length',
        'const n = width satisfies NS.Box<Box<number>> / 2 + "km/h".length',
        'const n = value > /class Ghost/.test(text)',
        'const n = value\n/2/g',
        'const n = /re// 2 / 3',
        'if (ok) /[}]/.test(text);',
        'const n = obj.if(ok) / 2 / g',
        'const n = { valueOf() {return 12;} } / 2'
    ])('keeps a real nested statement after %s', prefix =>
    {
        const code = `function f(){ ${ prefix }; label: { batch\n{ sink(); } } }`;
        const items = findConstructs(code);
        expect(items.map(item => [item.kind, item.start])).toEqual([['wrapper', code.indexOf('batch')]]);
    });

    it.each([
        'function f(batch) { batch;\n{ side(); } }',
        'function f(batch) { if (ok) batch\n{ side(); } }',
        'function f(batch) { let n = value\nbatch\n{ side(); } }',
        'const obj = { effect(x) { return x; }, batch: 2 };',
        'class C { effect(x) { return x; } }',
        "const v = <p>it's</p>; class A {\neffect(v)\n{ return v; } }",
        'const text = "batch { side() }"; const re = /effect[{}]/;'
    ])('preserves ordinary TypeScript in %s', code =>
    {
        expect(findConstructs(code)).toEqual([]);
    });

    it('recognizes a real statement even when a contextual type name resembles an operator', () =>
    {
        const code = '(() => { type await = number; let v: await\n{ batch\n{ go(); } } })()';
        expect(findConstructs(code).map(item => item.start)).toEqual([code.indexOf('batch')]);
    });

    it.each(['debugger', 'break', 'continue', 'break outer', 'continue outer'])('starts a regex after %s', statement =>
    {
        const code = `function f(){ outer: while(ok){ ; ${ statement }\n/[}]/.test(""); label: { batch\n{ go(); } } } }`;
        expect(findConstructs(code).map(item => item.start)).toEqual([code.indexOf('batch')]);
        expect(generateVirtualCode(code).code).not.toMatch(/\bbatch\s*\{/);
    });

    it.each(['\r', '\r\n', '\u2028', '\u2029'])('retains the regex and keyword across JS line terminator %j', newline =>
    {
        const code = `function f(){ let ok: boolean${ newline }/[}]/.test(""); {${ newline }batch\n{ go(); } } } component App { <p/> }`;
        expect(parseModule(code).items.some(item => item.kind === 'component' && item.name === 'App')).toBe(true);
        expect(generateVirtualCode(code).code).not.toMatch(/\bbatch\s*\{/);
    });

    it('preserves an ordinary method after a long arithmetic expression', () =>
    {
        const code = `function f() { const n = 0${ '+1'.repeat(8000) }; const obj = {effect(){return n;}}; }`;
        expect(findConstructs(code)).toEqual([]);
    });

    it('finds the watch body and leaves its dependency and options expressions intact', () =>
    {
        const code = 'function run(){ effect ((() => { batch\n{ read(); } return dep; })()) '
            + "with {name: (() => { batch\n{ read(); } return 'probe'; })()} { batch\n{ go(); } } }";
        expect(findConstructs(code).map(item => [item.kind, item.start])).toEqual([
            ['watch', code.indexOf('effect')],
            ['wrapper', code.lastIndexOf('batch')]
        ]);
    });

    it.each([
        ['watch', 'effect (value)'],
        ['wrapper', 'untrack'],
        ['wrapper', 'cleanup'],
        ['state', 'state\nnext = 1;']
    ])('admits the %s form %s after a regex statement', (kind, header) =>
    {
        for (const separator of [' ', '\n'])
        {
            const statement = kind === 'state' ? header : header + separator + '{ read(); }';
            const code = `function f(){ let matched: boolean\n/class Word/.test(text)\n{ ${ statement } } }`;
            expect(findConstructs(code).map(item => [item.kind, item.start])).toEqual([[kind, code.indexOf(header)]]);
        }
    });
});
