// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignal, hydrate, render, renderToStream, renderToString } from 'azerothjs';
import { clearStreamPage, streamPage } from '../../azerothjs/tests/ssr/stream-test-page.ts';
import { compileComponent } from './conformance/executor.ts';

afterEach(clearStreamPage);

const badge = `component Badge(props) {
    props.built();
    mount { props.mounted(); }
    effect { props.pulse(); props.tick(); }
    <b>Badge</b>
}`;

const slot = '<Badge {...props}/>';
const cases = [
    { name: 'named slot', body: '<Show when={ props.slot } let={ slot }>{ slot }</Show>',
        placement: `<Frame slot={ ${ slot } }/>`, builds: 1, shown: 1 },
    { name: 'children', body: '<Show when={ props.children } let={ slot }>{ slot }</Show>',
        placement: `<Frame>${ slot }</Frame>`, builds: 1, shown: 1 },
    { name: 'two explicit reads', body: '<Show when={ props.slot !== undefined }>{ props.slot }</Show>',
        placement: `<Frame slot={ ${ slot } }/>`, builds: 2, shown: 1 },
    { name: 'one placement', body: '<Show when={ props.children !== undefined }>{ props.children }</Show>',
        placement: `<Frame>${ slot }</Frame>`, builds: 1, shown: 1 },
    { name: 'unread slot', body: '<i>empty</i>',
        placement: `<Frame slot={ ${ slot } }/>`, builds: 0, shown: 0 },
    { name: 'derived slot hidden on mount', body: 'derived cached = props.slot; <Show when={ false }>{ cached }</Show>',
        placement: `<Frame slot={ ${ slot } }/>`, builds: 1, shown: 0 }
];

describe.each(['client render', 'hydrate'])('compiled slot ownership during %s', mode =>
{
    it.each(cases)('$name', async ({ body, placement, builds, shown }) =>
    {
        const App = compileComponent(`${ badge }
            component Frame(props) { ${ body } }
            component App(props) { <main>${ placement }</main> }`, 'App', { ssr: mode === 'hydrate' });
        const [pulse, setPulse] = createSignal(0);
        const built = vi.fn();
        const mounted = vi.fn();
        const tick = vi.fn();
        const app = () => App({ built, mounted, pulse, tick }) as HTMLElement;
        const root = document.createElement('div');
        document.body.append(root);
        if (mode === 'hydrate')
        {
            root.innerHTML = renderToString(app);
            expect(built).toHaveBeenCalledTimes(builds);
            expect(mounted).toHaveBeenCalledTimes(0);
            built.mockClear();
            const served = root.querySelector('b');
            hydrate(app, root);
            expect(root.querySelector('b')).toBe(served);
        }
        else
        {
            render(app, root);
        }

        // A detached component can have a mounted hook and a live effect even when only
        // one copy reaches the DOM. Count subscribers by giving every live copy one pulse.
        await Promise.resolve();
        tick.mockClear();
        setPulse(1);
        expect([built.mock.calls.length, mounted.mock.calls.length, tick.mock.calls.length, root.querySelectorAll('b').length])
            .toEqual([builds, builds, builds, shown]);
        render(() => document.createElement('i'), root);
        tick.mockClear();
        setPulse(2);
        expect(tick).toHaveBeenCalledTimes(0);
    });

    it('releases the previous slot on a truthy change and the last slot on hide', async () =>
    {
        const [active, setActive] = createSignal<string | null>('amber');
        const [pulse, setPulse] = createSignal(0);
        const tick = vi.fn();
        const cleaned = vi.fn();
        const App = compileComponent(`component Badge(props) {
                const label = props.label;
                effect { props.pulse(); props.tick(label); }
                cleanup { props.cleaned(label); }
                <b>{ label }</b>
            }
            component Frame(props) {
                <main><Show when={ props.active && props.slot } let={ slot }>
                    <section><input/>{ slot }</section>
                </Show></main>
            }
            component App(props) {
                <Frame active={ props.active } slot={ <Badge {...props} label={ props.active }/> }/>
            }`, 'App', { ssr: mode === 'hydrate' });
        const app = () => App({
            get active()
            {
                return active();
            },
            pulse, tick, cleaned
        }) as HTMLElement;
        const root = document.createElement('div');
        document.body.append(root);
        if (mode === 'hydrate')
        {
            root.innerHTML = renderToString(app);
            cleaned.mockClear();
            hydrate(app, root);
        }
        else
        {
            render(app, root);
        }
        const input = root.querySelector('input')!;
        input.value = 'draft';
        setActive('jade');
        expect(root.textContent).toBe('jade');
        expect(root.querySelector('input')).toBe(input);
        expect(input.value).toBe('draft');
        await Promise.resolve();
        tick.mockClear();
        setPulse(1);
        expect(tick.mock.calls.flat()).toEqual(['jade']);
        expect(cleaned.mock.calls.flat()).toEqual(['amber']);
        setActive(null);
        expect(root.querySelector('input')).toBeNull();
        tick.mockClear();
        setPulse(2);
        expect(tick).toHaveBeenCalledTimes(0);
        expect(cleaned.mock.calls.flat()).toEqual(['amber', 'jade']);
    });
});

it.each(['named slot', 'children'])('adopts the %s resource and its sibling without starting hidden requests', async shape =>
{
    const when = shape === 'named slot' ? 'props.slot' : 'props.children';
    const widget = '<Widget id="badge" load={ props.load }/>';
    const frame = shape === 'named slot' ? `<Frame slot={ ${ widget } }/>` : `<Frame>${ widget }</Frame>`;
    const App = compileComponent(`component Widget(props) {
            resource result = () => props.load(props.id);
            <article><Suspense on={ [result] } fallback={ <i>waiting</i> }><b>{ result.data() }</b></Suspense></article>
        }
        component Frame(props) { <section><Show when={ ${ when } } let={ slot }>{ slot }</Show></section> }
        component App(props) { <main>${ frame }<Widget id="feed" load={ props.load }/></main> }`, 'App');
    const load = vi.fn((id: string) => Promise.resolve('from ' + id));
    const app = () => App({ load }) as HTMLElement;
    const root = await streamPage(renderToStream(app));
    const nodes = [...root.querySelectorAll('b')];
    expect(nodes.map(node => node.textContent)).toEqual(['from badge', 'from feed']);
    expect(load.mock.calls.flat()).toEqual(['badge', 'feed']);
    load.mockClear();
    hydrate(app, root);
    const hydrated = root.querySelectorAll('b');
    expect(hydrated).toHaveLength(2);
    expect(hydrated[0]).toBe(nodes[0]);
    expect(hydrated[1]).toBe(nodes[1]);
    expect(root.textContent).toBe('from badgefrom feed');
    expect(load.mock.calls).toEqual([]);
});
