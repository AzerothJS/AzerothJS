// @vitest-environment happy-dom
//
// Behavioral coverage for Dynamic (dynamic.ts): rendering the selected
// component, swapping on component change, null => nothing, props pass-through,
// untracked props (a prop change does NOT rebuild the tree), and disposal of the
// old component on swap.
import { describe, it, expect } from 'vitest';
import { createSignal, createRoot, subscriberCount } from '@azerothjs/reactivity';
import { h, render, Dynamic } from '@azerothjs/renderer';

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
