// A component whose root is a fragment lowers to the array of its roots. The h()-tree path that
// serves SSR and hydration has always accepted one; the template-clone path's slot binder handed
// it straight to insertBefore and threw, so the same component rendered on the server and blanked
// the page in the browser. These arms execute the COMPILED output in all three modes.
import { describe, it, expect, vi } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import * as internal from 'azerothjs/internal';
import * as azerothjs from 'azerothjs';
import { hydrate, render, renderToString } from 'azerothjs';

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
