// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createSignal, hydrate, render, renderToString } from 'azerothjs';
import { compileComponent } from './conformance/executor.ts';

const modes = ['client', 'universal', 'hydrate'] as const;
const containers: HTMLElement[] = [];

afterEach(() =>
{
    for (const container of containers.splice(0))
    {
        render(() => document.createElement('div'), container);
        container.remove();
    }
});

describe.each(modes)('lexical row bindings in %s', mode =>
{
    const mount = (source: string, props: Record<string, unknown> = {}, typed = false): HTMLElement =>
    {
        const Probe = compileComponent(source, 'Probe', { ssr: mode !== 'client' }, typed);
        const app = (): HTMLElement => Probe(props) as HTMLElement;
        const container = document.createElement('div');
        containers.push(container);
        document.body.appendChild(container);
        if (mode === 'hydrate')
        {
            container.innerHTML = renderToString(app);
            const served = container.querySelector('p');
            hydrate(app, container);
            expect(container.querySelector('p')).toBe(served);
        }
        else
        {
            render(app, container);
        }
        return container;
    };

    it.each([
        ['a plain local', "(() => { const item = 'aisle'; return item.toUpperCase() })()", 'AISLE'],
        ['a destructured local', "(() => { const { value: [item] } = { value: ['seat'] }; return item.toUpperCase() })()", 'SEAT'],
        ['a catch binding', "(() => { try { throw 'desk' } catch (item) { return item.toUpperCase() } })()", 'DESK'],
        ['a catch default capturing a later binding', "(() => { try { throw {} } catch ({ read = () => item, item = 'catch' }) { return read() } })()", 'catch'],
        ['a loop binding', "(() => { for (const item of ['lane']) { return item.toUpperCase() } })()", 'LANE'],
        ['a later loop initializer', "(() => { for (let read = () => item, item = 'loop';;) { return read() } })()", 'loop'],
        ['a for-of head in its temporal dead zone', "(() => { try { for (let item of item) { return 'unexpected' } } catch (error) { return error.name } })()", 'ReferenceError'],
        ['a later local captured by a closure', "(() => { const read = () => item; const item = 'late'; return read() })()", 'late'],
        ['a later function declaration', '(() => { const read = () => typeof item; function item() {} return read() })()', 'function'],
        ['a later case declaration', "(() => { let read; switch (1) { case 1: read = () => item; case 2: const item = 'switch'; return read() } })()", 'switch'],
        ['a function-scoped var', "(() => { const read = () => item; if (true) { var item = 'platform' } return read() })()", 'platform'],
        ['a default outside the var scope', "((value = item.toUpperCase()) => { var item = 'unused'; return value })()", 'OUTER'],
        ['a nested parameter', "['chair'].map(item => item.toUpperCase()).join('')", 'CHAIR'],
        ['a sibling read after the block ends', "(() => { { const item = 'other' } return item })()", 'outer']
    ])('resolves %s and restores the outer getter', (_label, expression, expected) =>
    {
        const source = `component Probe() { <For each={ ['outer'] } key={ x => x } let={ item }>
            <p><i>{ ${ expression } }</i><b>{ item }</b></p>
        </For> }`;
        const root = mount(source);
        expect(root.querySelector('i')?.textContent).toBe(expected);
        expect(root.querySelector('b')?.textContent).toBe('outer');
    });

    it('resolves a closure to a later TypeScript enum in its block', () =>
    {
        const source = `component Probe() { <Show when={ 'outer' } let={ item }><p>{
            (() => { const read = () => item.seat; enum item { seat = 7 } return read() })()
        }</p></Show> }`;
        expect(mount(source, {}, true).textContent).toBe('7');
    });

    it('keeps the keyed row, updates its index and calls the handler with its own local', () =>
    {
        const source = `component Probe(props) { <For each={ props.items } key={ x => x } let={ item } index={ n }>
            <p><button onClick={ () => { const n = () => 'inner'; props.report(typeof n, item) } }>{ n }</button></p>
        </For> }`;
        const [items, setItems] = createSignal(['red', 'blue']);
        const reports: string[][] = [];
        const root = mount(source, { get items()
        {
            return items();
        }, report: (...args: string[]) => reports.push(args) });
        const first = root.querySelector('button')!;
        first.click();
        setItems(['blue', 'red']);
        expect(root.querySelectorAll('button')[1]).toBe(first);
        expect(first.textContent).toBe('1');
        first.click();
        expect(reports).toEqual([['function', 'red'], ['function', 'red']]);
    });

    it('retains record fields in helpers that shadow the component receiver', () =>
    {
        const source = `component Probe(line) {
            form lines[] = { qty: '3' };
            lines.append();
            const label = line => line.qty;
            const read = () => lines.rows().map(line => line.qty).join(',');
            const inner = line => [0].map(() => { const line = { qty: 'plain' }; return line.qty }).join('');
            <section><p>{ line.qty }</p><u>{ read() }</u>
                <For each={ lines.rows() } key={ line => line.key } let={ line }>
                    <button onClick={ () => { line.qty = '5' } }>{ label(line) }/{ inner(line) }</button>
                </For>
            </section>
        }`;
        const [caption, setCaption] = createSignal('bag');
        const root = mount(source, { get qty()
        {
            return caption();
        } });
        const row = root.querySelector('button')!;
        expect([root.querySelector('p')?.textContent, root.querySelector('u')?.textContent, row.textContent])
            .toEqual(['bag', '3', '3/plain']);
        row.click();
        setCaption('new bag');
        expect(root.querySelector('button')).toBe(row);
        expect([root.querySelector('p')?.textContent, root.querySelector('u')?.textContent, row.textContent])
            .toEqual(['new bag', '5', '5/plain']);
    });

    it('gives a nested raw Show getter ownership inside an ordinary shadow', () =>
    {
        const source = `component Probe() { <For each={ ['outer'] } key={ x => x } let={ item }>
            <p>{ (() => { const item = 'middle'; return <Show when={ item.toUpperCase() } let={ item }>
                <i>{ item + ['!'].map(item => item).join('') }</i>
            </Show> })() }<b>{item}</b></p>
        </For> }`;
        const root = mount(source);
        expect(root.querySelector('i')?.textContent).toBe('MIDDLE!');
        expect(root.querySelector('b')?.textContent).toBe('outer');
    });

    it('reads the records passed to both an outer helper and its nested callback', () =>
    {
        const source = `component Probe() {
            form lines[] = { qty: '3' };
            lines.append();
            const report = line => line.qty + '/' + lines.rows().map(line => line.qty).join(',');
            <For each={ lines.rows() } key={ line => line.key } let={ line }>
                <p><button onClick={ () => { line.qty = '5' } }>{ report(line) }</button></p>
            </For>
        }`;
        const root = mount(source);
        const row = root.querySelector('button')!;
        expect(row.textContent).toBe('3/3');
        row.click();
        expect(root.querySelector('button')).toBe(row);
        expect(row.textContent).toBe('5/5');
    });
});
