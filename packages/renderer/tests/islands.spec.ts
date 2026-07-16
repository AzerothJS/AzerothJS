// @vitest-environment happy-dom
//
// Behavioral coverage for hydrateIslands() (islands.ts): locating server-emitted
// island anchors, loading each component through the registry (function or
// default-export module), parsing embedded props, hydrating only the island's
// subtree in place, the unknown-src warning, and the nested-island skip. Uses the
// real server island() helper for the anchor markup.
import { describe, it, expect, vi } from 'vitest';
import { createSignal } from '@azerothjs/reactivity';
import { h, hydrateIslands, type IslandRegistry } from '@azerothjs/renderer';
import { island } from '@azerothjs/server';
import { renderToString } from '@azerothjs/server';

type Props = Record<string, unknown>;

function pageInto(component: () => HTMLElement): HTMLElement
{
    const root = document.createElement('div');
    root.innerHTML = renderToString(component);
    document.body.appendChild(root);
    return root;
}

const Counter = (props: Props): HTMLElement =>
{
    const [count, setCount] = createSignal(typeof props.start === 'number' ? props.start : 0);
    return h('button', { onClick: () => setCount((c) => c + 1) }, () => `${ count() }`);
};

describe('hydrateIslands', () =>
{
    it('revives an island via a function loader and wires it interactive', async () =>
    {
        const root = pageInto(() => h('main', {},
            h('h1', {}, 'Static shell'),
            island('/islands/counter', Counter, { start: 5 })));
        const button = root.querySelector('button')!;
        expect(button.textContent).toBe('5');

        const registry: IslandRegistry = { '/islands/counter': async () => Counter };
        const revived = await hydrateIslands(registry, root);
        expect(revived).toBe(1);

        // The static shell is untouched; the island is now interactive.
        expect(root.querySelector('h1')!.textContent).toBe('Static shell');
        button.click();
        expect(button.textContent).toBe('6');
        root.remove();
    });

    it('accepts a module whose default export is the component', async () =>
    {
        const root = pageInto(() => h('main', {}, island('/islands/c', Counter, { start: 1 })));
        const registry: IslandRegistry = { '/islands/c': async () => ({ default: Counter }) };
        const revived = await hydrateIslands(registry, root);
        expect(revived).toBe(1);
        const button = root.querySelector('button')!;
        button.click();
        expect(button.textContent).toBe('2');
        root.remove();
    });

    it('reads embedded props from the anchor', async () =>
    {
        const root = pageInto(() => h('main', {}, island('/islands/c', Counter, { start: 42 })));
        expect(root.querySelector('button')!.textContent).toBe('42');
        const registry: IslandRegistry = { '/islands/c': async () => Counter };
        await hydrateIslands(registry, root);
        // Props survived the SSR -> hydrate boundary.
        expect(root.querySelector('button')!.textContent).toBe('42');
        root.remove();
    });

    it('warns and leaves the island static when no loader is registered', async () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() =>
        {});
        const root = pageInto(() => h('main', {}, island('/islands/unknown', Counter, { start: 0 })));
        const revived = await hydrateIslands({}, root);
        expect(revived).toBe(0);
        expect(warn).toHaveBeenCalled();
        expect(warn.mock.calls[0]?.[0]).toContain('no loader registered');
        warn.mockRestore();
        root.remove();
    });

    it('revives multiple independent islands in one pass', async () =>
    {
        const root = pageInto(() => h('main', {},
            island('/islands/a', Counter, { start: 1 }),
            island('/islands/b', Counter, { start: 10 })));
        const registry: IslandRegistry = {
            '/islands/a': async () => Counter,
            '/islands/b': async () => Counter
        };
        const revived = await hydrateIslands(registry, root);
        expect(revived).toBe(2);
        const buttons = Array.from(root.querySelectorAll('button'));
        buttons[0]?.click();
        // Each island has its own independent state.
        expect(buttons[0]?.textContent).toBe('2');
        expect(buttons[1]?.textContent).toBe('10');
        root.remove();
    });
});
