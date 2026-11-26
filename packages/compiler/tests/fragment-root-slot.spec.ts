// A component whose root is a fragment lowers to the array of its roots. The h()-tree path that
// serves SSR and hydration has always accepted one; the template-clone path's slot binder handed
// it straight to insertBefore and threw, so the same component rendered on the server and blanked
// the page in the browser. These arms execute the COMPILED output in all three modes.
import { describe, it, expect, vi } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import * as internal from 'azerothjs/internal';
import * as azerothjs from 'azerothjs';
import { createMemoryHistory, createRouter, createSignal, h, hydrate, render, renderToString, Routes, ssr } from 'azerothjs';

type Component = (props?: Record<string, unknown>) => unknown;

/** Compiles `.azeroth` source and returns its default export, executed against the runtime. */
function compile(source: string, extra: Record<string, unknown> = {}): Component
{
    const generated = generateModule(source, 'T.azeroth', {});
    const body = generated.code
        .replace(/^import[^;]+;[ \t]*\r?\n?/gm, '')
        .replace(/^export\s+default\s+function/gm, 'function')
        .replace(/^export\s+function/gm, 'function');
    const name = (/^function\s+(\w+)/m.exec(body) as RegExpExecArray)[1] as string;
    const scope: Record<string, unknown> = {
        ...(internal as unknown as Record<string, unknown>),
        ...(azerothjs as unknown as Record<string, unknown>),
        ...extra
    };
    const keys = Object.keys(scope);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- executing the compiler's own output IS the point
    const factory = new Function(...keys, `${ body }\nreturn ${ name };`) as (...args: unknown[]) => Component;
    return factory(...keys.map((key) => scope[key]));
}

const SHELL = `
import { Show, type Child } from 'azerothjs';
export default component Shell(props: { on: boolean; children: Child })
{
    <>
        <Show when={ props.on }><div class="layout">{ props.children }</div></Show>
        <Show when={ !props.on }><p id="signed-out">out</p></Show>
    </>
}`;

const PAIR = `
export default component Pair()
{
    <>
        <p id="a">A</p>
        <p id="b">B</p>
    </>
}`;

const PARENT = `
import Shell from './Shell.azeroth';
import Pair from './Pair.azeroth';
export default component Parent(props: { on: boolean })
{
    <section id="host"><Shell on={ props.on }><em id="inner">inner</em></Shell><Pair /></section>
}`;

function parent(): Component
{
    return compile(PARENT, { Shell: compile(SHELL), Pair: compile(PAIR) });
}

function mount(build: () => unknown): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(() => build() as HTMLElement, container);
    return container;
}

const VALUE_PARENT = `
import Value from './Value.azeroth';
export default component Parent()
{
    <section><i>L</i><Value/><i>R</i></section>
}`;

describe('a component value in a compiled slot', () =>
{
    it.each([
        ['<em>text</em>', '<em>text</em>'], [0, '0'], [true, 'true'],
        [false, ''], [null, ''], [undefined, ''], ['', '']
    ])('mounts %j in place and adopts matching server output', (value, shown) =>
    {
        const Parent = compile(VALUE_PARENT, { Value: () => value });
        const host = mount(Parent);
        const section = host.firstElementChild;
        expect(section?.textContent).toBe(`L${ shown }R`);
        expect(section?.querySelector('em')).toBeNull();
        if (value === false || value == null)
        {
            expect(section?.childNodes).toHaveLength(2);
        }
        host.innerHTML = renderToString(() => Parent() as HTMLElement);
        const first = host.querySelector('i');
        hydrate(() => Parent() as HTMLElement, host);
        expect(host.querySelector('i')).toBe(first);
        expect(host.textContent).toBe(`L${ shown }R`);
        host.remove();
    });

    it('updates a getter between stable siblings and releases it on remount', () =>
    {
        const [step, setStep] = createSignal(0);
        const el = document.createElement('b');
        el.textContent = 'element';
        const read = vi.fn(() => ['start', [0, [el]], false][step()]);
        const Parent = compile(VALUE_PARENT, { Value: () => read });
        const host = mount(Parent);
        const siblings = [...host.querySelectorAll('i')];
        expect(host.textContent).toBe('LstartR');
        setStep(1);
        expect(host.textContent).toBe('L0elementR');
        expect(host.querySelector('b')).toBe(el);
        setStep(2);
        expect(host.textContent).toBe('LR');
        expect([...host.querySelectorAll('i')]).toEqual(siblings);
        render(() => document.createElement('aside'), host);
        const reads = read.mock.calls.length;
        setStep(0);
        expect(read).toHaveBeenCalledTimes(reads);
        host.remove();
    });

    it('serializes branded server markup and uses ordinary object coercion on the client', () =>
    {
        const Parent = compile(VALUE_PARENT, { Value: () => ssr('<b>server</b>') });
        const host = mount(Parent);
        expect(host.textContent).toBe('L[object Object]R');
        expect(host.querySelector('b')).toBeNull();
        host.innerHTML = renderToString(() => Parent() as HTMLElement);
        expect(host.querySelector('b')?.textContent).toBe('server');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            hydrate(() => Parent() as HTMLElement, host);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back'));
            expect(host.querySelector('b')).toBeNull();
            expect(host.textContent).toBe('L[object Object]R');
        }
        finally
        {
            warn.mockRestore();
            host.remove();
        }
    });

    it('retains a route outlet returned by a getter and releases it when hidden', () =>
    {
        const [step, setStep] = createSignal(0);
        const Layout = compile(`export default component Layout(props: { children?: unknown }) {
            <main><Value content={props.children}/></main>
        }`, { Value: (props: { content: unknown }) => () => step() === 2 ? 'closed' : props.content });
        const leaf = vi.fn(() => h('b', {}, 'leaf'));
        const host = mount(() => Routes({ router: createRouter({
            history: createMemoryHistory('/p'),
            routes: [{ path: '/p', component: props => Layout(props) as HTMLElement, children: [{ path: '', component: leaf }] }]
        }) }));
        const original = host.querySelector('b');
        expect(original?.textContent).toBe('leaf');
        setStep(1);
        expect(host.querySelector('b')).toBe(original);
        expect(leaf).toHaveBeenCalledTimes(1);
        setStep(2);
        expect(host.textContent).toBe('closed');
        setStep(0);
        expect(host.textContent).toBe('leaf');
        expect(leaf).toHaveBeenCalledTimes(2);
        render(() => h('aside', {}), host);
        host.remove();
    });
});

describe('a fragment-root component in a template-clone slot', () =>
{
    it('client: every root lands at the slot, in order, with the slotted children inside', () =>
    {
        const Parent = parent();
        const container = mount(() => Parent({ on: true }));
        const host = container.querySelector('#host') as HTMLElement;
        expect(host.querySelector('.layout #inner')?.textContent).toBe('inner');
        expect(host.querySelector('#signed-out')).toBeNull();
        const ids = [...host.querySelectorAll('p')].map((el) => el.id);
        expect(ids).toEqual(['a', 'b']);
        expect(host.querySelector('.layout')?.compareDocumentPosition(host.querySelector('#a') as Element))
            .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it('client: the other branch of the fragment renders when the condition flips', () =>
    {
        const Parent = parent();
        const container = mount(() => Parent({ on: false }));
        const host = container.querySelector('#host') as HTMLElement;
        expect(host.querySelector('#signed-out')?.textContent).toBe('out');
        expect(host.querySelector('.layout')).toBeNull();
    });

    it('server: the same component serializes its roots at the slot', () =>
    {
        const Parent = parent();
        const html = renderToString(() => Parent({ on: true }) as HTMLElement);
        expect(html).toContain('class="layout"');
        expect(html).toContain('id="inner"');
        expect(html).not.toContain('signed-out');
        expect(html.indexOf('id="a"')).toBeGreaterThan(html.indexOf('id="inner"'));
    });

    it('hydration adopts the server markup for the fragment roots without rebuilding', () =>
    {
        const Parent = parent();
        const html = renderToString(() => Parent({ on: true }) as HTMLElement);
        const container = document.createElement('div');
        document.body.appendChild(container);
        container.innerHTML = html;
        const inner = container.querySelector('#inner') as HTMLElement;
        const a = container.querySelector('#a') as HTMLElement;
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        hydrate(() => Parent({ on: true }) as HTMLElement, container);
        expect(container.querySelector('#inner')).toBe(inner);
        expect(container.querySelector('#a')).toBe(a);
        expect(errors).not.toHaveBeenCalled();
        expect(warnings).not.toHaveBeenCalled();
        errors.mockRestore();
        warnings.mockRestore();
    });
});
