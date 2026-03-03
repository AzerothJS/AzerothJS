import { describe, it, expect, vi } from 'vitest';
import { createSignal, h, defineComponent, destroyComponent, onMount, onDestroy } from '../../src';

describe('Lifecycle Hooks', () =>
{
    it('should run onMount after component creation', () =>
    {
        const order: string[] = [];

        const Comp = defineComponent(() =>
        {
            order.push('setup');

            onMount(() =>
            {
                order.push('mount');
            });

            const el = h('div', {});
            order.push('render');
            return el;
        });

        Comp({});
        expect(order).toEqual(['setup', 'render', 'mount']);
    });

    it('should run onDestroy when destroyComponent is called', () =>
    {
        const destroyFn = vi.fn();

        const Comp = defineComponent(() =>
        {
            onDestroy(destroyFn);
            return h('div', {});
        });

        const el = Comp({});
        destroyComponent(el);

        expect(destroyFn).toHaveBeenCalledTimes(1);
    });

    it('should handle mount returning cleanup', () =>
    {
        const cleanup = vi.fn();

        const Comp = defineComponent(() =>
        {
            onMount(() =>
            {
                return cleanup;
            });
            return h('div', {});
        });

        const el = Comp({});
        expect(cleanup).not.toHaveBeenCalled();

        destroyComponent(el);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('should handle timer cleanup pattern', () =>
    {
        const Comp = defineComponent(() =>
        {
            const [count, setCount] = createSignal(0);

            onMount(() =>
            {
                const id = setInterval(() =>
                {
                    setCount(prev => prev + 1);
                }, 100);

                return () => clearInterval(id);
            });

            return h('p', {}, () => `${ count() }`);
        });

        const el = Comp({});
        expect(el.textContent).toBe('0');

        destroyComponent(el);
    });

    it('should not crash on double destroy', () =>
    {
        const destroyFn = vi.fn();

        const Comp = defineComponent(() =>
        {
            onDestroy(destroyFn);
            return h('div', {});
        });

        const el = Comp({});
        destroyComponent(el);
        destroyComponent(el);

        // Hooks array is cleared after first destroy
        expect(destroyFn).toHaveBeenCalledTimes(1);
    });

    it('should run multiple hooks in order', () =>
    {
        const order: string[] = [];

        const Comp = defineComponent(() =>
        {
            onMount(() =>
            {
                order.push('mount-a');
            });
            onMount(() =>
            {
                order.push('mount-b');
            });
            onDestroy(() =>
            {
                order.push('destroy-a');
            });
            onDestroy(() =>
            {
                order.push('destroy-b');
            });

            return h('div', {});
        });

        const el = Comp({});
        expect(order).toEqual(['mount-a', 'mount-b']);

        destroyComponent(el);
        expect(order).toEqual(['mount-a', 'mount-b', 'destroy-a', 'destroy-b']);
    });

    it('should handle nested components lifecycle', () =>
    {
        const order: string[] = [];

        const Child = defineComponent<{ label: string }>((props) =>
        {
            onMount(() =>
            {
                order.push(`${ props.label }:mount`);
            });
            onDestroy(() =>
            {
                order.push(`${ props.label }:destroy`);
            });
            return h('span', {}, props.label);
        });

        const Parent = defineComponent(() =>
        {
            onMount(() =>
            {
                order.push('parent:mount');
            });
            onDestroy(() =>
            {
                order.push('parent:destroy');
            });

            return h('div', {},
                Child({ label: 'child-1' }),
                Child({ label: 'child-2' })
            );
        });

        Parent({});
        expect(order).toEqual([
            'child-1:mount',
            'child-2:mount',
            'parent:mount'
        ]);
    });

    it('should work with destroyComponent on non-component elements', () =>
    {
        const el = h('div', {}, 'plain element');

        // Should not throw
        expect(() => destroyComponent(el)).not.toThrow();
    });
});
