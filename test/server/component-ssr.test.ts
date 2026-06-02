import { describe, it, expect, vi } from 'vitest';
import { createSignal } from '@azerothjs/reactivity';
import { h, render } from '@azerothjs/renderer';
import { defineComponent, onMount, AzerothComponent } from '@azerothjs/component';
import { renderToString } from '@azerothjs/server';

describe('defineComponent (SSR)', () =>
{
    it('serializes output but does NOT run onMount on the server', () =>
    {
        const mounted = vi.fn();
        const Counter = defineComponent<{ initial: number }>((props) =>
        {
            const [count] = createSignal(props.initial);
            onMount(mounted);
            return h('span', {}, () => `${ count() }`);
        });

        const html = renderToString(() => Counter({ initial: 5 }));
        expect(html).toBe('<span><!--[-->5<!--]--></span>');
        expect(mounted).not.toHaveBeenCalled();
    });

    it('still runs onMount in the default dom mode after an SSR render', () =>
    {
        const mounted = vi.fn();
        const Comp = defineComponent(() =>
        {
            onMount(mounted);
            return h('div', {}, 'hi');
        });

        // Server render first - must not mount.
        renderToString(() => Comp({}));
        expect(mounted).not.toHaveBeenCalled();

        // Now a real client mount - must mount exactly once.
        const container = document.createElement('div');
        render(() => Comp({}), container);
        expect(mounted).toHaveBeenCalledTimes(1);
        expect(container.innerHTML).toBe('<div>hi</div>');
    });
});

describe('AzerothComponent (SSR)', () =>
{
    it('serializes via .element without running onMount', () =>
    {
        const mounted = vi.fn();

        class Widget extends AzerothComponent
        {
            public override onMount(): void
            {
                mounted();
            }

            public override render(): HTMLElement
            {
                return h('div', { class: 'widget' }, 'w');
            }
        }

        const html = renderToString(() => new Widget({}).element);
        expect(html).toBe('<div class="widget">w</div>');
        expect(mounted).not.toHaveBeenCalled();
    });
});
