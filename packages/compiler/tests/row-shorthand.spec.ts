// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createSignal, hydrate, render, renderToString } from 'azerothjs';
import { generateModule } from '../src/codegen.ts';
import { compileComponent } from './conformance/executor.ts';

const emits = [
    { mode: 'client', options: { ssr: false } },
    { mode: 'universal', options: { ssr: true } },
    { mode: 'development', options: { dev: true } }
];

const bindings = [
    { kind: 'For item', open: '<For each={items} key={x => x} let={row}>', close: '</For>' },
    { kind: 'For index', open: '<For each={items} key={x => x} let={value} index={row}>', close: '</For>' },
    { kind: 'For index alone', open: '<For each={items} key={x => x} index={row}>', close: '</For>' },
    { kind: 'Show value', open: '<Show when={items} let={row}>', close: '</Show>' },
    { kind: 'Match value', open: '<Switch><Match when={items} let={row}>', close: '</Match></Switch>' },
    { kind: 'array-form row', open: '<For each={lines.rows()} key={v => v.key} let={row}>', close: '</For>' }
];

// The same outer row flows through each expression writer, including detached markup and raw callbacks.
const writers = [
    ['text', '<i>{ text(VALUE) }</i>'],
    ['attr', '<i title={ attr(VALUE) }/>'],
    ['event', '<button onClick={ () => event(VALUE) }/>'],
    ['ref', '<i ref={ el => ref(VALUE, el) }/>'],
    ['klass', '<i class:active={ klass(VALUE) }/>'],
    ['color', '<i style:color={ color(VALUE) }/>'],
    ['spread', '<i {...spread(VALUE)}/>'],
    ['child', '<Child value={ child(VALUE) }/>'],
    ['list', '<For each={ list(VALUE) } key={x => x} let={v}><span>{v}</span></For>'],
    ['condition', '<Show when={ condition(VALUE) }><span/></Show>'],
    ['branch', '<Show when={true}>{ () => <i title={ branch(VALUE) }/> }</Show>'],
    ['raw', '<Show when={false} fallback={<div><For each={[1]} key={x => x} let={row}><i>{ raw(VALUE) }</i></For></div>}><b/></Show>'],
    ['boundary', '<ErrorBoundary fallback={ () => <i>{ boundary(VALUE) }</i> }><b/></ErrorBoundary>']
] as const;

const writerBody = writers.map(([, markup]) => markup).join('\n');

describe.each(emits)('object shorthand in $mode compiler output', ({ options }) =>
{
    it.each(bindings)('matches the spelled properties for every writer under $kind', ({ open, close }) =>
    {
        const source = `component Probe() { form lines[] = { qty: 1 }; const items = ['first'];
            ${ open }<article>${ writerBody }</article>${ close } }`;
        const spelled = generateModule(source.replaceAll('VALUE', '{ row: row }'), undefined, options).code;
        const short = generateModule(source.replaceAll('VALUE', '{ row }'), undefined, options).code;
        for (const [writer] of writers)
        {
            expect(spelled).toContain(`${ writer }({ row: row() }`);
        }
        expect(short).toBe(spelled);
        expect(short).not.toContain('__azRow(');
    });

    it.each(['module', 'component'])('expands a shorthand in a %s helper that returns markup', owner =>
    {
        const helper = `function labels(items) { return <For each={items} key={x => x} let={row}>
            <i>{ label(VALUE) }</i></For>; }`;
        const source = owner === 'module' ? helper : `component Probe() { ${ helper } <b>{labels(['a'])}</b> }`;
        const gen = (arg: string): string => generateModule(source.replace('VALUE', arg), undefined, options).code;
        const control = gen('{ row: row }');
        expect(control).toContain('label({ row: row() })');
        expect(gen('{ row }')).toBe(control);
    });

    it('retains an escaped identifier spelling and adjacent trivia', () =>
    {
        const source = String.raw`component Probe() { <Show when={1} let={row}><i>{
            label({ /* before */ r\u006fw /* after */ }) }</i></Show> }`;
        const control = source.replace(String.raw`r\u006fw /*`, String.raw`r\u006fw: r\u006fw /*`);
        const spelled = generateModule(control, undefined, options).code;
        expect(spelled).toContain(String.raw`/* before */ r\u006fw: r\u006fw() /* after */`);
        expect(generateModule(source, undefined, options).code).toBe(spelled);
    });

    it('preserves shorthand for ordinary locals, and expands state, derived, deferred and alias reads', () =>
    {
        const source = `component Probe({ value: alias }) { state count = 1; derived twice = count * 2; deferred later = count;
            <Show when={count} let={row}><b>{ capture({ count, twice, later, alias, row },
                ['inner'].map(row => ({ row }))) }</b></Show> }`;
        const spelled = source.replace('{ count, twice, later, alias, row }',
            '{ count: count, twice: twice, later: later, alias: alias, row: row }');
        const control = generateModule(spelled, undefined, options).code;
        expect(control).toContain("['inner'].map(row => ({ row }))");
        expect(control).toContain('count: count(), twice: twice(), later: later(), alias: props.value, row: row()');
        expect(generateModule(source, undefined, options).code).toBe(control);
    });
});

const containers: HTMLElement[] = [];
afterEach(() =>
{
    for (const root of containers.splice(0))
    {
        render(() => document.createElement('div'), root);
        root.remove();
    }
});

describe.each(['client', 'universal', 'hydrate'])('shorthand at runtime in %s', mode =>
{
    function mount(source: string, props: Record<string, unknown> = {}): HTMLElement
    {
        const Probe = compileComponent(source, 'Probe', { ssr: mode !== 'client' });
        const app = (): HTMLElement => Probe(props) as HTMLElement;
        const root = document.createElement('main');
        containers.push(root);
        document.body.appendChild(root);
        if (mode === 'hydrate')
        {
            root.innerHTML = renderToString(app);
            const served = root.querySelector('button');
            expect(served).not.toBeNull();
            hydrate(app, root);
            expect(root.querySelector('button')).toBe(served);
        }
        else
        {
            render(app, root);
        }
        return root;
    }

    it.each(['short', 'spelled'])('updates an item and index captured in %s properties after a keyed reorder', form =>
    {
        const bag = form === 'short' ? '{ row, index }' : '{ row: row, index: index }';
        const source = `component Probe(props) { <For each={props.rows} key={r => r.id} let={row} index={index}>
            <button title={ props.label(${ bag }) } onClick={ () => props.save(${ bag }) }>
                { props.label(${ bag }) }/{ ['local'].map(row => ({ row }).row).join('') }</button></For> }`;
        const [rows, setRows] = createSignal([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
        const receipts: string[] = [];
        const label = ({ row, index }: { row: { name: string }; index: number }): string => `${ row.name }/${ index }`;
        const root = mount(source, {
            get rows()
            {
                return rows();
            },
            label,
            save: (bag: Parameters<typeof label>[0]) => receipts.push(label(bag))
        });
        const button = root.querySelector('button')!;
        expect([button.title, button.textContent]).toEqual(['A/0', 'A/0/local']);
        button.click();
        setRows([{ id: 2, name: 'B' }, { id: 1, name: 'C' }]);
        expect(root.querySelectorAll('button')[1]).toBe(button);
        expect([button.title, button.textContent]).toEqual(['C/1', 'C/1/local']);
        button.click();
        expect(receipts).toEqual(['A/0', 'C/1']);
    });

    it.each(bindings)('renders the same writer output and event values for both spellings under $kind', binding =>
    {
        const source = `const text = ({ row }) => row?.form ? 'quantity=' + row.form.values().qty : String(row);
            const attr = text, child = text, branch = text, raw = text, boundary = text;
            const klass = bag => text(bag).length > 0, color = bag => text(bag).length ? 'red' : 'blue';
            const spread = bag => ({ 'data-value': text(bag) }), list = bag => [text(bag)];
            const condition = bag => text(bag).length > 0;
            const ref = (bag, element) => { element.dataset.bound = text(bag); };
            component Child(props) { <strong>{ props.value }</strong> }
            component Probe(props) { form lines[] = { qty: 1 }; lines.append(); const items = ['first'];
                const event = bag => props.report(text(bag));
                ${ binding.open }<article>${ writerBody }</article>${ binding.close } }`;
        const output = (value: string): { html: string; ssr: string; events: string[] } =>
        {
            const code = source.replaceAll('VALUE', value);
            const events: string[] = [];
            const root = mount(code, { report: (label: string) => events.push(label) });
            const expected = binding.kind.includes('index') ? '0' : binding.kind === 'array-form row' ? 'quantity=1' : 'first';
            expect(root.querySelector('article > i')?.textContent).toBe(expected);
            root.querySelector('button')!.click();
            expect(events).toEqual([expected]);
            const Probe = compileComponent(code, 'Probe');
            const ssr = renderToString(() => Probe({}) as HTMLElement);
            expect(ssr).toContain(expected);
            return { html: root.innerHTML, ssr, events };
        };
        const control = output('{ row: row }');
        expect(output('{ row }')).toEqual(control);
    });

    it('preserves the record and its field-write behavior in an array-form row', () =>
    {
        const root = mount(`component Probe() { form lines[] = { qty: 1 }; lines.append();
            <For each={lines.rows()} key={x => x.key} let={row}>
                <button onClick={ () => { row.qty += 2 } }>{ ({ row }).row.form.values().qty }/{row.qty}</button>
            </For> }`);
        const button = root.querySelector('button')!;
        expect(button.textContent).toBe('1/1');
        button.click();
        button.click();
        expect(root.querySelector('button')).toBe(button);
        expect(button.textContent).toBe('5/5');
    });

    it('reads a row, state and prop in destructuring assignment defaults for ordinary locals', () =>
    {
        const root = mount(`component Probe({ n: alias }) { state count = 5;
            <Show when={4} let={row}><button>{ (() => {
                let a, b, c; ({ a = row, b = count, c = alias } = {}); return [a,b,c].join('/');
            })() }</button></Show> }`, { n: 6 });
        expect(root.textContent).toBe('4/5/6');
    });

    it.each([
        ['row', 'component Probe() { <Show when={4} let={__proto__}><button>HOLE</button></Show> }'],
        ['state', 'component Probe() { state __proto__ = 4; <button>HOLE</button> }'],
        ['prop alias', 'component Probe({ n: __proto__ }) { <button>HOLE</button> }']
    ])('preserves the own property of a shorthand named __proto__ from a %s', (_name, source) =>
    {
        const hole = String.raw`{ Object.entries({ __pr\u006fto__ }).flat().join('/') }`;
        const root = mount(source.replace('HOLE', hole), { n: 4 });
        expect(root.textContent).toBe('__proto__/4');
    });
});
