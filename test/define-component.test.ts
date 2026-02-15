import { describe, it, expect, vi } from 'vitest';
import { createSignal, h, onMount, onDestroy, defineComponent, destroyComponent } from '../src';

describe('defineComponent()', () =>
{
    it('should create a component that returns an HTMLElement', () =>
    {
        const Greeting = defineComponent(() =>
        {
            return h('p', {}, 'Hello');
        });

        const el = Greeting({});
        expect(el).toBeInstanceOf(HTMLElement);
        expect(el.textContent).toBe('Hello');
    });

    it('should pass props to the setup function', () =>
    {
        interface Props
        {
            name: string;
            age: number;
        }

        const UserCard = defineComponent<Props>((props) =>
        {
            return h('div', {},
                h('p', {}, `Name: ${props.name}`),
                h('p', {}, `Age: ${props.age}`),
            );
        });

        const el = UserCard({ name: 'Alice', age: 30 });
        expect(el.textContent).toContain('Name: Alice');
        expect(el.textContent).toContain('Age: 30');
    });

    it('should support reactive state inside components', () =>
    {
        const Counter = defineComponent(() =>
        {
            const [count, setCount] = createSignal(0);

            return h('div', {},
                h('span', {}, () => `${count()}`),
                h('button', { onClick: () => setCount(prev => prev + 1) }, '+'),
            );
        });

        const el = Counter({});
        expect(el.querySelector('span')?.textContent).toBe('0');

        el.querySelector('button')?.click();
        expect(el.querySelector('span')?.textContent).toBe('1');
    });

    it('should support props with reactive state', () =>
    {
        interface Props
        {
            initial: number;
        }

        const Counter = defineComponent<Props>((props) =>
        {
            const [count, setCount] = createSignal(props.initial);

            return h('div', {},
                h('span', {}, () => `${count()}`),
                h('button', { onClick: () => setCount(prev => prev + 1) }, '+'),
            );
        });

        const el = Counter({ initial: 10 });
        expect(el.querySelector('span')?.textContent).toBe('10');

        el.querySelector('button')?.click();
        expect(el.querySelector('span')?.textContent).toBe('11');
    });
});

describe('destroyComponent()', () =>
{
    it('should run destroy hooks when called', () =>
    {
        const destroyFn = vi.fn();

        const App = defineComponent(() =>
        {
            onDestroy(destroyFn);
            return h('div', {}, 'Hello');
        });

        const el = App({});
        expect(destroyFn).not.toHaveBeenCalled();

        destroyComponent(el);
        expect(destroyFn).toHaveBeenCalledTimes(1);
    });

    it('should run cleanup returned from onMount on destroy', () =>
    {
        const cleanupFn = vi.fn();

        const App = defineComponent(() =>
        {
            onMount(() =>
            {
                return cleanupFn;
            });

            return h('div', {});
        });

        const el = App({});
        expect(cleanupFn).not.toHaveBeenCalled();

        destroyComponent(el);
        expect(cleanupFn).toHaveBeenCalledTimes(1);
    });

    it('should only run destroy hooks once', () =>
    {
        const destroyFn = vi.fn();

        const App = defineComponent(() =>
        {
            onDestroy(destroyFn);
            return h('div', {});
        });

        const el = App({});
        destroyComponent(el);
        destroyComponent(el);

        expect(destroyFn).toHaveBeenCalledTimes(1);
    });

    it('should handle element with no destroy hooks', () =>
    {
        const App = defineComponent(() =>
        {
            return h('div', {}, 'No hooks');
        });

        const el = App({});
        expect(() => destroyComponent(el)).not.toThrow();
    });
});
