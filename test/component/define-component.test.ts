import { describe, it, expect, vi } from 'vitest';
import { createSignal, h, defineComponent, destroyComponent, onMount, onDestroy } from '../../src';

describe('defineComponent()', () =>
{
    it('should create a component factory', () =>
    {
        const Hello = defineComponent(() =>
        {
            return h('div', {}, 'Hello');
        });

        const el = Hello({});
        expect(el.textContent).toBe('Hello');
    });

    it('should receive props', () =>
    {
        const Greeting = defineComponent<{ name: string }>((props) =>
        {
            return h('p', {}, `Hello, ${ props.name }!`);
        });

        const el = Greeting({ name: 'World' });
        expect(el.textContent).toBe('Hello, World!');
    });

    it('should support reactive state', () =>
    {
        const Counter = defineComponent(() =>
        {
            const [count, setCount] = createSignal(0);

            return h('div', {},
                h('span', { class: 'value' }, () => `${ count() }`),
                h('button', { onClick: () => setCount(prev => prev + 1) }, '+')
            );
        });

        const el = Counter({});
        expect(el.querySelector('.value')!.textContent).toBe('0');
    });

    it('should support onMount', () =>
    {
        const mountFn = vi.fn();

        const Comp = defineComponent(() =>
        {
            onMount(mountFn);
            return h('div', {});
        });

        Comp({});
        expect(mountFn).toHaveBeenCalledTimes(1);
    });

    it('should support onDestroy', () =>
    {
        const destroyFn = vi.fn();

        const Comp = defineComponent(() =>
        {
            onDestroy(destroyFn);
            return h('div', {});
        });

        const el = Comp({});
        expect(destroyFn).not.toHaveBeenCalled();

        destroyComponent(el);
        expect(destroyFn).toHaveBeenCalledTimes(1);
    });

    it('should support mount cleanup as destroy', () =>
    {
        const cleanupFn = vi.fn();

        const Comp = defineComponent(() =>
        {
            onMount(() =>
            {
                return cleanupFn;
            });
            return h('div', {});
        });

        const el = Comp({});
        expect(cleanupFn).not.toHaveBeenCalled();

        destroyComponent(el);
        expect(cleanupFn).toHaveBeenCalledTimes(1);
    });

    it('should isolate hooks between components', () =>
    {
        const mount1 = vi.fn();
        const mount2 = vi.fn();

        const Comp1 = defineComponent(() =>
        {
            onMount(mount1);
            return h('div', {});
        });

        const Comp2 = defineComponent(() =>
        {
            onMount(mount2);
            return h('div', {});
        });

        Comp1({});
        expect(mount1).toHaveBeenCalledTimes(1);
        expect(mount2).not.toHaveBeenCalled();

        Comp2({});
        expect(mount2).toHaveBeenCalledTimes(1);
    });

    it('should handle multiple lifecycle hooks', () =>
    {
        const order: string[] = [];

        const Comp = defineComponent(() =>
        {
            onMount(() =>
            {
                order.push('mount1');
            });
            onMount(() =>
            {
                order.push('mount2');
            });
            onDestroy(() =>
            {
                order.push('destroy1');
            });
            onDestroy(() =>
            {
                order.push('destroy2');
            });
            return h('div', {});
        });

        const el = Comp({});
        expect(order).toEqual(['mount1', 'mount2']);

        destroyComponent(el);
        expect(order).toEqual(['mount1', 'mount2', 'destroy1', 'destroy2']);
    });
});
