// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createSignal, h, hydrate, render, renderToStream, renderToString } from 'azerothjs';
import { compileComponent } from './conformance/executor.ts';

const alpha = { id: 'alpha' };
const beta = { id: 'beta' };
const gamma = { id: 'gamma' };

function appWithBranch(tag: string, body: string, hydrate: boolean)
{
    const branch = tag === 'Show'
        ? `<Show when={ props.selected } let={ row }>${ body }</Show>`
        : `<Switch><Match when={ props.selected } let={ row }>${ body }</Match></Switch>`;
    return compileComponent(`component App(props) { <main>${ branch }</main> }`, 'App', { ssr: hydrate });
}

describe.each(['render', 'hydrate'])('compiled %s', mode =>
{
    it.each(['Show', 'Match'])('%s let handler acts on the selected record after closing', tag =>
    {
        const [selected, select] = createSignal<typeof alpha | null>(alpha);
        const handled = vi.fn();
        const App = appWithBranch(tag, '<button onClick={ () => { props.close(); props.handle(row); } }>Archive</button>', mode === 'hydrate');
        const app = () => App({
            get selected()
            {
                return selected();
            },
            close: () => select(null),
            handle: handled
        }) as HTMLElement;
        const root = document.createElement('div');
        document.body.append(root);
        if (mode === 'hydrate')
        {
            root.innerHTML = renderToString(app);
            const saved = root.querySelector('button');
            hydrate(app, root);
            expect(root.querySelector('button')).toBe(saved);
        }
        else
        {
            render(app, root);
        }
        try
        {
            const first = root.querySelector('button')!;
            select(beta);
            const live = root.querySelector('button')!;
            if (tag === 'Show')
            {
                expect(live).toBe(first);
            }
            live.click();
            expect(handled.mock.calls).toEqual([[beta]]);
            expect(root.querySelector('button')).toBeNull();
        }
        finally
        {
            render(() => h('i', {}), root);
            root.remove();
        }
    });

    it.each(['Show', 'Match'])('a parked %s let callback retains the record from its own showing', tag =>
    {
        const [selected, select] = createSignal<typeof alpha | null>(alpha);
        const parked: Array<() => typeof alpha> = [];
        const App = appWithBranch(tag, '<button onClick={ () => props.park(() => row) }>Remember</button>', mode === 'hydrate');
        const app = () => App({
            get selected()
            {
                return selected();
            },
            park: (read: () => typeof alpha) => parked.push(read)
        }) as HTMLElement;
        const root = document.createElement('div');
        document.body.append(root);
        if (mode === 'hydrate')
        {
            root.innerHTML = renderToString(app);
            const saved = root.querySelector('button');
            hydrate(app, root);
            expect(root.querySelector('button')).toBe(saved);
        }
        else
        {
            render(app, root);
        }
        try
        {
            root.querySelector('button')!.click();
            select(null);
            select(beta);
            root.querySelector('button')!.click();
            select(null);
            select(gamma);
            expect(parked.map(read => read())).toEqual([alpha, beta]);
        }
        finally
        {
            render(() => h('i', {}), root);
            root.remove();
        }
    });
});

it('a streamed Show adopts the served button and retains its unread value when the client closes it', async () =>
{
    const [selected, select] = createSignal<typeof alpha | null>(alpha);
    const handled = vi.fn();
    const App = appWithBranch('Show', '<button onClick={ () => { props.close(); props.handle(row); } }>Archive</button>', true);
    const app = () => App({
        get selected()
        {
            return selected();
        },
        close: () => select(null),
        handle: handled
    }) as HTMLElement;
    const root = document.createElement('div');
    document.body.append(root);
    root.innerHTML = await new Response(renderToStream(app)).text();
    const saved = root.querySelector('button')!;
    expect(saved.textContent).toBe('Archive');
    hydrate(app, root);
    try
    {
        expect(root.querySelector('button')).toBe(saved);
        select(beta);
        saved.click();
        expect(handled.mock.calls).toEqual([[beta]]);
    }
    finally
    {
        render(() => h('i', {}), root);
        root.remove();
    }
});
