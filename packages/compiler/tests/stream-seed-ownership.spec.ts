// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignal, hydrate, render, renderToStream, renderToString } from 'azerothjs';
import { clearStreamPage, streamPage } from '../../azerothjs/tests/ssr/stream-test-page.ts';
import { compileComponent } from './conformance/executor.ts';

afterEach(clearStreamPage);

const declarations = `component Widget(props) {
    resource result = () => props.fetch(props.id);
    <article><Suspense on={ [result] } fallback={ <i>pending</i> }>
        <button onClick={ () => props.choose(props.id) }>{ props.format(result.data()) }</button>
    </Suspense></article>
}
component Layout(props) { <section>{ props.children }</section> }`;

const a = '<Widget id="A" fetch={ props.fetch } format={ props.formatA } choose={ props.choose }/>';
const b = '<Widget id="B" fetch={ props.fetch } format={ props.formatB } choose={ props.choose }/>';
const wrap = (value: string) => `<Show when={ true }>${ value }</Show>`;

describe('the Suspense boundary owns its streamed resource', () =>
{
    it.each(['client render', 'hydration'])('captures an expression-valued watch list once on %s', async mode =>
    {
        const first = Promise.withResolvers<string>();
        const second = Promise.withResolvers<string>();
        const [useSecond, setSecond] = createSignal(false);
        const App = compileComponent(`component App(props) {
            resource first = () => props.first();
            resource second = () => props.second();
            <main><Suspense on={ props.useSecond ? [second] : [first] } fallback={ <i>waiting</i> }>
                <b>{ first.data() }</b>
            </Suspense></main>
        }`, 'App', { ssr: mode === 'hydration' });
        const app = () => App({
            first: () => first.promise,
            second: () => second.promise,
            get useSecond()
            {
                return useSecond();
            }
        }) as HTMLElement;
        const root = document.createElement('div');
        document.body.appendChild(root);
        if (mode === 'hydration')
        {
            root.innerHTML = renderToString(app);
            hydrate(app, root);
        }
        else
        {
            render(app, root);
        }
        expect(root.textContent).toBe('waiting');
        setSecond(true);
        first.resolve('first ready');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(root.textContent).toBe('first ready');
        second.resolve('second ready');
    });

    it.each([
        ['Show then eager', wrap(a) + b],
        ['eager then Show', a + wrap(b)],
        ['both lazy', wrap(a) + wrap(b)],
        ['both eager', a + b],
        ['Match then eager', `<Switch><Match when={ true }>${ a }</Match></Switch>${ b }`],
        ['For row then eager', `<For each={ ["A"] } key={ id => id } let={ id }><div>${ a }</div></For>${ b }`],
        ['children hole then eager', `<Layout>${ a }</Layout>${ b }`],
        ['reactive hole then eager', `{ props.visible && ${ a } }${ b }`],
        ['Transition then eager', `<Transition when={ true }>${ a }</Transition>${ b }`],
        ['Dynamic then eager', `<Dynamic component={ Widget } props={ () => ({ id:"A", fetch:props.fetch, format:props.formatA, choose:props.choose }) }/>${ b }`]
    ])('adopts both widgets with the right data and working handlers in %s', async (_placement, markup) =>
    {
        const App = compileComponent(`${ declarations } component App(props) { <main>${ markup }</main> }`, 'App');
        const fetch = vi.fn((id: string) => Promise.resolve('server-' + id));
        const choose = vi.fn();
        const app = () => App({ fetch, choose, formatA: String, formatB: String, visible: true }) as HTMLElement;
        const root = await streamPage(renderToStream(app));
        const buttons = [...root.querySelectorAll('button')];
        expect(buttons.map(node => node.textContent)).toEqual(['server-A', 'server-B']);
        expect(fetch).toHaveBeenCalledTimes(2);
        hydrate(app, root);
        expect([...root.querySelectorAll('button')].map(node => node.textContent)).toEqual(['server-A', 'server-B']);
        expect(root.querySelectorAll('button')[0]).toBe(buttons[0]);
        expect(root.querySelectorAll('button')[1]).toBe(buttons[1]);
        buttons.forEach(node => node.click());
        expect(choose.mock.calls.flat()).toEqual(['A', 'B']);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('keeps different payload types on the correct sides of the lazy boundary', async () =>
    {
        const App = compileComponent(`${ declarations } component App(props) { <main>${ wrap(a) }${ b }</main> }`, 'App');
        const fetch = vi.fn((id: string) => Promise.resolve(id === 'A' ? 7 : 'ocean'));
        const app = () => App({ fetch, choose: vi.fn(), formatA: (n: number) => n.toFixed(2),
            formatB: (s: string) => s.toUpperCase() }) as HTMLElement;
        const root = await streamPage(renderToStream(app));
        expect(root.textContent).toBe('7.00OCEAN');
        const page = root.firstElementChild;
        hydrate(app, root);
        expect(root.firstElementChild).toBe(page);
        expect(root.textContent).toBe('7.00OCEAN');
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('recovers typed markup served by an older ordinal-seed runtime', async () =>
    {
        const App = compileComponent(`${ declarations } component App(props) { <main>${ wrap(a) }${ b }</main> }`, 'App');
        let client = false;
        const fetch = vi.fn((id: string) => Promise.resolve(id === 'A' ? (client ? 8 : 7) : (client ? 'bay' : 'ocean')));
        const app = () => App({ fetch, choose: vi.fn(), formatA: (n: number) => n.toFixed(2),
            formatB: (s: string) => s.toUpperCase() }) as HTMLElement;
        const root = await streamPage(renderToStream(app));
        expect(root.textContent).toBe('7.00OCEAN');
        const main = root.firstElementChild;
        // Old swap scripts kept their adopted markers in .swapped and used construction ordinals.
        const host = globalThis as { __AZS_S?: Record<string, unknown>; __AZS?: { delivered?: WeakSet<Comment>; swapped?: WeakSet<Comment> } };
        host.__AZS_S = { ':0': { d: 7 }, ':1': { d: 'ocean' } };
        if (host.__AZS?.delivered)
        {
            host.__AZS.swapped = host.__AZS.delivered;
            delete host.__AZS.delivered;
        }
        client = true;
        hydrate(app, root);
        await vi.waitFor(() => expect(root.textContent).toBe('8.00BAY'));
        expect(root.firstElementChild).toBe(main);
        expect(fetch.mock.calls.slice(2).map(([id]) => id).sort()).toEqual(['A', 'B']);
    });

    it.each([
        ['malformed JSON', '['],
        ['a null outcome', '{"1.0":null}'],
        ['an unknown outcome field', '{"1.0":{"unknown":"lost-data"}}'],
        ['both a value and an error', '{"1.0":{"d":7,"e":"lost-data"}}']
    ])('recovers only the affected ready range with %s', async (_kind, payload) =>
    {
        const App = compileComponent(`${ declarations } component App(props) { <main>${ a }${ b }</main> }`, 'App');
        let client = false;
        const fetch = vi.fn((id: string) => Promise.resolve(id === 'A' ? 'ocean' : client ? 8 : 7));
        const app = () => App({ fetch, choose: vi.fn(), formatA: String, formatB: (n: number) => n.toFixed(2) }) as HTMLElement;
        const html = await new Response(renderToStream(app)).text();
        const wire = document.createElement('div');
        wire.innerHTML = html;
        const seed = wire.querySelector('script[data-azs-seed="1"]')!;
        expect(seed.textContent).toContain('7');
        seed.textContent = payload;
        const root = await streamPage(wire.innerHTML);
        const served = root.querySelector('button');
        client = true;
        hydrate(app, root);
        await vi.waitFor(() => expect(root.textContent).toBe('ocean8.00'));
        expect(root.querySelector('button')).toBe(served);
        expect(fetch.mock.calls.slice(2)).toEqual([['B']]);
    });
});
