// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignal, hydrate, render, renderToString } from 'azerothjs';
import { parseModule } from '@azerothjs/compiler';
import { analyzeComponent } from '../src/analyze.ts';
import { lowerComponent } from '../src/lower.ts';
import { compileComponent } from './conformance/executor.ts';

const modes = ['universal render', 'client render', 'hydrate'] as const;
type Mode = typeof modes[number];
const containers: HTMLElement[] = [];

afterEach(() =>
{
    for (const container of containers.splice(0))
    {
        render(() => document.createElement('div'), container);
        container.remove();
    }
});

function mount(source: string, mode: Mode, props: Record<string, unknown>, adoptedSelector = '*'): HTMLElement
{
    const Probe = compileComponent(source, 'Probe', { ssr: mode !== 'client render' });
    const app = (): HTMLElement => Probe(props) as HTMLElement;
    const container = document.createElement('div');
    containers.push(container);
    document.body.appendChild(container);
    if (mode === 'hydrate')
    {
        container.innerHTML = renderToString(app);
        const served = [...container.querySelectorAll(adoptedSelector)];
        expect(served.length).toBeGreaterThan(0);
        hydrate(app, container);
        const adopted = [...container.querySelectorAll(adoptedSelector)];
        expect(adopted).toHaveLength(served.length);
        expect(adopted.every((el, index) => el === served[index])).toBe(true);
    }
    else
    {
        render(app, container);
    }
    return container;
}

const rows = `component Rows(props) {
    <section>{ props.children("oak") }{ props.children("ash") }</section>
}`;

describe.each(modes)('explicit arrow children in %s', mode =>
{
    it.each([
        ['show', '<Show when={ true }>{ () => <i data-name={ props.user.name }>{ props.user.name }</i> }</Show>'],
        ['nested show', '<Show when={ true }>{ () => <article><Show when={ true }>{ () => <i data-name={ props.user.name }>{ props.user.name }</i> }</Show></article> }</Show>'],
        ['spread host', '<Show when={ true }>{ () => <i {...({ title: "caption" })} data-name={ props.user.name }>{ props.user.name }</i> }</Show>'],
        ['host ref', '<Show when={ true }>{ () => <i ref={ el => el } data-name={ props.user.name }>{ props.user.name }</i> }</Show>'],
        ['switch', '<Switch><Match when={ true }>{ () => <i data-name={ props.user.name }>{ props.user.name }</i> }</Match></Switch>'],
        ['zero-argument row', '<For each={ ["row"] } key={ (row) => row }>{ () => <i data-name={ props.user.name }>{ props.user.name }</i> }</For>'],
        ['parenthesized body', '<Show when={ true }>{ () => (<i data-name={ props.user.name }>{ props.user.name }</i>) }</Show>']
    ])('updates a member read in %s', (_label, markup) =>
    {
        const [name, setName] = createSignal('oak');
        const props = {
            get user()
            {
                return { name: name() };
            }
        };
        const container = mount(`component Probe(props) { <main>${ markup }</main> }`, mode, props);
        const leaf = container.querySelector('i')!;
        for (const value of ['oak', 'ash', 'elm'])
        {
            setName(value);
            expect(container.querySelector('i')).toBe(leaf);
            expect([leaf.textContent, leaf.getAttribute('data-name')]).toEqual([value, value]);
        }
    });

    it.each([
        ['a tracked children hole', '<Wrap>{ () => <label><input/><span>{ caption }</span></label> }</Wrap>'],
        ['an error boundary', '<ErrorBoundary fallback={ () => <em>failed</em> }>{ () => <label><input/><span>{ caption }</span></label> }</ErrorBoundary>']
    ])('retains a typed draft while updating a destructured prop inside %s', (label, markup) =>
    {
        const [name, setName] = createSignal('oak');
        const props = {
            get caption()
            {
                return name();
            }
        };
        const source = `component Wrap(props) { <div>{ props.children }</div> }
            component Probe({ caption }) { <main>${ markup }</main> }`;
        // ErrorBoundary reconstructs its own range during hydration. Its subsequent
        // updates must preserve the draft entered after that initial reconstruction.
        const container = mount(source, mode, props, label === 'an error boundary' ? 'main' : '*');
        const input = container.querySelector('input')!;
        input.value = 'draft';
        input.focus();
        setName('ash');
        expect(container.querySelector('span')?.textContent).toBe('ash');
        expect(container.querySelector('input')).toBe(input);
        expect(input.value).toBe('draft');
        expect(document.activeElement).toBe(input);
    });

    it.each([
        ['unparenthesized body', '(id) => <button title={ id } onClick={ () => onPick(id) }>{ id }</button>'],
        ['parenthesized body', '(id) => (<button title={ id } onClick={ () => onPick(id) }>{ id }</button>)'],
        ['renamed row parameter', '(row) => <button title={ row } onClick={ () => onPick(row) }>{ row }</button>']
    ])('uses the row value for text, attributes and an event with %s', (_label, arrow) =>
    {
        const onPick = vi.fn();
        const source = `${ rows }
            component Probe({ id, onPick }) { <Rows>{ ${ arrow } }</Rows> }`;
        const container = mount(source, mode, { id: 'owner', onPick });
        const buttons = [...container.querySelectorAll('button')];
        for (const button of buttons)
        {
            button.click();
        }
        expect({ text: buttons.map(button => button.textContent), titles: buttons.map(button => button.title), picks: onPick.mock.calls })
            .toEqual({ text: ['oak', 'ash'], titles: ['oak', 'ash'], picks: [['oak'], ['ash']] });
    });

    it('isolates nested arrow parameters and keeps unshadowed owner reads live', () =>
    {
        const source = `${ rows }
            component Probe({ id, caption }) {
                <main>
                    <Rows>{ id => <div><b>{ id }</b>
                        <Rows>{ id => <em data-row={ id }>{ caption }</em> }</Rows>
                        <u>{ id }</u></div> }</Rows>
                    <strong>{ id }</strong>
                </main>
            }`;
        const [caption, setCaption] = createSignal('first');
        const container = mount(source, mode, {
            id: 'owner',
            get caption()
            {
                return caption();
            }
        });
        setCaption('second');
        const text = (selector: string): string[] => [...container.querySelectorAll(selector)].map(el => el.textContent);
        expect([text('b'), text('u'), text('strong')]).toEqual([['oak', 'ash'], ['oak', 'ash'], ['owner']]);
        expect(text('em')).toEqual(['second', 'second', 'second', 'second']);
        expect([...container.querySelectorAll('em')].map(el => el.dataset.row)).toEqual(['oak', 'ash', 'oak', 'ash']);
    });

    it('shadows an outer let getter in a callback while its keyed row moves and updates', () =>
    {
        const source = `${ rows }
            component Probe(props) {
                <For each={ props.items } key={ row => row.id } let={ row }>
                    <article><b>{ row.name }</b><Rows>{ row => <em>{ row }</em> }</Rows><u>{ row.name }</u></article>
                </For>
            }`;
        const [items, setItems] = createSignal([{ id: 1, name: 'first' }, { id: 2, name: 'second' }]);
        const props = {
            get items()
            {
                return items();
            }
        };
        const container = mount(source, mode, props);
        const [first, second] = [...container.querySelectorAll('article')];
        setItems([{ id: 2, name: 'new second' }, { id: 1, name: 'new first' }]);
        const moved = [...container.querySelectorAll('article')];
        expect(moved[0]).toBe(second);
        expect(moved[1]).toBe(first);
        expect(moved.map(el => el.textContent)).toEqual(['new secondoakashnew second', 'new firstoakashnew first']);
    });

    it('resolves nested binding patterns and property shorthand using the callback argument', () =>
    {
        const source = `component Rows(props) { <section>{ props.children({ value: { name: "oak" } }) }</section> }
            component Probe({ name, pick }) {
                <Rows>{ ({ value: { name } }) => <button onClick={ () => pick({ name }) }>{ name }</button> }</Rows>
            }`;
        const pick = vi.fn();
        const container = mount(source, mode, { name: 'owner', pick });
        const button = container.querySelector('button')!;
        button.click();
        expect([button.textContent, pick.mock.calls]).toEqual(['oak', [[{ name: 'oak' }]]]);
    });

    it.each(['clone', 'raw'])('keeps a captured prop alias live beside a parameter named props in %s markup', kind =>
    {
        const body = '<button title={ caption } onClick={ () => onPick(props) }>{ props }</button>';
        const arrow = kind === 'clone' ? body : `(${ body })`;
        const source = `${ rows }
            component Probe({ label: caption, onPick }) { <Rows>{ props => ${ arrow } }</Rows> }`;
        const [caption, setCaption] = createSignal('owner');
        const onPick = vi.fn();
        const container = mount(source, mode, {
            get label()
            {
                return caption();
            },
            onPick
        });
        const buttons = [...container.querySelectorAll('button')];
        for (const value of ['owner', 'changed'])
        {
            setCaption(value);
            expect(buttons.map(button => [button.textContent, button.title])).toEqual([['oak', value], ['ash', value]]);
        }
        buttons[1]!.click();
        expect(onPick.mock.calls).toEqual([['ash']]);
    });

    it.each(['clone', 'raw'])('evaluates a %s callback default against its captured component alias', kind =>
    {
        const body = '<b>{ chosen }</b>';
        const source = `component Rows(props) { <section>{ props.children() }{ props.children("provided") }</section> }
            component Probe({ label: caption }) {
                <Rows>{ (chosen = caption) => ${ kind === 'clone' ? body : `(${ body })` } }</Rows>
            }`;
        const container = mount(source, mode, { label: 'default' });
        expect([...container.querySelectorAll('b')].map(el => el.textContent)).toEqual(['default', 'provided']);
    });

    it.each(['clone', 'raw'])('keeps a later parameter in its temporal dead zone during a %s callback default', kind =>
    {
        const body = '<b>{ first }</b>';
        const source = `function invoke(callback, ...args) {
                try { return callback(...args); } catch (error) { return error.name; }
            }
            component Rows(props) { <section>{ invoke(props.children) }{ invoke(props.children, "provided") }</section> }
            component Probe({ id }) {
                <Rows>{ (first = id, id = "row") => ${ kind === 'clone' ? body : `(${ body })` } }</Rows>
            }`;
        const container = mount(source, mode, { id: 'owner' });
        expect(container.textContent).toBe('ReferenceErrorprovided');
    });

    it('shadows an inherited let getter in a raw callback', () =>
    {
        const source = `${ rows }
            component Probe { <For each={ ["outer"] } key={ value => value } let={ row }>
                <article><Rows>{ row => (<b>{ row }</b>) }</Rows><u>{ row }</u></article>
            </For> }`;
        const container = mount(source, mode, {});
        expect(container.textContent).toBe('oakashouter');
    });

    it('reads the inner let getter when it shadows an ordinary callback parameter', () =>
    {
        const source = `${ rows }
            component Probe { <Rows>{ row => <article><For each={ ["inner"] } key={ value => value } let={ row }>
                <b>{ row }</b></For><u>{ row }</u></article> }</Rows> }`;
        const container = mount(source, mode, {});
        expect([...container.querySelectorAll('article')].map(el => el.textContent)).toEqual(['inneroak', 'innerash']);
    });

    it.each([
        ['state', 'state name = "owner";', 'name'],
        ['derived', 'derived name = props.owner;', 'name'],
        ['component parameter', '', 'props']
    ])('lets a row parameter shadow the %s in a nested clone', (_label, setup, param) =>
    {
        const source = `${ rows }
            component Probe(props) {
                ${ setup }
                <Rows>{ (${ param }) => <div><Show when={ true }>{ () => <b>{ ${ param } }</b> }</Show></div> }</Rows>
            }`;
        const container = mount(source, mode, { owner: 'owner' });
        expect([...container.querySelectorAll('b')].map(button => button.textContent)).toEqual(['oak', 'ash']);
    });
});

it('recovers once when an earlier compiler served a one-time child without hole markers', () =>
{
    const Probe = compileComponent('component Probe(props) { <main><Show when={ true }>{ () => <i>{ props.caption }</i> }</Show></main> }', 'Probe');
    const [caption, setCaption] = createSignal('oak');
    const props = {
        get caption()
        {
            return caption();
        }
    };
    const app = (): HTMLElement => Probe(props) as HTMLElement;
    const container = document.createElement('div');
    containers.push(container);
    container.innerHTML = '<main><!--azc:show--><i>oak</i><!--/azc--></main>';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hydrate(app, container);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('falling back'))).toHaveLength(1);
    const leaf = container.querySelector('i');
    setCaption('ash');
    expect(container.querySelector('i')).toBe(leaf);
    expect(leaf?.textContent).toBe('ash');
});

it('refuses to lower a component binding omitted from its dependency analysis', () =>
{
    const source = 'component Probe(props) { <div><Show when={ true }>{ () => <p>{ props.caption }</p> }</Show></div> }';
    const component = parseModule(source).items.find(item => item.kind === 'component')!;
    const analysis = analyzeComponent(source, component);
    expect(lowerComponent(source, component, analysis)).not.toBeNull();
    const start = source.indexOf('{ props.caption }');
    const incomplete = { ...analysis, scopes: analysis.scopes.filter(scope => scope.span.start !== start) };
    expect(() => lowerComponent(source, component, incomplete)).toThrow(/scope|analysis/i);
});

it('marks a live child in server HTML and leaves a plain row value bound once', () =>
{
    const Probe = compileComponent(`${ rows }
        component Probe(props) {
            <Rows>{ row => <article><i>{ props.caption }</i><b>{ row }</b></article> }</Rows>
        }`, 'Probe');
    const html = renderToString(() => Probe({ caption: 'caption' }) as HTMLElement);
    expect(html).toContain('<i><!--[-->caption<!--]--></i><b>oak</b>');
    expect(html).toContain('<i><!--[-->caption<!--]--></i><b>ash</b>');
});

it.each(['<T>', '<T extends unknown>'])('accepts a returned TypeScript generic arrow starting with %s', typeParams =>
{
    const source = `component Consumer(props) { <p>{ props.children("row")("oak") }</p> }
        component Probe { <Consumer>{ item => ${ typeParams }(x:T) => x }</Consumer> }`;
    const Probe = compileComponent(source, 'Probe', {}, true);
    expect(renderToString(() => Probe() as HTMLElement)).toContain('oak');
});

it.each(['direct', 'grouped'])('keeps a prop default in the component scope in a %s callback', kind =>
{
    const value = '<b>{ title }</b>';
    const source = `const fallback = "original";
        component Rows(props) { <section>{ props.children("row") }</section> }
        component Probe({ title = fallback }) { <Rows>{ fallback => ${ kind === 'direct' ? value : '(' + value + ')' } }</Rows> }`;
    const previous = compileComponent(source, 'Probe');
    expect(renderToString(() => previous() as HTMLElement)).toContain('original');
    expect(renderToString(() => previous({ title: 'provided' }) as HTMLElement)).toContain('provided');
});

it('evaluates a captured prop default only on a missing value', () =>
{
    const source = `let reads = 0;
        const fallback = () => String(++reads);
        component Row(props) { <aside>{ props.children("caller") }</aside> }
        component Probe({ title = fallback() }) {
            <Row>{ fallback => <p>{ title }</p> }</Row>
        }`;
    const Probe = compileComponent(source, 'Probe');
    const server = (props: Record<string, unknown>): string => renderToString(() => Probe(props) as HTMLElement);
    expect(server({ title: 'provided' })).toContain('provided');
    expect(server({})).toContain('>1<');
    expect(server({ title: 'overridden' })).toContain('overridden');
    expect(server({})).toContain('>2<');
});

describe.each(modes)('nested let getter in %s', mode =>
{
    it.each(['direct', 'grouped'])('lets props name the inner row in a %s callback body', kind =>
    {
        const body = '<article><For each={ [{id:"inner"}] } key={ x => x.id } let={ props }><b>{ props.id }</b></For></article>';
        const source = `${ rows }
            component Probe(props) { <Rows>{ props => ${ kind === 'direct' ? body : '(' + body + ')' } }</Rows> }`;
        const container = mount(source, mode, { id: 'owner' });
        expect(container.textContent).toBe('innerinner');
    });
});
