// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemo, createRoot, createSignal, hydrate, render, renderToStream, renderToString } from 'azerothjs';
import { azsRuntime } from '../../azerothjs/src/renderer/stream-swap.ts';
import { compileComponent } from './conformance/executor.ts';

const container = document.createElement('div');
const modes = ['universal render', 'client render', 'hydrate'] as const;
type Mode = typeof modes[number];

beforeEach(() => document.body.append(container));
afterEach(() =>
{
    render(() => document.createElement('div'), container);
    container.remove();
});

function mount(source: string, props: Record<string, unknown>, mode: Mode): void
{
    const App = compileComponent(source, 'App', { ssr: mode !== 'client render' });
    const app = () => App(props) as HTMLElement;
    if (mode === 'hydrate')
    {
        container.innerHTML = renderToString(app);
        const served = container.querySelector('input');
        expect(served).toBeInstanceOf(HTMLInputElement);
        hydrate(app, container);
        expect(container.querySelector('input')).toBe(served);
    }
    else
    {
        render(app, container);
    }
}

const field = `component Field(props) {
    const initial = props.name;
    props.built(initial);
    cleanup { props.cleaned(initial); }
    derived live = props.name.toUpperCase();
    <label><input/><b>{ initial }</b><i>{ live }</i></label>
}`;

const resourcePage = `component Reader(props) {
    resource item = () => props.load();
    const initial = item.data();
    <article><input/><b>{ initial ?? "empty" }</b><Suspense on={ [item] } fallback={ <i>waiting</i> }>
        <strong>{ item.data() }</strong></Suspense></article>
}
component Wrap(props) { <main>{ props.children }</main> }
component App(props) { <Wrap><Reader load={ props.load }/></Wrap> }`;

describe.each(modes)('compiled component construction in %s', mode =>
{
    it('keeps the first resource when its pending request settles', async () =>
    {
        const requests: PromiseWithResolvers<string>[] = [];
        const load = () =>
        {
            const next = Promise.withResolvers<string>();
            requests.push(next);
            return next.promise;
        };
        mount(resourcePage, { load }, mode);
        const input = container.querySelector('input');
        expect(container.querySelector('i')?.textContent).toBe('waiting');
        expect(requests).toHaveLength(1);
        // Only the first request can settle. A rebuilding hole starts its second request
        // and stalls on the fallback, so the regression cannot run an unbounded fetch loop.
        requests[0]!.resolve('first result');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect([requests.length, container.querySelector('b')?.textContent,
            container.querySelector('strong')?.textContent]).toEqual([1, 'empty', 'first result']);
        expect(container.querySelector('input')).toBe(input);
    });

    it.each([
        ['direct', '<main><Field name={ props.name } built={ props.built } cleaned={ props.cleaned }/></main>'],
        ['children hole', '<Wrap><Field name={ props.name } built={ props.built } cleaned={ props.cleaned }/></Wrap>']
    ])('retains the %s child while its own bindings continue to track', (_label, markup) =>
    {
        const [name, setName] = createSignal('oak');
        const built = vi.fn();
        const cleaned = vi.fn();
        const source = field + `
            component Wrap(props) { <main>{ props.children }</main> }
            component App(props) { ${ markup } }`;
        mount(source, {
            built, cleaned,
            get name()
            {
                return name();
            }
        }, mode);
        const builds = built.mock.calls.length;
        const disposals = cleaned.mock.calls.length;
        const input = container.querySelector('input')!;
        input.value = 'working draft';
        input.focus();
        input.setSelectionRange(1, 4);
        for (const next of ['ash', 'elm'])
        {
            setName(next);
            expect([container.querySelector('b')?.textContent, container.querySelector('i')?.textContent,
                built.mock.calls.length - builds, cleaned.mock.calls.length - disposals])
                .toEqual(['oak', next.toUpperCase(), 0, 0]);
            expect(container.querySelector('input')).toBe(input);
            expect(document.activeElement).toBe(input);
            expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['working draft', 1, 4]);
        }
        render(() => document.createElement('div'), container);
        expect(cleaned).toHaveBeenCalledTimes(disposals + 1);
    });

    it('refreshes a single keyed row only when its revision changes', () =>
    {
        const [entry, setEntry] = createSignal({ revision: 1, name: 'oak' });
        const built = vi.fn();
        const cleaned = vi.fn();
        const source = field + `
            component App(props) {
                <main><For each={ [props.entry] } key={ row => row.revision } let={ row }>
                    <article><Field name={ row.name } built={ props.built } cleaned={ props.cleaned }/></article>
                </For></main>
            }`;
        mount(source, {
            built, cleaned,
            get entry()
            {
                return entry();
            }
        }, mode);
        const builds = built.mock.calls.length;
        const disposals = cleaned.mock.calls.length;
        const input = container.querySelector('input')!;
        input.value = 'draft';
        input.focus();
        setEntry({ revision: 1, name: 'ash' });
        expect(container.querySelector('input')).toBe(input);
        expect(container.textContent).toBe('oakASH');
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe('draft');
        expect(cleaned).toHaveBeenCalledTimes(disposals);
        setEntry({ revision: 2, name: 'elm' });
        expect(container.querySelector('input')).not.toBe(input);
        expect(container.querySelector('input')?.value).toBe('');
        expect(container.textContent).toBe('elmELM');
        expect(built).toHaveBeenCalledTimes(builds + 1);
        expect(cleaned).toHaveBeenCalledTimes(disposals + 1);
    });
});

it('adopts a streamed resource in a children hole with no additional fetch', async () =>
{
    const App = compileComponent(resourcePage, 'App', { ssr: true });
    const load = vi.fn(() => Promise.resolve('from server'));
    const app = () => App({ load }) as HTMLElement;
    const wire = await new Response(renderToStream(app)).text();
    container.innerHTML = wire;
    const template = container.querySelector<HTMLTemplateElement>('template[data-azs]')!;
    expect(template).toBeInstanceOf(HTMLTemplateElement);
    const runtime = globalThis as { __AZS?: (id: number) => void; __AZS_S?: Record<string, unknown> };
    try
    {
        azsRuntime();
        runtime.__AZS!(Number(template.dataset.azs));
        // The test ran the wire's script calls explicitly. Hydrate only the application DOM.
        for (const script of container.querySelectorAll('script'))
        {
            script.remove();
        }
        const input = container.querySelector('input');
        const served = container.querySelector('strong');
        expect(served?.textContent).toBe('from server');
        hydrate(app, container);
        expect(load).toHaveBeenCalledOnce();
        expect(container.querySelector('input')).toBe(input);
        expect(container.querySelector('strong')).toBe(served);
    }
    finally
    {
        delete runtime.__AZS;
        delete runtime.__AZS_S;
    }
});

it('disposes the old root and uses the replacement component on an explicit application refresh', () =>
{
    // The Vite HMR accept handler calls render() with the replacement module.
    const cleaned = vi.fn();
    const props = { built: vi.fn(), cleaned, name: 'oak' };
    mount(field + ' component App(props) { <Field {...props}/> }', props, 'client render');
    const first = container.querySelector('input')!;
    first.value = 'draft';
    first.focus();
    mount('component App { <main><input/><b>replacement</b></main> }', {}, 'client render');
    expect(container.textContent).toBe('replacement');
    expect(container.querySelector('input')).not.toBe(first);
    expect(container.querySelector('input')?.value).toBe('');
    expect(cleaned.mock.calls).toEqual([['oak']]);
});

it('recomputes server HTML when the caller selects a new input before component construction', () =>
{
    const App = compileComponent('component App(props) { const first = props.name; <b>{ first }</b> }', 'App');
    const [name, setName] = createSignal('oak');
    const dispose = createRoot(stop =>
    {
        const html = createMemo(() =>
        {
            const selected = name();
            return renderToString(() => App({ name: selected }) as HTMLElement);
        });
        expect(html()).toContain('oak');
        setName('ash');
        expect(html()).toContain('ash');
        return stop;
    });
    dispose();
});
