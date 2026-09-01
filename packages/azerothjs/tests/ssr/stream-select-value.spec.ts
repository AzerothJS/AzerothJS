// @vitest-environment happy-dom
//
// A <select value> whose OPTIONS arrive in a LATER stream chunk.
//
// Two independent halves, and an earlier version of this comment was wrong about both.
//
// SERVER. Marking is NOT structurally impossible here, as this file once claimed. A Suspense
// boundary registers itself while the select's children are being evaluated - before the select
// serializes - and renderToStream buffers the whole main pass, so nothing has been flushed yet.
// The select therefore records its value on the boundary, and chunkFor marks the chunk's own
// options. That matters because until hydration runs, the swapped-in options are the only thing
// expressing the selection: without the mark a streamed page paints the browser's default for
// the entire swap-to-hydration gap (measured at 5.4s in a controlled Chrome run), and the DOM
// is not byte-equal to a buffered render of the same settled state.
//
// CLIENT. A chunk landing AFTER hydration is repaired by the select's own MutationObserver - the
// swap inserts options into its subtree, which is exactly what that observer watches.
import { describe, expect, it } from 'vitest';
import { Suspense, createResource, h, hydrate, renderToStream } from 'azerothjs';
import { azsRuntime } from '../../src/renderer/stream-swap.ts';

/** Applies one wire chunk the way a browser would: inert insert, then the swap call. */
function applyChunk(container: HTMLElement, chunk: string): void
{
    const holder = document.createElement('div');
    holder.innerHTML = chunk.replace(/<script>[^]*?<\/script>/g, '');
    while (holder.firstChild !== null)
    {
        container.appendChild(holder.firstChild);
    }
    const call = /__AZS\((\d+)\)/.exec(chunk);
    if (call !== null)
    {
        (globalThis as { __AZS?: (id: number) => void }).__AZS?.(Number(call[1]));
    }
}

describe('streamed options reaching a hydrated <select>', () =>
{
    it('marks the chunk\'s own options, so the swap paints correctly before hydration', async () =>
    {
        // The no-JS-yet window: the swap inserts these options directly and nothing else can
        // express the selection until the bundle hydrates.
        let resolve!: (v: string[]) => void;
        const promise = new Promise<string[]>((r) =>
        {
            resolve = r;
        });

        const App = (): HTMLElement =>
        {
            const list = createResource<string[]>(() => promise);
            return h('select', { value: 'de' },
                Suspense({
                    fallback: () => h('option', { value: '' }, 'loading'),
                    on: [list],
                    children: () => (list.data() ?? []).map((o) => h('option', { value: o }, o))
                }));
        };

        const reader = renderToStream(App).getReader();
        const dec = new TextDecoder();
        await reader.read();
        resolve(['us', 'de', 'jp']);

        let wire = '';
        for (;;)
        {
            const r = await reader.read();
            if (r.done)
            {
                break;
            }
            wire += dec.decode(r.value, { stream: true });
        }

        const template = /<template[^>]*>([\s\S]*?)<\/template>/.exec(wire);
        expect(template).not.toBeNull();
        const content = (template as RegExpExecArray)[1] as string;
        expect(content.match(/selected/g)?.length).toBe(1);
        expect(content).toContain('<option value="de" selected="">');
    });

    it('applies the value when the chunk lands after hydration', async () =>
    {
        azsRuntime();
        let resolve!: (v: string[]) => void;
        const promise = new Promise<string[]>((r) =>
        {
            resolve = r;
        });

        const App = (): HTMLElement =>
        {
            const list = createResource<string[]>(() => promise);
            return h('select', { value: 'de' },
                Suspense({
                    fallback: () => h('option', { value: '' }, 'loading'),
                    on: [list],
                    children: () => (list.data() ?? []).map((o) => h('option', { value: o }, o))
                }));
        };

        const reader = renderToStream(App).getReader();
        const dec = new TextDecoder();
        const first = await reader.read();
        const shell = dec.decode(first.value, { stream: true });
        expect(shell).toContain('azc:suspense');

        const container = document.createElement('div');
        container.innerHTML = shell.replace(/<script[^>]*>[^]*?<\/script>/g, '');
        document.body.appendChild(container);

        // Hydrate FIRST - the chunk has not landed. This writes the value intent.
        hydrate(App, container);
        const sel = container.querySelector('select') as HTMLSelectElement;
        expect(sel.options.length).toBe(1);

        // Now the chunk arrives and the swap inserts the real options.
        resolve(['us', 'de', 'jp']);
        const rest: string[] = [];
        for (;;)
        {
            const r = await reader.read();
            if (r.done)
            {
                break;
            }
            rest.push(dec.decode(r.value, { stream: true }));
        }
        for (const chunk of rest)
        {
            applyChunk(container, chunk);
        }

        // One microtask after the swap: the select own observer repairs before the next paint.
        await Promise.resolve();
        expect(sel.options.length).toBe(3);
        expect(sel.value).toBe('de');
        expect(sel.selectedIndex).toBe(1);
    });
});
