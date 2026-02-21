import { describe, it, expect, vi } from 'vitest';
import { h, onMount, onDestroy, defineComponent, destroyComponent } from '../src';

describe('onMount()', () =>
{
    it('should run after component is created', () =>
    {
        const mountFn = vi.fn();

        const App = defineComponent(() =>
        {
            onMount(mountFn);
            return h('div', {}, 'Hello');
        });

        expect(mountFn).not.toHaveBeenCalled();
        App({});
        expect(mountFn).toHaveBeenCalledTimes(1);
    });

    it('should run multiple mount hooks in order', () =>
    {
        const order: number[] = [];

        const App = defineComponent(() =>
        {
            onMount(() =>
            {
                order.push(1);
            });
            onMount(() =>
            {
                order.push(2);
            });
            onMount(() =>
            {
                order.push(3);
            });

            return h('div', {});
        });

        App({});
        expect(order).toEqual([1, 2, 3]);
    });

    it('should throw when called outside defineComponent', () =>
    {
        expect(() =>
        {
            onMount(() =>
            {});
        }).toThrow('onMount() can only be called inside a component setup function');
    });

    it('should register cleanup as destroy hook', () =>
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
});

describe('onDestroy()', () =>
{
    it('should run when component is destroyed', () =>
    {
        const destroyFn = vi.fn();

        const App = defineComponent(() =>
        {
            onDestroy(destroyFn);
            return h('div', {});
        });

        const el = App({});
        expect(destroyFn).not.toHaveBeenCalled();

        destroyComponent(el);
        expect(destroyFn).toHaveBeenCalledTimes(1);
    });

    it('should run multiple destroy hooks', () =>
    {
        const order: number[] = [];

        const App = defineComponent(() =>
        {
            onDestroy(() =>
            {
                order.push(1);
            });
            onDestroy(() =>
            {
                order.push(2);
            });
            onDestroy(() =>
            {
                order.push(3);
            });
            return h('div', {});
        });

        const el = App({});
        destroyComponent(el);
        expect(order).toEqual([1, 2, 3]);
    });

    it('should throw when called outside defineComponent', () =>
    {
        expect(() =>
        {
            onDestroy(() =>
            {});
        }).toThrow('onDestroy() can only be called inside a component setup function');
    });

    it('should run all destroy hooks and mount cleanups together', () =>
    {
        const order: string[] = [];

        const App = defineComponent(() =>
        {
            onMount(() =>
            {
                return () =>
                {
                    order.push('mount-cleanup');
                };
            });

            onDestroy(() =>
            {
                order.push('destroy-1');
            });
            onDestroy(() =>
            {
                order.push('destroy-2');
            });

            return h('div', {});
        });

        const el = App({});
        destroyComponent(el);

        expect(order).toContain('mount-cleanup');
        expect(order).toContain('destroy-1');
        expect(order).toContain('destroy-2');
    });
});
