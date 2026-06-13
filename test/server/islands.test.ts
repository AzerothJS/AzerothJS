// Islands end to end: the server emits anchored, prop-carrying markup
// inside a static shell; hydrateIslands revives exactly the islands -
// adopting their existing DOM - and never touches the shell.

import { describe, it, expect, vi } from 'vitest';
import { createSignal } from '@azerothjs/reactivity';
import { h, hydrateIslands } from '@azerothjs/renderer';
import { renderToString, island } from '@azerothjs/server';

interface CounterProps extends Record<string, unknown>
{
    start: number;
    label: string;
}

/** The island component - identical module on server and client. */
function Counter(props: Record<string, unknown>): HTMLElement
{
    const { start, label } = props as CounterProps;
    const [n, setN] = createSignal(start);
    return h('button', { onClick: () => setN(v => v + 1) }, () => `${ label }: ${ n() }`);
}

function Page(): HTMLElement
{
    return h('main', {},
        h('h1', {}, 'Static shell'),
        island('/islands/counter', Counter, { start: 5, label: 'Count' }),
        h('footer', {}, 'static footer')
    );
}

describe('island() on the server', () =>
{
    it('emits an anchor with src, escaped JSON props, and the rendered markup', () =>
    {
        const html = renderToString(() => Page());

        expect(html).toContain('data-azeroth-island="/islands/counter"');
        expect(html).toContain('data-azeroth-props="{&quot;start&quot;:5,&quot;label&quot;:&quot;Count&quot;}"');
        expect(html).toContain('Count: 5');
        expect(html).toContain('Static shell');
        expect(html).toContain('static footer');
    });

    it('rejects props JSON cannot carry, naming the offender', () =>
    {
        expect(() => renderToString(() =>
            island('/islands/bad', Counter, { start: 1, label: 'x', onDone: () => undefined })
        )).toThrow(/prop "onDone" is a function/);
    });

    it('is transparent in a pure client render', () =>
    {
        const el = island('/islands/counter', Counter, { start: 2, label: 'CSR' });

        expect(el.tagName).toBe('BUTTON');
        expect(el.textContent).toBe('CSR: 2');
        el.click();
        expect(el.textContent).toBe('CSR: 3');
    });
});

describe('hydrateIslands() on the client', () =>
{
    it('revives islands in place and leaves the shell untouched', async () =>
    {
        const container = document.createElement('div');
        container.innerHTML = renderToString(() => Page());

        const shellHeading = container.querySelector('h1')!;
        const button = container.querySelector('button')!;
        expect(button.textContent).toBe('Count: 5');

        const revived = await hydrateIslands({
            '/islands/counter': async () => ({ default: Counter })
        }, container);

        expect(revived).toBe(1);
        // The SAME nodes, now live.
        expect(container.querySelector('h1')).toBe(shellHeading);
        expect(container.querySelector('button')).toBe(button);

        button.click();
        expect(button.textContent).toBe('Count: 6');
    });

    it('leaves unknown islands static with a warning', async () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const container = document.createElement('div');
        container.innerHTML = renderToString(() => Page());

        const revived = await hydrateIslands({}, container);

        expect(revived).toBe(0);
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toContain('no loader registered');

        // Still the server markup, still inert.
        const button = container.querySelector('button')!;
        button.click();
        expect(button.textContent).toBe('Count: 5');

        warn.mockRestore();
    });

    it('skips nested anchors - islands do not nest', async () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const container = document.createElement('div');
        container.innerHTML =
            '<span data-azeroth-island="/outer" data-azeroth-props="{}">' +
            '<span data-azeroth-island="/inner" data-azeroth-props="{}"></span>' +
            '</span>';

        const revived = await hydrateIslands({
            '/inner': async () => ({ default: Counter })
        }, container);

        expect(revived).toBe(0);
        const messages = warn.mock.calls.map(c => String(c[0]));
        expect(messages.some(m => m.includes('do not nest'))).toBe(true);
        expect(messages.some(m => m.includes('no loader registered for "/outer"'))).toBe(true);

        warn.mockRestore();
    });
});
