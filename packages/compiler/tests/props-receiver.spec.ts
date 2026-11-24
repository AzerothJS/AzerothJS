// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createSignal, hydrate, render, renderToString } from 'azerothjs';
import { parseModule } from '@azerothjs/compiler';
import { analyzeComponent } from '../src/analyze.ts';
import { compileComponent } from './conformance/executor.ts';

const modes = ['universal', 'client', 'hydrate'] as const;
const containers: HTMLElement[] = [];

afterEach(() =>
{
    for (const container of containers.splice(0))
    {
        render(() => document.createElement('div'), container);
        container.remove();
    }
});

function mount(source: string, mode: typeof modes[number], props: Record<string, unknown>): HTMLElement
{
    const Probe = compileComponent(source, 'Probe', { ssr: mode !== 'client' });
    const app = (): HTMLElement => Probe(props) as HTMLElement;
    const root = document.createElement('main');
    document.body.appendChild(root);
    containers.push(root);
    if (mode === 'hydrate')
    {
        root.innerHTML = renderToString(app);
        const served = [...root.querySelectorAll('*')];
        hydrate(app, root);
        const adopted = [...root.querySelectorAll('*')];
        expect(adopted.length).toBe(served.length);
        expect(adopted.every((node, index) => node === served[index])).toBe(true);
    }
    else
    {
        render(app, root);
    }
    return root;
}

describe.each(modes)('component props receivers in %s', mode =>
{
    it.each(['p', 'props'])('tracks direct and branch-local member reads on %s', receiver =>
    {
        const source = `component Probe(${ receiver }) {
            <article>
                <input/><i title={ ${ receiver }.n }>value { ${ receiver }.n }</i>
                <Show when={ true }>{ () => <b title={ ${ receiver }.n }>{ ${ receiver }.n }</b> }</Show>
            </article>
        }`;
        const [n, set] = createSignal(1);
        const root = mount(source, mode, {
            get n()
            {
                return n();
            }
        });
        const draft = root.querySelector('input')!;
        draft.value = 'unsent';
        for (const value of [1, 2, 3])
        {
            set(value);
            const leaf = root.querySelector('i')!;
            const branch = root.querySelector('b')!;
            expect([leaf.textContent, leaf.title, branch.textContent, branch.title])
                .toEqual([`value ${ value }`, String(value), String(value), String(value)]);
            expect(root.querySelector('input')).toBe(draft);
            expect(draft.value).toBe('unsent');
        }
    });

    it('distinguishes a callback parameter and row getter from captured component props', () =>
    {
        const source = `component Rows(props) { <section>{ props.children({ name: 'local' }) }</section> }
            component Probe(p) {
                <article>
                    <Rows>{ p => <b title={ p.name }>{ p.name }</b> }</Rows>
                    <Rows>{ row => <i title={ row.name }>{ p.name }</i> }</Rows>
                    <For each={ p.rows } key={ row => row.id } let={ p }><em>{ p.name }</em></For>
                    <u>{ p.name }</u>
                </article>
            }`;
        const [name, rename] = createSignal('outer');
        const [rows, replace] = createSignal([{ id: 1, name: 'first' }]);
        const root = mount(source, mode, {
            get name()
            {
                return name();
            },
            get rows()
            {
                return rows();
            }
        });
        const row = root.querySelector('em')!;
        rename('changed');
        replace([{ id: 1, name: 'second' }]);
        const leaves = [...root.querySelectorAll('b,i,em,u')].map(el => el.textContent);
        expect(leaves).toEqual(['local', 'changed', 'second', 'changed']);
        expect(root.querySelector('b')?.title).toBe('local');
        expect(root.querySelector('i')?.title).toBe('local');
        expect(root.querySelector('em')).toBe(row);
    });

    it('keeps a destructured alias named props live when accessing its fields', () =>
    {
        const [entry, set] = createSignal({ title: 'ready' });
        const root = mount('component Probe({ entry: props }) { <b title={ props.title }>{ props.title }</b> }', mode, {
            get entry()
            {
                return entry();
            }
        });
        const node = root.querySelector('b')!;
        expect(node.textContent).toBe('ready');
        set({ title: 'saved' });
        expect([node.title, node.textContent]).toEqual(['saved', 'saved']);
    });

    it('keeps a DOM attribute reactive when its bare reference is a getter outside the binding', () =>
    {
        const [value, set] = createSignal('first');
        const root = mount(`component Probe(p) {
            const read = p.read;
            <b title={ read }/>
        }`, mode, { read: value });
        const node = root.querySelector('b')!;
        expect(node.title).toBe('first');
        set('second');
        expect(node.title).toBe('second');
    });

    it('reads a nested state that shadows the component parameter', () =>
    {
        const source = `component Probe(p) {
            <span>{ (() => { state p = { title: 'inner' }; return p.title; })() }/{ p.title }</span>
        }`;
        const node = mount(source, mode, { title: 'outer' }).querySelector('span')!;
        expect(node.textContent).toBe('inner/outer');
    });
});

it('attributes dependencies only to the component receiver visible at the read', () =>
{
    const source = `const props = { label: 'ordinary' };
        component Probe(input) {
            <main>
                <b>{ input.label }</b><i>{ input }</i><u>{ props.label }</u>
                <Rows>{ input => <em>{ input.label }</em> }</Rows>
                <s>{ ['row'].map(input => input.length) }</s>
            </main>
        }`;
    const component = parseModule(source).items.find(item => item.kind === 'component')!;
    const analysis = analyzeComponent(source, component);
    const deps = analysis.scopes.filter(scope => scope.origin === 'text').map(scope => scope.deps);
    expect(deps).toEqual([[{ kind: 'prop', field: 'label' }], [{ kind: 'prop', field: '*' }], [], [], [], []]);
});

it('analyzes row declarations in their own scope and keeps the outer receiver on either side', () =>
{
    const source = `component Probe(input) {
        <article><i>{ input.name }</i>
            <For each={ input.rows } key={ (row) => row.id } let={ input }>
                <b title={ input.name }>{ input.name }</b>
            </For>
            <u>{ input.name }</u>
        </article>
    }`;
    const component = parseModule(source).items.find(item => item.kind === 'component')!;
    const { scopes } = analyzeComponent(source, component);
    expect(scopes.filter(scope => scope.origin === 'text').map(scope => scope.deps))
        .toEqual([[{ kind: 'prop', field: 'name' }], [], [{ kind: 'prop', field: 'name' }]]);
    expect(scopes.filter(scope => scope.origin === 'attribute').map(scope => scope.deps))
        .toEqual([[{ kind: 'prop', field: 'rows' }], [], []]);
});
