import { describe, it, expect } from 'vitest';
import { createSignal, h, Dynamic } from '../../src';

describe('Dynamic()', () =>
{
    it('should render the initial component', () =>
    {
        const Home = () => h('div', {}, 'Home Page');
        const [view] = createSignal(Home);

        const el = Dynamic({ component: view });

        expect(el.textContent).toBe('Home Page');
    });

    it('should swap components when signal changes', () =>
    {
        const Home = () => h('div', {}, 'Home');
        const About = () => h('div', {}, 'About');
        const [view, setView] = createSignal(Home);

        const el = Dynamic({ component: view });

        expect(el.textContent).toBe('Home');

        setView(() => About);
        expect(el.textContent).toBe('About');
    });

    it('should render nothing when component is null', () =>
    {
        const [view] = createSignal<(() => HTMLElement) | null>(null);

        const el = Dynamic({ component: view });

        expect(el.textContent).toBe('');
        expect(el.children.length).toBe(0);
    });

    it('should swap from null to component', () =>
    {
        const Modal = () => h('div', {}, 'Modal Content');
        const [view, setView] = createSignal<(() => HTMLElement) | null>(null);

        const el = Dynamic({ component: view });

        expect(el.textContent).toBe('');

        setView(() => Modal);
        expect(el.textContent).toBe('Modal Content');

        setView(null);
        expect(el.textContent).toBe('');
    });

    it('should pass props to the component', () =>
    {
        const Greeting = (props: Record<string, unknown>) =>
            h('p', {}, `Hello, ${ props.name }!`);
        const [view] = createSignal(Greeting);

        const el = Dynamic({
            component: view,
            props: () => ({ name: 'Alice' })
        });

        expect(el.textContent).toBe('Hello, Alice!');
    });

    it('should handle multiple swaps', () =>
    {
        const A = () => h('div', {}, 'A');
        const B = () => h('div', {}, 'B');
        const C = () => h('div', {}, 'C');
        const [view, setView] = createSignal(A);

        const el = Dynamic({ component: view });

        expect(el.textContent).toBe('A');

        setView(() => B);
        expect(el.textContent).toBe('B');

        setView(() => C);
        expect(el.textContent).toBe('C');

        setView(() => A);
        expect(el.textContent).toBe('A');
    });
});
