// @vitest-environment happy-dom
//
// Behavioral coverage for Dynamic (dynamic.ts): rendering the selected
// component, swapping on component change, null => nothing, props pass-through,
// untracked props (a prop change does NOT rebuild the tree), and disposal of the
// old component on swap.
import { describe, it, expect } from 'vitest';
import { createSignal, createRoot, createResource, h, render, Dynamic, Portal, Suspense } from 'azerothjs';
import { subscriberCount } from 'azerothjs/internal';

type Comp = (props: Record<string, unknown>) => HTMLElement;

function mount(component: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(component, container);
    return container;
}

const Home: Comp = () => h('div', { class: 'home' }, 'Home');
const About: Comp = () => h('div', { class: 'about' }, 'About');

describe('Dynamic', () =>
{
    it('renders the component returned by the getter', () =>
    {
        const [view] = createSignal<Comp>(Home);
        const container = mount(() => h('main', {}, Dynamic({ component: view })));
        expect(container.querySelector('.home')).not.toBeNull();
        container.remove();
    });

    it('swaps the rendered component when the getter changes', () =>
    {
        const [view, setView] = createSignal<Comp>(Home);
        const container = mount(() => h('main', {}, Dynamic({ component: view })));
        expect(container.querySelector('.home')).not.toBeNull();

        setView(() => About);
        expect(container.querySelector('.about')).not.toBeNull();
        expect(container.querySelector('.home')).toBeNull();
        container.remove();
    });

    it('a TAG STRING renders the element - through h(), so SVG tags land in their namespace', () =>
    {
        // The icon-component shape: data-driven [tag, attrs] pairs projected from markup.
        const [tag, setTag] = createSignal<string>('path');
        const container = mount(() => h('svg', {},
            Dynamic({ component: tag, props: () => ({ d: 'M0 0L4 4' }) })));

        const path = container.querySelector('path');
        expect(path).not.toBeNull();
        expect(path?.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(path?.getAttribute('d')).toBe('M0 0L4 4');

        setTag('circle');
        expect(container.querySelector('path')).toBeNull();
        expect(container.querySelector('circle')?.namespaceURI).toBe('http://www.w3.org/2000/svg');
        container.remove();
    });

    it('renders nothing when the component is null', () =>
    {
        const [view, setView] = createSignal<Comp | null>(Home);
        const container = mount(() => h('main', {}, Dynamic({ component: view })));
        expect(container.querySelector('.home')).not.toBeNull();

        setView(() => null);
        expect(container.textContent).toBe('');
        expect(container.querySelector('.home')).toBeNull();

        // Re-selecting a component restores rendering.
        setView(() => About);
        expect(container.querySelector('.about')).not.toBeNull();
        container.remove();
    });

    it('passes props from the props getter to the component', () =>
    {
        const Greeter: Comp = (props) => h('p', { class: 'greet' }, `Hello ${ props.name as string }`);
        const [view] = createSignal<Comp>(Greeter);
        const container = mount(() => h('main', {}, Dynamic({
            component: view,
            props: () => ({ name: 'Ada' })
        })));
        expect(container.querySelector('.greet')!.textContent).toBe('Hello Ada');
        container.remove();
    });

    it('does NOT rebuild the tree when only the props signal changes (props untracked)', () =>
    {
        let builds = 0;
        const Counter: Comp = (props) =>
        {
            builds++;
            return h('p', { class: 'c' }, `start=${ props.start as number }`);
        };
        const [view] = createSignal<Comp>(Counter);
        const [start, setStart] = createSignal(0);
        const container = mount(() => h('main', {}, Dynamic({
            component: view,
            props: () => ({ start: start() })
        })));
        expect(builds).toBe(1);
        const el = container.querySelector('.c')!;

        // Changing the props signal must not re-subscribe Dynamic (props read untracked).
        setStart(99);
        expect(builds).toBe(1);
        expect(container.querySelector('.c')).toBe(el);
        // Initial prop value is retained (Dynamic doesn't re-pass props).
        expect(el.textContent).toBe('start=0');
        container.remove();
    });

    it('disposes the old component\'s effects on swap (no leak)', () =>
    {
        const [tick] = createSignal(0);
        const Live: Comp = () => h('p', { class: 'live' }, () => `t=${ tick() }`);
        const [view, setView] = createSignal<Comp>(Live);
        const container = mount(() => h('main', {}, Dynamic({ component: view })));
        expect(subscriberCount(tick)).toBe(1);

        setView(() => Home);
        // Live's effect torn down on swap.
        expect(subscriberCount(tick)).toBe(0);
        container.remove();
    });

    it('works directly inside a table (no wrapper element)', () =>
    {
        createRoot((dispose) =>
        {
            const Row: Comp = () => h('tr', {}, h('td', {}, 'cell'));
            const [view] = createSignal<Comp>(Row);
            const tbody = h('tbody', {}, Dynamic({ component: view }));
            expect(tbody.querySelector('tbody > tr')).not.toBeNull();
            dispose();
        });
    });
});

// The contract matrix: every shape `component` can resolve to, every swap direction, and
// the equality guarantee.
describe('Dynamic - contract matrix', () =>
{
    it('a re-evaluation resolving to the SAME tag keeps the element (no teardown churn)', () =>
    {
        const [count, setCount] = createSignal(1);
        const container = mount(() => h('main', {},
            Dynamic({ component: () => (count() > 0 ? 'p' : 'span') })));
        const first = container.querySelector('p');
        expect(first).not.toBeNull();

        // The dependency changes; the RESOLVED tag does not. The subtree must survive.
        setCount(2);
        expect(container.querySelector('p')).toBe(first);
        container.remove();
    });

    it('a re-evaluation resolving to the SAME component keeps the tree and its state', () =>
    {
        let builds = 0;
        const Tracked: Comp = () =>
        {
            builds++;
            return h('p', { class: 'tracked' }, 'x');
        };
        const [flag, setFlag] = createSignal(0);
        const container = mount(() => h('main', {},
            Dynamic({ component: () => (flag() >= 0 ? Tracked : null) })));
        expect(builds).toBe(1);

        setFlag(1);
        expect(builds).toBe(1);
        container.remove();
    });

    it('swaps between an HTML tag and an SVG tag re-namespace correctly, both directions', () =>
    {
        const [tag, setTag] = createSignal('div');
        const container = mount(() => h('main', {}, Dynamic({ component: tag })));
        expect(container.querySelector('div')?.namespaceURI).toBe('http://www.w3.org/1999/xhtml');

        setTag('path');
        expect(container.querySelector('path')?.namespaceURI).toBe('http://www.w3.org/2000/svg');

        setTag('div');
        expect(container.querySelector('div')?.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
        container.remove();
    });

    it('swaps between a component and a tag string, both directions', () =>
    {
        const [view, setView] = createSignal<Comp | string>(Home);
        const container = mount(() => h('main', {}, Dynamic({ component: view })));
        expect(container.querySelector('.home')).not.toBeNull();

        setView('em');
        expect(container.querySelector('.home')).toBeNull();
        expect(container.querySelector('em')).not.toBeNull();

        setView(() => About);
        expect(container.querySelector('em')).toBeNull();
        expect(container.querySelector('.about')).not.toBeNull();
        container.remove();
    });

    it('undefined and false resolve to nothing (falsy tolerance), and recover', () =>
    {
        const [view, setView] = createSignal<unknown>(undefined);
        const container = mount(() => h('main', {}, Dynamic({ component: view as () => Comp | null })));
        expect(container.textContent).toBe('');

        setView(false);
        expect(container.textContent).toBe('');

        setView(() => Home);
        expect(container.querySelector('.home')).not.toBeNull();
        container.remove();
    });

    it('a truthy non-component value (a pre-created node) throws a NAMED error, not a cryptic one', () =>
    {
        const node = document.createElement('div');
        expect(() => mount(() => h('main', {},
            Dynamic({ component: (() => node) as unknown as () => Comp })))).toThrow(/<Dynamic>/);
    });

    it('nests: a Dynamic component that itself renders a tag Dynamic', () =>
    {
        const [innerTag, setInnerTag] = createSignal('i');
        const Outer: Comp = () => h('section', { class: 'outer' }, Dynamic({ component: innerTag }));
        const [view] = createSignal<Comp>(Outer);
        const container = mount(() => h('main', {}, Dynamic({ component: view })));
        expect(container.querySelector('.outer i')).not.toBeNull();

        setInnerTag('b');
        expect(container.querySelector('.outer i')).toBeNull();
        expect(container.querySelector('.outer b')).not.toBeNull();
        container.remove();
    });

    it('survives rapid alternating swaps without leaking the torn-down branches', () =>
    {
        const [tick] = createSignal(0);
        const Live: Comp = () => h('p', { class: 'live' }, () => `t=${ tick() }`);
        const [view, setView] = createSignal<Comp | string>(Live);
        const container = mount(() => h('main', {}, Dynamic({ component: view })));

        for (let round = 0; round < 10; round++)
        {
            setView('span');
            setView(() => Live);
        }
        expect(container.querySelector('.live')).not.toBeNull();
        // Exactly ONE live subscription: every torn-down branch released its effect.
        expect(subscriberCount(tick)).toBe(1);
        container.remove();
    });

    it('props accepts a PLAIN OBJECT as well as a thunk - one contract for markup and manual', () =>
    {
        const [tag] = createSignal('p');
        const container = mount(() => h('main', {},
            Dynamic({ component: tag, props: { class: 'obj-props' } }),
            Dynamic({ component: tag, props: () => ({ class: 'fn-props' }) })));
        expect(container.querySelector('.obj-props')).not.toBeNull();
        expect(container.querySelector('.fn-props')).not.toBeNull();
        container.remove();
    });

    it('THUNK props are LIVE per read: a child tracking a prop updates in place, no rebuild', () =>
    {
        // The parity invariant: the SAME child must get the same prop liveness through
        // Dynamic as it gets from direct markup getter props. A frozen swap-time snapshot
        // here pins tab content to stale data.
        let builds = 0;
        const [label, setLabel] = createSignal('first');
        const Reader: Comp = (props) =>
        {
            builds++;
            return h('p', { class: 'reader' }, () => String(props.label));
        };
        const container = mount(() => h('main', {}, Dynamic({
            component: () => Reader,
            props: () => ({ label: label() })
        })));
        const element = container.querySelector('.reader');
        expect(element?.textContent).toBe('first');

        setLabel('second');
        expect(container.querySelector('.reader')).toBe(element);
        expect(element?.textContent).toBe('second');
        expect(builds).toBe(1);
        container.remove();
    });

    it('swapping the props THUNK itself (same selection) is as live as the values inside it', () =>
    {
        // The markup shape `props={ dark() ? darkProps : lightProps }`: the property read
        // evaluates the conditional in the READER's scope, so which-thunk is as live as
        // the values a single thunk closes over. An implementation that captures the
        // mount-time thunk pins the child to it forever.
        let builds = 0;
        const [dark, setDark] = createSignal(false);
        const lightProps = (): Record<string, unknown> => ({ label: 'light' });
        const darkProps = (): Record<string, unknown> => ({ label: 'dark' });
        const Reader: Comp = (props) =>
        {
            builds++;
            return h('p', { class: 'themed' }, () => String(props.label));
        };
        const container = mount(() => h('main', {}, Dynamic({
            component: () => Reader,
            get props()
            {
                return dark() ? darkProps : lightProps;
            }
        })));
        const element = container.querySelector('.themed');
        expect(element?.textContent).toBe('light');

        setDark(true);
        expect(container.querySelector('.themed')).toBe(element);
        expect(element?.textContent).toBe('dark');
        expect(builds).toBe(1);
        container.remove();
    });

    it('a component that renders Dynamic selecting ITSELF composes recursively', () =>
    {
        const Nest: Comp = (props) =>
        {
            const depth = props.depth as number;
            return h('div', { class: `d${ depth }` },
                depth > 0 ? Dynamic({ component: () => Nest, props: { depth: depth - 1 } }) : 'leaf');
        };
        const container = mount(() => h('main', {}, Dynamic({ component: () => Nest, props: { depth: 3 } })));
        expect(container.querySelector('.d3 .d2 .d1 .d0')?.textContent).toBe('leaf');
        container.remove();
    });

    it('disposing the OWNER tears down the active branch - escaped Portal DOM included - and later selections are inert', () =>
    {
        const PortalView: Comp = () =>
            Portal({ children: () => h('div', { class: 'owner-escaped' }, 'out') });
        createRoot((dispose) =>
        {
            const [view, setView] = createSignal<Comp>(PortalView);
            h('main', {}, Dynamic({ component: view }));
            expect(document.body.querySelector('.owner-escaped')).not.toBeNull();

            dispose();
            expect(document.body.querySelector('.owner-escaped')).toBeNull();

            // A selection change after disposal must be inert: no render, no throw.
            setView(() => Home);
            expect(document.body.querySelector('.home')).toBeNull();
        });
    });

    it('the thunk props KEY SET is fixed at swap - values live, shape swap-scoped', () =>
    {
        const [extra, setExtra] = createSignal(false);
        let seen: string[] = [];
        const Prober: Comp = (props) =>
        {
            seen = Object.keys(props);
            return h('p', {}, 'x');
        };
        const container = mount(() => h('main', {}, Dynamic({
            component: () => Prober,
            props: () => (extra() ? { a: 1, b: 2 } : { a: 1 })
        })));
        expect(seen).toEqual(['a']);

        // The shape does not grow mid-life; a new shape needs a new selection (or key).
        setExtra(true);
        expect(seen).toEqual(['a']);
        container.remove();
    });

    it('composes with Portal: the selection escapes inline flow, and the swap disposes the escaped DOM', () =>
    {
        const PortalView: Comp = () =>
            Portal({ children: () => h('div', { class: 'escaped' }, 'out') });
        const [view, setView] = createSignal<Comp>(PortalView);
        const container = mount(() => h('main', {}, Dynamic({ component: view })));

        expect(document.body.querySelector('.escaped')).not.toBeNull();
        expect(container.querySelector('.escaped')).toBeNull();

        // The swap's branch dispose must reach the ESCAPED DOM, not just the co-range.
        setView(() => Home);
        expect(document.body.querySelector('.escaped')).toBeNull();
        expect(container.querySelector('.home')).not.toBeNull();
        container.remove();
    });

    it('composes with Suspense + a resource-backed component - the lazy() pattern needs no Dynamic support', async () =>
    {
        // Laziness is a COMPONENT concern: a lazy view is a stable component identity whose
        // body reads a resource; Suspense (explicit `on`) owns the pending state. Dynamic
        // only selects - which is exactly why its contract needs no async awareness.
        let release!: (value: string) => void;
        const gate = new Promise<string>((resolve) =>
        {
            release = resolve;
        });

        const container = mount(() =>
        {
            const load = createResource(() => gate);
            const LazyView: Comp = () => h('p', { class: 'lazy' }, () => load.data() ?? '');
            return h('main', {}, Suspense({
                on: [load],
                fallback: () => h('p', { class: 'wait' }, 'loading'),
                children: () => Dynamic({ component: () => LazyView })
            }));
        });

        expect(container.querySelector('.wait')).not.toBeNull();
        expect(container.querySelector('.lazy')).toBeNull();

        release('ready');
        await gate;
        await Promise.resolve();

        expect(container.querySelector('.wait')).toBeNull();
        expect(container.querySelector('.lazy')?.textContent).toBe('ready');
        container.remove();
    });
});
