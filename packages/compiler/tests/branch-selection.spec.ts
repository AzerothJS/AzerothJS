// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catchError, createEffect, createRoot, createSignal, h, hydrate, onCleanup, render, renderToStream, renderToString } from 'azerothjs';
import { subscriberCount } from 'azerothjs/internal';
import { compileComponent } from './conformance/executor.ts';

const root = document.createElement('div');
beforeEach(() => document.body.append(root));
afterEach(() =>
{
    render(() => document.createElement('i'), root);
    root.remove();
});

const field = `component Field(props) {
    const initial = props.name;
    cleanup { props.cleaned(initial); }
    <label><input/><b>{ initial }</b><i>{ props.name }</i></label>
}`;
const editor = '<Field name={ props.row.name } cleaned={ props.cleaned }/>';
const modes = ['client', 'hydrate'] as const;

function mount(source: string, props: Record<string, unknown>, mode: typeof modes[number]): void
{
    const App = compileComponent(source, 'App', { ssr: mode === 'hydrate' });
    const app = () => App(props) as HTMLElement;
    if (mode === 'hydrate')
    {
        root.innerHTML = renderToString(app);
        const served = root.querySelector('input');
        expect(served).toBeInstanceOf(HTMLInputElement);
        hydrate(app, root);
        expect(root.querySelector('input')).toBe(served);
    }
    else
    {
        render(app, root);
    }
}

describe.each(modes)('compiled branch selection in %s', mode =>
{
    it.each([
        ['Show', `<Show when={ props.row.open }>${ editor }</Show>`, true],
        ['Show arrow', `<Show when={ props.row.open }>{ () => ${ editor } }</Show>`, true],
        ['Show fallback', `<Show when={ props.row.open } fallback={ ${ editor } }><hr/></Show>`, false],
        ['Match', `<Switch><Match when={ props.row.open }>${ editor }</Match></Switch>`, true],
        ['Switch fallback', `<Switch fallback={ ${ editor } }><Match when={ props.row.open }><hr/></Match></Switch>`, false]
    ] as const)('%s keeps the editing component until the selection changes', async (_shape, branch, open) =>
    {
        const [row, setRow] = createSignal<{ name: string; open: boolean }>({ name: 'Alpha', open });
        const cleaned = vi.fn();
        mount(field + `component App(props) { <main>${ branch }</main> }`, {
            get row()
            {
                return row();
            },
            cleaned
        }, mode);
        await Promise.resolve();
        cleaned.mockClear();
        const input = root.querySelector('input')!;
        input.focus();
        input.value = 'draft';
        input.setSelectionRange(1, 3);
        for (const name of ['Birch', 'Cedar'])
        {
            setRow({ name, open });
            const visible = root.querySelector('input')!;
            expect(visible).toBe(input);
            expect(document.activeElement).toBe(input);
            expect([visible.value, visible.selectionStart, visible.selectionEnd]).toEqual(['draft', 1, 3]);
            expect([root.querySelector('b')?.textContent, root.querySelector('i')?.textContent]).toEqual(['Alpha', name]);
        }
        expect(cleaned).not.toHaveBeenCalled();
        setRow({ name: 'Away', open: !open });
        expect(cleaned.mock.calls).toEqual([['Alpha']]);
        expect(root.querySelector('input')).toBeNull();
        setRow({ name: 'Maple', open });
        expect(root.querySelector('input')?.value).toBe('');
        expect(root.querySelector('b')?.textContent).toBe('Maple');
    });

    it.each(['Show', 'Match'])('a retained keyed For row keeps its nested %s editor', tag =>
    {
        const row = { id: 1, open: true };
        const [rows, setRows] = createSignal([row]);
        const branch = tag === 'Show' ? '<Show when={ row.open }><input/></Show>' :
            '<Switch><Match when={ row.open }><input/></Match></Switch>';
        mount(`component App(props) { <main><For each={ props.rows } key={ row => row.id } let={ row }>
            <article>${ branch }</article></For></main> }`, {
            get rows()
            {
                return rows();
            }
        }, mode);
        const article = root.querySelector('article');
        const input = root.querySelector('input')!;
        input.value = 'row draft';
        setRows([{ ...row }]);
        expect(root.querySelector('article')).toBe(article);
        expect(root.querySelector('input')).toBe(input);
        expect(input.value).toBe('row draft');
        setRows([{ ...row, open: false }]);
        expect(root.querySelector('article')).toBe(article);
        expect(root.querySelector('input')).toBeNull();
    });
});

it('a parent mount listener stays on the visible ref through a same-selection update', async () =>
{
    const [revision, revise] = createSignal(1);
    const heard = vi.fn();
    const App = compileComponent(`component App(props) {
        let editor;
        mount { editor.addEventListener('change', props.heard); }
        <Show when={ props.revision > 0 }><input ref={ el => editor = el }/></Show>
    }`, 'App', { ssr: false }, true);
    render(() => App({ get revision()
    {
        return revision();
    }, heard }) as HTMLElement, root);
    await Promise.resolve();
    const initial = root.querySelector('input')!;
    initial.dispatchEvent(new Event('change'));
    expect(heard).toHaveBeenCalledOnce();
    revise(2);
    root.querySelector('input')!.dispatchEvent(new Event('change'));
    expect(heard).toHaveBeenCalledTimes(2);
});

it('a failed compiled Show selection reaches its handler and the recovered truthy case mounts anew', () =>
{
    const [value, setValue] = createSignal(1);
    const failure = new Error('cannot read selection');
    const caught: unknown[] = [];
    const props = { get active()
    {
        if (value() < 0)
        {
            throw failure;
        }
        return true;
    } };
    catchError(() => mount('component App(props) { <main><Show when={ props.active } fallback={ <b>out</b> }><input/></Show></main> }',
        props, 'client'), err => caught.push(err));
    const initial = root.querySelector('input')!;
    setValue(-1);
    expect(caught).toHaveLength(1);
    expect(caught[0]).toBe(failure);
    expect(root.querySelector('input, b')).toBeNull();
    setValue(1);
    expect(root.querySelector('input')).toBeInstanceOf(HTMLInputElement);
    expect(root.querySelector('input')).not.toBe(initial);
});

describe.each(modes)('failed initial selection in %s', mode =>
{
    it.each(['Show', 'Switch'])('%s reports each failed sample and mounts fresh content on recovery', tag =>
    {
        const [revision, setRevision] = createSignal(0);
        const [pulse] = createSignal(0);
        const failure = new Error('selection unavailable');
        const caught: unknown[] = [];
        const props = { get active()
        {
            if (revision() < 0)
            {
                createEffect(() =>
                {
                    pulse();
                });
                throw failure;
            }
            return true;
        } };
        const branch = tag === 'Show'
            ? '<Show when={ props.active } fallback={ <b>inactive</b> }><input/></Show>'
            : '<Switch fallback={ <b>inactive</b> }><Match when={ props.active }><input/></Match></Switch>';
        const App = compileComponent(`component App(props) { <main><i>before</i>${ branch }<em>after</em></main> }`, 'App',
            { ssr: mode === 'hydrate' });
        const app = () => App(props) as HTMLElement;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() =>
        {});
        let served: HTMLInputElement | null = null;
        let sibling: Element | null = null;
        if (mode === 'hydrate')
        {
            root.innerHTML = renderToString(app);
            served = root.querySelector('input');
            expect(served).toBeInstanceOf(HTMLInputElement);
            sibling = root.querySelector('em');
        }
        setRevision(-1);
        catchError(() => mode === 'hydrate' ? hydrate(app, root) : render(app, root), err => caught.push(err));
        expect(caught).toHaveLength(1);
        expect(caught[0]).toBe(failure);
        expect(subscriberCount(pulse)).toBe(0);
        expect(root.querySelector('input, b')).toBeNull();
        expect(root.textContent).toBe('beforeafter');
        setRevision(-2);
        expect(caught).toHaveLength(2);
        expect(caught[1]).toBe(failure);
        expect(subscriberCount(pulse)).toBe(0);
        expect(root.querySelector('input, b')).toBeNull();
        setRevision(1);
        expect(root.querySelector('input')).toBeInstanceOf(HTMLInputElement);
        expect(root.querySelector('input')).not.toBe(served);
        if (mode === 'hydrate')
        {
            expect(root.querySelector('em')).toBe(sibling);
        }
        expect(caught).toHaveLength(2);
        expect(warn).not.toHaveBeenCalled();
    });
});

describe.each(modes)('branch construction recovery in %s', mode =>
{
    it.each([
        ['Show', '<Show when={ props.selected } children={ props.build }/>', true],
        ['Show fallback', '<Show when={ props.selected } fallback={ () => props.build() }><strong>away</strong></Show>', false],
        ['Match', '<Switch><Match when={ props.selected } children={ props.build }/></Switch>', true],
        ['Switch fallback', '<Switch fallback={ () => props.build() }><Match when={ props.selected }><strong>away</strong></Match></Switch>', false]
    ] as const)('%s retries failed content on a same-selection update and retains successful content', (name, branch, shown) =>
    {
        const [record, change] = createSignal<{ selected: boolean; content: string }>({ selected: shown, content: 'server' });
        const failure = new Error(`${ name } content unavailable`);
        const caught: unknown[] = [];
        const attempts: string[] = [];
        const App = compileComponent(`component App(props) { <main><i>before</i>${ branch }<em>after</em></main> }`, 'App',
            { ssr: mode === 'hydrate' });
        const props = {
            get selected()
            {
                return record().selected;
            },
            build: () =>
            {
                const content = record().content;
                attempts.push(content);
                if (content === 'bad factory')
                {
                    throw failure;
                }
                if (content === 'bad child')
                {
                    return () =>
                    {
                        throw failure;
                    };
                }
                return content === 'empty' ? [] : h('input', {});
            }
        };
        const app = () => App(props) as HTMLElement;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() =>
        {});
        let served: HTMLInputElement | null = null;
        let sibling: Element | null = null;
        if (mode === 'hydrate')
        {
            root.innerHTML = renderToString(app);
            served = root.querySelector('input');
            expect(served).toBeInstanceOf(HTMLInputElement);
            sibling = root.querySelector('em');
            attempts.length = 0;
        }
        change({ selected: shown, content: 'bad factory' });
        catchError(() => mode === 'hydrate' ? hydrate(app, root) : render(app, root), error => caught.push(error));
        expect(attempts).toEqual(['bad factory']);
        expect(caught[0]).toBe(failure);
        expect(root.querySelector('input')).toBeNull();
        expect(root.textContent).toBe('beforeafter');
        change({ selected: shown, content: 'bad child' });
        expect(caught).toHaveLength(2);
        expect(caught[1]).toBe(failure);
        change({ selected: shown, content: 'valid' });
        const input = root.querySelector('input')!;
        expect(input).toBeInstanceOf(HTMLInputElement);
        expect(input).not.toBe(served);
        input.value = 'new draft';
        change({ selected: shown, content: 'valid again' });
        expect(root.querySelector('input')).toBe(input);
        expect(input.value).toBe('new draft');
        change({ selected: !shown, content: 'away' });
        expect(root.querySelector('input')).toBeNull();
        change({ selected: shown, content: 'empty' });
        change({ selected: shown, content: 'still empty' });
        expect(root.querySelector('input')).toBeNull();
        expect(attempts).toEqual(['bad factory', 'bad child', 'valid', 'empty']);
        expect(caught).toHaveLength(2);
        change({ selected: !shown, content: 'away' });
        change({ selected: shown, content: 'bad factory' });
        expect(caught).toHaveLength(3);
        expect(caught[2]).toBe(failure);
        expect(root.querySelector('input')).toBeNull();
        change({ selected: shown, content: 'reopened' });
        expect(root.querySelector('input')).toBeInstanceOf(HTMLInputElement);
        expect(attempts.slice(-2)).toEqual(['bad factory', 'reopened']);
        if (mode === 'hydrate')
        {
            expect(root.querySelector('em')).toBe(sibling);
        }
        expect(warn).not.toHaveBeenCalled();
    });
});

it.each(['predicate', 'child'])('a compiled Show with an unhandled initial %s error releases its sources', point =>
{
    const [selection] = createSignal(1);
    const [child] = createSignal(1);
    const failure = new Error('failed initial build');
    const App = compileComponent('component App(props) { <Show when={ props.active } children={ props.build }/> }', 'App', { ssr: false });
    const attempt = () =>
    {
        expect(() => App({
            get active()
            {
                const next = selection();
                if (point === 'predicate')
                {
                    throw failure;
                }
                return next;
            },
            build: () =>
            {
                createEffect(() =>
                {
                    child();
                });
                throw failure;
            }
        })).toThrow(failure);
        expect(subscriberCount(selection)).toBe(0);
        expect(subscriberCount(child)).toBe(0);
    };
    attempt();
    const stop = createRoot(dispose =>
    {
        attempt();
        return dispose;
    });
    stop();
});

it.each(['Show', 'Switch'])('%s delivers a failed predicate even if the outgoing cleanup throws first', async tag =>
{
    const [revision, revise] = createSignal(1);
    const selectionError = new Error('selection failed');
    const cleanupError = new Error('cleanup failed');
    const caught: unknown[] = [];
    let armed = true;
    const props = {
        get selected()
        {
            if (revision() < 0)
            {
                throw selectionError;
            }
            return true;
        },
        build: () =>
        {
            onCleanup(() =>
            {
                if (armed)
                {
                    armed = false;
                    throw cleanupError;
                }
            });
            return h('input', {});
        }
    };
    const branch = tag === 'Show' ? '<Show when={ props.selected } children={ props.build }/>' :
        '<Switch><Match when={ props.selected } children={ props.build }/></Switch>';
    catchError(() => mount(`component App(props) { <main>${ branch }</main> }`, props, 'client'), error => caught.push(error));
    expect(root.querySelector('input')).toBeInstanceOf(HTMLInputElement);
    const close = vi.fn(() => revise(-1));
    expect(close).toThrow(cleanupError);
    expect(close.mock.results[0]?.value).toBe(cleanupError);
    expect(root.querySelector('input')).toBeNull();
    await Promise.resolve();
    expect(caught).toHaveLength(1);
    expect(caught[0]).toBe(selectionError);
    revise(2);
    expect(root.querySelector('input')).toBeInstanceOf(HTMLInputElement);
    await Promise.resolve();
    expect(caught).toHaveLength(1);
});

it('a streamed Match adopts the editor and retains the last selected value in its unread callback', async () =>
{
    const [row, setRow] = createSignal<{ name: string } | null>({ name: 'Alpha' });
    const App = compileComponent(`component App(props) { <main><Switch><Match when={ props.row } let={ item }>
        <input/><button onClick={ () => props.park(() => item.name) }>Remember</button>
    </Match></Switch></main> }`, 'App', { ssr: true });
    const parked: Array<() => string> = [];
    const app = () => App({ get row()
    {
        return row();
    }, park: (read: () => string) => parked.push(read) }) as HTMLElement;
    root.innerHTML = await new Response(renderToStream(app)).text();
    const input = root.querySelector('input')!;
    input.value = 'streamed draft';
    hydrate(app, root);
    expect(root.querySelector('input')).toBe(input);
    root.querySelector('button')!.click();
    setRow({ name: 'Birch' });
    expect(root.querySelector('input')).toBe(input);
    expect(input.value).toBe('streamed draft');
    setRow(null);
    setRow({ name: 'Cedar' });
    expect(parked[0]!()).toBe('Birch');
    expect(root.querySelector('input')?.value).toBe('');
});

it.each(['Show', 'Match'])('a sole expression in %s continues to update independently of branch selection', tag =>
{
    const [row, setRow] = createSignal({ open: true, wide: false });
    const expression = '{ props.row.wide ? <strong>large</strong> : <small>small</small> }';
    const branch = tag === 'Show' ? `<Show when={ props.row.open }>${ expression }</Show>` :
        `<Switch><Match when={ props.row.open }>${ expression }</Match></Switch>`;
    mount(`component App(props) { <main>${ branch }</main> }`, { get row()
    {
        return row();
    } }, 'client');
    expect(root.querySelector('small')?.textContent).toBe('small');
    setRow({ open: true, wide: true });
    expect(root.querySelector('strong')?.textContent).toBe('large');
    expect(root.querySelector('small')).toBeNull();
});

describe.each(modes)('selection samples during %s', mode =>
{
    it('a markup-valued Match builds and displays the same selected instance', async () =>
    {
        const [label, setLabel] = createSignal<string | null>('Alpha');
        const built = vi.fn();
        const mounted = vi.fn();
        const cleaned = vi.fn();
        const App = compileComponent(`component Badge(props) {
            const name = props.name;
            props.built(name);
            mount { props.mounted(name); }
            cleanup { props.cleaned(name); }
            <b>{ name }</b>
        }
        component Frame(props) { <main><Switch><Match when={ props.name && props.badge } let={ badge }>
            <input/>{ badge }
        </Match></Switch></main> }
        component App(props) {
            <Frame name={ props.name } badge={ <Badge {...props}/> }/>
        }`, 'App', { ssr: mode === 'hydrate' });
        const app = () => App({ get name()
        {
            return label();
        }, built, mounted, cleaned }) as HTMLElement;
        if (mode === 'hydrate')
        {
            root.innerHTML = renderToString(app);
            expect(built.mock.calls).toEqual([['Alpha']]);
            built.mockClear();
            cleaned.mockClear();
            const served = root.querySelector('b');
            hydrate(app, root);
            expect(root.querySelector('b')).toBe(served);
        }
        else
        {
            render(app, root);
        }
        const input = root.querySelector('input');
        await Promise.resolve();
        expect(built.mock.calls).toEqual([['Alpha']]);
        expect(mounted.mock.calls).toEqual([['Alpha']]);
        setLabel('Birch');
        await Promise.resolve();
        expect(built.mock.calls).toEqual([['Alpha'], ['Birch']]);
        expect(mounted.mock.calls).toEqual([['Alpha'], ['Birch']]);
        expect(cleaned.mock.calls).toEqual([['Alpha']]);
        expect(root.querySelector('input')).toBe(input);
        expect(root.querySelector('b')?.textContent).toBe('Birch');
        setLabel(null);
        expect(cleaned.mock.calls).toEqual([['Alpha'], ['Birch']]);
        expect(root.querySelector('b')).toBeNull();
    });
});

it.each(['Show', 'Match'])('%s recovers when disposing a component made by its condition throws', tag =>
{
    const [name, setName] = createSignal<string | null>('Alpha');
    const [pulse, setPulse] = createSignal(0);
    const failure = new Error('condition component cleanup');
    const seen = vi.fn();
    let armed = true;
    const branch = tag === 'Show' ? '<Show when={ props.name && props.badge }><input/></Show>' :
        '<Switch><Match when={ props.name && props.badge } let={ badge }><input/>{ badge }</Match></Switch>';
    const App = compileComponent(`component Badge(props) {
        const label = props.name;
        effect { props.pulse(); props.seen(label); }
        cleanup { props.clean(label); }
        <b>{ label }</b>
    }
    component Frame(props) { <main>${ branch }</main> }
    component App(props) { <Frame name={ props.name } badge={ <Badge {...props}/> }/> }`, 'App', { ssr: false });
    render(() => App({ get name()
    {
        return name();
    }, pulse, seen, clean: (label: string) =>
    {
        if (label === 'Alpha' && armed)
        {
            armed = false;
            throw failure;
        }
    } }) as HTMLElement, root);
    expect(root.querySelector('input')).toBeInstanceOf(HTMLInputElement);
    const resample = vi.fn(() => setName('Birch'));
    expect(resample).toThrow(failure);
    expect(resample.mock.results[0]?.value).toBe(failure);
    expect(root.querySelector('input, b')).toBeNull();
    expect(subscriberCount(pulse)).toBe(0);
    setName(null);
    setName('Cedar');
    expect(root.querySelector('input')).toBeInstanceOf(HTMLInputElement);
    if (tag === 'Match')
    {
        expect(root.querySelector('b')?.textContent).toBe('Cedar');
    }
    seen.mockClear();
    setPulse(1);
    expect(seen.mock.calls).toEqual([['Cedar']]);
    setName(null);
    expect(root.querySelector('input, b')).toBeNull();
    expect(subscriberCount(pulse)).toBe(0);
    render(() => h('i', {}), root);
    expect(subscriberCount(name)).toBe(0);
});

it.each(['attribute', 'spread'])('compiled Show retains a zero-argument child supplied by %s', shape =>
{
    const [name, setName] = createSignal('Alpha');
    const controls = { when: name, children: () => h('input', {}) };
    const tag = shape === 'spread' ? '<Show {...props.controls}/>' :
        '<Show when={ props.controls.when } children={ props.controls.children }/>';
    mount(`component App(props) { <main>${ tag }</main> }`, { controls }, 'client');
    const input = root.querySelector('input')!;
    input.value = 'draft';
    setName('Birch');
    expect(root.querySelector('input')).toBe(input);
    expect(input.value).toBe('draft');
    setName('');
    expect(root.querySelector('input')).toBeNull();
});

it.each(['attribute', 'spread'])('compiled Show passes its narrowed accessor to the child supplied by %s', shape =>
{
    const [name, setName] = createSignal('Alpha');
    const reads: Array<() => string> = [];
    const controls = { when: name, children(this: { when: () => string }, read: () => string)
    {
        expect(this.when()).toBe(name());
        reads.push(read);
        return h('input', {});
    } };
    const tag = shape === 'spread' ? '<Show {...props.controls}/>' :
        '<Show when={ props.controls.when } children={ props.controls.children }/>';
    mount(`component App(props) { <main>${ tag }</main> }`, { controls }, 'client');
    const input = root.querySelector('input');
    setName('Birch');
    expect(root.querySelector('input')).toBe(input);
    expect(reads[0]!()).toBe('Birch');
    setName('');
    setName('Cedar');
    expect(reads.map(read => read())).toEqual(['Birch', 'Cedar']);
});
