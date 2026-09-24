// @vitest-environment happy-dom
//
// The child of <For>, <Transition> or <Portal> written with text beside it on the same line.
// Spaces there are dropped; any other text beside a host element is refused.
import { describe, it, expect, vi } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import { diagnoseModule } from '../src/diagnostics.ts';
import * as runtime from 'azerothjs/internal';
import { render, hydrate, renderToString, type Child } from 'azerothjs';

interface Row { id: number; n: string }

const hook: { set?: (v: Row[]) => void; on?: (v: boolean) => void } = {};

const K = 'key={ (r) => r.id }';
const NL = '\n            ';

const LIST: Array<() => void> = [
    () => hook.set?.([{ id: 2, n: 'b' }, { id: 1, n: 'a' }]),
    () => hook.set?.([{ id: 2, n: 'b' }, { id: 1, n: 'a' }, { id: 3, n: 'c' }]),
    () => hook.set?.([{ id: 3, n: 'c' }])
];
const TOGGLE: Array<() => void> = [() => hook.on?.(false), () => hook.on?.(true)];

function moduleSource(markup: string, head = '', tail = ''): string
{
    return `${ head }export default component P() {
    state list = [{ id: 1, n: 'a' }, { id: 2, n: 'b' }];
    state on = true;
    hook.set = (v) => { list = v; };
    hook.on = (v) => { on = v; };
    <div>${ markup }</div>
}${ tail }`;
}

/** The compiled module's component, with `bound` supplying the names the module imports. */
function compile(src: string, options: { ssr?: boolean } = {}, bound: Record<string, unknown> = {}): () => HTMLElement
{
    const body = generateModule(src, 'T.azeroth', options).code
        .replace(/^import[^;]+;[ \t]*\r?\n?/gm, '')
        .replace(/^export\s+default\s+function/gm, 'function');
    const values: Record<string, unknown> = { ...runtime, ...bound };
    const keys = Object.keys(values);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the compiled output
    const factory = new Function(...keys, 'hook', `${ body }\nreturn P;`) as (...args: unknown[]) => () => HTMLElement;
    return factory(...keys.map((k) => values[k]), hook);
}

const plain = (html: string): string => html.replace(/<!--[^>]*-->/g, '');

/** The markup after mount and after each write, in one mode. */
function sequence(markup: string, steps: Array<() => void>, mode: 'render' | 'client-only' | 'hydrate'): string
{
    const container = document.createElement('div');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try
    {
        const P = compile(moduleSource(markup), mode === 'client-only' ? { ssr: false } : {});
        if (mode === 'hydrate')
        {
            container.innerHTML = renderToString(() => P());
            hydrate(() => P(), container);
        }
        else
        {
            render(() => P(), container);
        }
        const seq = [plain(container.innerHTML)];
        for (const step of steps)
        {
            step();
            seq.push(plain(container.innerHTML));
        }
        expect(warn.mock.calls).toEqual([]);
        return seq.join(' > ');
    }
    finally
    {
        warn.mockRestore();
    }
}

/** Every mode of a whole module, the page body included, with any throw or console warning. */
function lanes(src: string, steps: Array<() => void>, bound: Record<string, unknown> = {}): Record<string, string>
{
    const out: Record<string, string> = {};
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const snap = (c: HTMLElement): string => plain(c.innerHTML) + (document.body.innerHTML === '' ? '' : ` + ${ plain(document.body.innerHTML) }`);
    const run = (mode: string, mount: (c: HTMLElement) => void, writes = steps): void =>
    {
        document.body.innerHTML = '';
        const c = document.createElement('div');
        const seq: string[] = [];
        try
        {
            mount(c);
            seq.push(snap(c));
            for (const step of writes)
            {
                step();
                seq.push(snap(c));
            }
        }
        catch (e)
        {
            seq.push(`THROW ${ (e as Error).message }`);
        }
        out[mode] = seq.join(' > ');
    };
    try
    {
        run('render', (c) => render(() => compile(src, {}, bound)(), c));
        run('client-only', (c) => render(() => compile(src, { ssr: false }, bound)(), c));
        run('server', (c) =>
        {
            c.innerHTML = renderToString(() => compile(src, {}, bound)());
        }, []);
        run('hydrate', (c) =>
        {
            c.innerHTML = renderToString(() => compile(src, {}, bound)());
            hydrate(() => compile(src, {}, bound)(), c);
        });
        out.warnings = warn.mock.calls.map((call) => String(call[0])).join(' | ');
        return out;
    }
    finally
    {
        warn.mockRestore();
        document.body.innerHTML = '';
    }
}

const list = (...cells: string[]): string => `<div><ul>${ cells.map((c) => `<li>${ c }</li>`).join('') }</ul></div>`;

describe('spaces beside the element of a one-element child', () =>
{
    const unnamed = [list('x', 'x'), list('x', 'x'), list('x', 'x', 'x'), list('x')].join(' > ');
    const named = [list('a', 'b'), list('b', 'a'), list('b', 'a', 'c'), list('c')].join(' > ');
    const cases: Array<[string, string, Array<() => void>, string]> = [
        ['a <For> row with no name', `<ul><For each={ list } ${ K }> <li>x</li> </For></ul>`, LIST, unnamed],
        ['a <For> row after a line break', `<ul><For each={ list } ${ K }>\n    <li>x</li> </For></ul>`, LIST, unnamed],
        ['a <For> row inside a hole', `{ list.length > 0 ? <ul><For each={ list } ${ K }> <li>x</li> </For></ul> : null }`, LIST, unnamed],
        ['a <For> row with let=', `<ul><For each={ list } ${ K } let={ row }>\t<li>{ row.n }</li> </For></ul>`, LIST, named],
        ['a <Transition> child', '<Transition when={ on }> <p>x</p> </Transition>', TOGGLE, '<div><p>x</p></div> > <div></div> > <div><p>x</p></div>']
    ];

    for (const [label, markup, steps, seq] of cases)
    {
        it(`${ label } renders the element alone in every mode, with one warning`, () =>
        {
            const src = moduleSource(markup);
            const found = diagnoseModule(src);
            expect(found.map((d) => [d.code, d.severity])).toEqual([['azeroth/for-row-shape', 'warning']]);
            expect(src.slice(found[0]?.start, found[0]?.end).trim()).toBe('');
            expect(found[0]?.message).toContain('are dropped');
            expect(plain(renderToString(() => compile(src)()))).toBe(seq.split(' > ')[0]);
            expect(sequence(markup, steps, 'render')).toBe(seq);
            expect(sequence(markup, steps, 'client-only')).toBe(seq);
            expect(sequence(markup, steps, 'hydrate')).toBe(seq);
        });
    }

    it('a padded function row renders like the unpadded one, with one warning', () =>
    {
        const markup = `<ul><For each={ list } ${ K }> { () => <li>x</li> } </For></ul>`;
        const src = moduleSource(markup);
        const found = diagnoseModule(src);
        expect(found.map((d) => [d.code, d.severity, src.slice(d.start, d.end)])).toEqual([['azeroth/for-row-shape', 'warning', ' ']]);
        expect(found[0]?.message).toContain('The spaces beside the function in this <For> are dropped');
        expect(sequence(markup, LIST, 'render')).toBe(unnamed);
        expect(sequence(markup, LIST, 'hydrate')).toBe(unnamed);
    });

    it('a line break beside the element is formatting and gets no warning', () =>
    {
        expect(diagnoseModule(moduleSource(`<ul><For each={ list } ${ K }>\n    <li>x</li>\n</For></ul>`))).toEqual([]);
    });
});

describe('spaces beside any child of <Transition> or <Portal>', () =>
{
    const card = 'component Card()\n{\n    <p class="card">c</p>\n}\n\n';
    const cases: Array<[string, string, Array<() => void>]> = [
        ['<Transition when={ on }> <Card /> </Transition>', '<Transition when={ on }><Card /></Transition>', TOGGLE],
        ['<Transition when={ on }>\t{ () => <p>x</p> }\t</Transition>', '<Transition when={ on }>{ () => <p>x</p> }</Transition>', TOGGLE],
        ['<Transition when={ on }> {/* c */} <Card /> {/* c */} </Transition>', '<Transition when={ on }><Card /></Transition>', TOGGLE],
        ['<Portal> <Card /> </Portal>', '<Portal><Card /></Portal>', []],
        ['<Portal> { () => <p>x</p> } </Portal>', '<Portal>{ () => <p>x</p> }</Portal>', []],
        ['<Portal> <Show when={ on }><p>x</p></Show> </Portal>', '<Portal><Show when={ on }><p>x</p></Show></Portal>', TOGGLE]
    ];

    for (const [padded, bare, steps] of cases)
    {
        it(`${ padded } renders like ${ bare } in every mode, with no diagnostic`, () =>
        {
            expect(diagnoseModule(moduleSource(padded, card))).toEqual([]);
            const want = lanes(moduleSource(bare, card), steps);
            expect(want.render).not.toContain('THROW');
            expect(lanes(moduleSource(padded, card), steps)).toEqual(want);
        });
    }
});

describe('other text beside the element of a one-element child', () =>
{
    // [markup, the text the refusal is anchored at, how the message quotes it]
    const cases: Array<[string, string, string]> = [
        [`<ul><For each={ list } ${ K }>&nbsp;<li>x</li></For></ul>`, '&nbsp;', '&nbsp;'],
        [`<ul><For each={ list } ${ K } let={ row }><li>{ row.n }</li>&#32;</For></ul>`, '&#32;', '&#32;'],
        [`<ul><For each={ list } ${ K } let={ row }>\n    &ensp;\n    <li>{ row.n }</li></For></ul>`, '&ensp;', '&ensp;'],
        [`<ul><For each={ list } ${ K } let={ row }>\xa0<li>{ row.n }</li></For></ul>`, '\xa0', 'U+00A0'],
        [`<ul><For each={ list } ${ K }>\u200b<li>x</li></For></ul>`, '\u200b', 'U+200B'],
        [`<ul><For each={ list } ${ K }>x <li>x</li></For></ul>`, 'x', 'x'],
        [`<ul><For each={ list } ${ K }>\u0633\u0644\u0627\u0645 <li>x</li></For></ul>`, '\u0633\u0644\u0627\u0645', '\u0633\u0644\u0627\u0645'],
        [`<ul><For each={ list } ${ K } let={ row }><li>{ row.n }</li> \u{1F600}</For></ul>`, '\u{1F600}', '\u{1F600}'],
        [`<ul><For each={ list } ${ K } let={ row }>caf\u00e9 <li>{ row.n }</li></For></ul>`, 'caf\u00e9', 'caf\u00e9'],
        [`<ul><For each={ list } ${ K } let={ row }>${ NL }&nbsp;${ NL }&nbsp;${ NL }<li>{ row.n }</li>${ NL }</For></ul>`, `&nbsp;${ NL }&nbsp;`, '&nbsp; &nbsp;'],
        ['<Transition when={ on }>&nbsp;<p>x</p></Transition>', '&nbsp;', '&nbsp;'],
        ['<Portal><p>x</p>&emsp;</Portal>', '&emsp;', '&emsp;']
    ];

    for (const [markup, text, quoted] of cases)
    {
        it(`is refused beside <${ /<(For|Transition|Portal)/.exec(markup)?.[1] }>, anchored at the text and quoting ${ JSON.stringify(quoted) }`, () =>
        {
            const src = moduleSource(markup);
            const found = diagnoseModule(src);
            expect(found.map((d) => [d.code, d.severity, src.slice(d.start, d.end)])).toEqual([['azeroth/for-row-shape', 'error', text]]);
            expect(found[0]?.message).toContain(`has text beside its <${ /<For/.test(markup) ? 'li' : 'p' }>: \`${ quoted }\``);
        });
    }

    it('stays linear in a long run of spaces before the text', () =>
    {
        const src = moduleSource(`<ul><For each={ list } ${ K }>${ ' '.repeat(160000) }x<li>x</li></For></ul>`);
        const started = performance.now();
        const found = diagnoseModule(src);
        const elapsed = performance.now() - started;
        expect(found.map((d) => src.slice(d.start, d.end))).toEqual(['x']);
        expect(found[0]?.message).toContain('has text beside its <li>: `x`');
        // A quadratic trim takes about 5 s here; the bound is loose, not a tight fit.
        expect(elapsed).toBeLessThan(1000);
    });
});

describe('spaces between children of <Transition> or <Portal>, or spaces alone', () =>
{
    // [markup, the server render]
    const cases: Array<[string, string]> = [
        ['<Portal><b>a</b> <i>b</i></Portal>', '<div><b>a</b> <i>b</i></div>'],
        ['<Portal> <b>a</b> <i>b</i> </Portal>', '<div> <b>a</b> <i>b</i> </div>'],
        ['<Transition when={ on }>{ \'a\' } { \'b\' }</Transition>', '<div>a b</div>'],
        ['<Portal> </Portal>', '<div> </div>'],
        ['<Transition when={ on }> </Transition>', '<div> </div>']
    ];

    for (const [markup, server] of cases)
    {
        it(`are kept in the server render, with no diagnostic: ${ markup }`, () =>
        {
            const src = moduleSource(markup);
            expect(diagnoseModule(src)).toEqual([]);
            expect(plain(renderToString(() => compile(src)()))).toBe(server);
        });
    }
});

describe('a component the module imports under a builtin name', () =>
{
    const user = (props: { children: Child }): unknown => runtime.h('section', {}, props.children);
    // Reads its children as the list the markup wrote.
    const spread = (props: { children: () => Iterable<Child> }): unknown => runtime.h('section', {}, () => [...props.children()]);
    const ui = (name: string): string => `import { ${ name } } from './ui';\n`;
    const tail = '\nconst tail = () => <Transition when={ true }> <b>x</b> </Transition>;\n';
    // [name, imports, markup, code after the component, the severity the builtin gets, '' for none]
    const cases: Array<[string, string, string, string, 'error' | 'warning' | '']> = [
        ['Portal', ui('Portal'), '<Portal>Note: <b>x</b></Portal>', '', 'error'],
        ['Portal', ui('Portal'), '<Portal>Total: <b>3</b> items</Portal>', '', 'error'],
        ['Transition', ui('Transition'), '<p>Rated:<Transition> <b>*</b> </Transition>(3)</p>', '', 'warning'],
        ['For', ui('For'), `<ul><For each={ list } ${ K }> <li>x</li> </For></ul>`, '', 'warning'],
        ['Transition', ui('Transition'), '{ on && <Transition when={ on }> <b>x</b> </Transition> }', '', 'warning'],
        ['Portal', ui('Portal'), '{ on ? <Portal> <p>p</p> </Portal> : null }', '', 'warning'],
        ['Portal', ui('Portal'), '{ on ? <Portal> { () => <p>{ list.length }</p> } </Portal> : null }', '', ''],
        ['For', ui('For'), `<ul>{ on ? <For each={ list } ${ K }> <li>x</li> </For> : null }</ul>`, '', 'warning'],
        ['Transition', ui('Transition'), '{ tail() }', tail, 'warning'],
        ['Transition', ui('Transition'), '<Show when={ on } fallback={ <Transition when={ true }> <b>f</b> </Transition> }><i>s</i></Show>', '', 'warning'],
        ['Transition', ui('Transition'), '{ list.map((r) => <Transition when={ on }> <b>{ r.n }</b> </Transition>) }', '', 'warning'],
        ['Transition', ui('Transition'), '<p>{ on ? <Transition when={ on }> <b>x</b> </Transition> : null }</p>', '', 'warning'],
        ['Transition', ui('Fade as Transition'), '{ on && <Transition when={ on }> <b>x</b> </Transition> }', '', 'warning'],
        ['Portal', `// import { Portal } from 'azerothjs';\n${ ui('Portal') }`, '<Portal> <p>p</p> </Portal>', '', 'warning'],
        ['Portal', `import { Portal as Builtin } from 'azerothjs';\n${ ui('Portal') }`, '<Portal> <p>p</p> </Portal>', '', 'warning']
    ];

    for (const [name, head, markup, after, severity] of cases)
    {
        it(`keeps its children as written: ${ head.replaceAll('\n', ' ') }${ markup }${ after.replaceAll('\n', ' ') }`, () =>
        {
            const builtin = diagnoseModule(moduleSource(markup, '', after)).filter((d) => d.code === 'azeroth/for-row-shape');
            expect(builtin.map((d) => d.severity).join()).toBe(severity);

            const own = moduleSource(markup, head, after);
            expect(diagnoseModule(own)).toEqual([]);
            const card = moduleSource(markup.replaceAll(name, 'Card'), ui('Card'), after.replaceAll(name, 'Card'));
            for (const component of [user, spread])
            {
                const want = lanes(card, TOGGLE, { Card: component });
                expect(want.render).toContain('<section>');
                expect(lanes(own, TOGGLE, { [name]: component })).toEqual(want);
            }
        });
    }
});

describe('a builtin the module imports from azerothjs', () =>
{
    const row = (pad: string): string => `<ul><For each={ list } ${ K }>${ pad }<li>x</li>${ pad }</For></ul>`;
    // [imports, the padded child, the same child unpadded, writes]
    const cases: Array<[string, string, string, Array<() => void>]> = [
        ['import { For } from \'azerothjs\';\n', row(' '), row(''), LIST],
        ['// import { Portal } from \'./my-portal\';\nimport { Portal } from \'azerothjs\';\n', '<Portal> <p>x</p> </Portal>', '<Portal><p>x</p></Portal>', []],
        ['import { For } from \'azerothjs\';\nconst doc = "import { For } from \'./my-for\'";\n', row(' '), row(''), LIST],
        ['/* import { Transition } from \'./fade\'; */\nimport { Transition } from \'azerothjs\';\n', '<Transition when={ on }> <p>x</p> </Transition>', '<Transition when={ on }><p>x</p></Transition>', TOGGLE],
        ['import { Portal } from \'azerothjs\';\nimport { Portal as Modal } from \'./ui\';\n', '<Portal> <p>x</p> </Portal>', '<Portal><p>x</p></Portal>', []]
    ];

    for (const [head, padded, bare, steps] of cases)
    {
        it(`drops the spaces with one warning: ${ head.replaceAll('\n', ' ') }${ padded }`, () =>
        {
            const src = moduleSource(padded, head);
            expect(diagnoseModule(src).map((d) => [d.code, d.severity])).toEqual([['azeroth/for-row-shape', 'warning']]);
            const want = lanes(moduleSource(bare), steps);
            expect(want.render).not.toContain('THROW');
            expect(lanes(src, steps)).toEqual(want);
        });
    }
});
