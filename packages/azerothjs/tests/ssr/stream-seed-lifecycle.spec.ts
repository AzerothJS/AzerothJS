import { afterEach, describe, expect, it, vi } from 'vitest';
import { cached, createContext, createResource, createRoot, createSignal, h, hydrate, hydrateIslands,
    island, onCleanup, provideContext, render, renderToStream, Show, Suspense, TransitionGroup, useContext } from 'azerothjs';
import type { MountNode, Resource } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';
import { clearStreamPage, streamPage } from './stream-test-page.ts';

afterEach(() =>
{
    clearStreamPage();
    resetDataCache();
});

function boundary(on: Resource<unknown>[], children: () => MountNode): MountNode
{
    return Suspense({ on, fallback: () => h('i', {}, 'waiting'), children });
}

function showValue(resource: Resource<string>): MountNode
{
    return boundary([resource], () => h('b', {}, () => resource.data()));
}

const nextTurn = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('adopting boundaries independently of construction order', () =>
{
    it.each(['root', 'island'])('retires an unvisited seed group when a %s must be replaced', async kind =>
    {
        let client = false;
        const load = vi.fn((id: string) => Promise.resolve(id));
        const first = () => h(client ? 'article' : 'section', {}, showValue(createResource(() => load('A'))));
        const sibling = () => showValue(createResource(() => load('B')));
        const root = await streamPage(renderToStream(() => h('main', {},
            h('div', { id: 'first' }, kind === 'island' ? island('/first', first, {}) : first()),
            h('aside', {}, sibling()))));
        const store = (globalThis as typeof globalThis & { __AZS_S: Record<string, unknown> }).__AZS_S;
        const aside = root.querySelector('aside')!;
        const node = aside.querySelector('b');
        client = true;
        if (kind === 'island')
        {
            expect(await hydrateIslands({ '/first': async () => first }, root)).toBe(1);
        }
        else
        {
            hydrate(first, root.querySelector<HTMLElement>('#first')!);
        }
        expect(Object.keys(store).sort()).toEqual(['1.0', '1.l']);
        hydrate(sibling, aside);
        await vi.waitFor(() => expect(root.textContent).toBe('AB'));
        expect(aside.querySelector('b')).toBe(node);
        expect(load.mock.calls.flat()).toEqual(['A', 'B', 'A']);
        expect(Object.keys(store)).toEqual([]);
    });

    it('preserves a streamed TransitionGroup row before an eager sibling', async () =>
    {
        const load = vi.fn((id: string) => Promise.resolve(id));
        const widget = (id: string) => showValue(createResource(() => load(id)));
        const app = () => h('main', {}, TransitionGroup({ each: ['A'], key: id => id,
            children: id => h('div', {}, widget(id)) }), widget('B'));
        const root = await streamPage(renderToStream(app));
        const row = root.querySelector('b');
        expect(root.textContent).toBe('AB');
        hydrate(app, root);
        expect(root.querySelector('b')).toBe(row);
        expect(root.textContent).toBe('AB');
        expect(load.mock.calls.flat()).toEqual(['A', 'B']);
    });

    it.each(['AB', 'BA'])('hydrates two roots of one stream in %s order', async order =>
    {
        const load = vi.fn((id: string) => Promise.resolve(id));
        const widget = (id: string) => showValue(createResource(() => load(id)));
        const root = await streamPage(renderToStream(() => h('main', {},
            ...['A', 'B'].map(id => h('section', { id }, widget(id))))));
        const nodes = [...root.querySelectorAll('b')];
        expect(nodes.map(node => node.textContent)).toEqual(['A', 'B']);
        const warn = vi.spyOn(console, 'warn');
        for (const id of order)
        {
            hydrate(() => widget(id), root.querySelector<HTMLElement>('#' + id)!);
        }
        expect([...root.querySelectorAll('b')].map(node => node.textContent)).toEqual(['A', 'B']);
        expect(load).toHaveBeenCalledTimes(2);
        expect(root.querySelector('#A b')).toBe(nodes[0]);
        expect(root.querySelector('#B b')).toBe(nodes[1]);
        expect(warn.mock.calls).toEqual([]);
        for (const section of root.querySelectorAll('section'))
        {
            render(() => h('i', {}), section);
        }
    });

    it('adopts independently mounted islands when their modules resolve in reverse order', async () =>
    {
        const load = vi.fn((id: unknown) => Promise.resolve(String(id)));
        const Widget = (props: Record<string, unknown>) => h('div', {}, showValue(createResource(() => load(props.id))));
        const root = await streamPage(renderToStream(() => h('main', {},
            island('/A', Widget, { id: 'A' }), island('/B', Widget, { id: 'B' }))));
        const nodes = [...root.querySelectorAll('b')];
        const first = Promise.withResolvers<typeof Widget>();
        const secondReady = Promise.withResolvers<boolean>();
        const mounted = hydrateIslands({
            '/A': () => first.promise,
            '/B': async () => props =>
            {
                const node = Widget(props);
                secondReady.resolve(true);
                return node;
            }
        }, root);
        await secondReady.promise;
        first.resolve(Widget);
        expect(await mounted).toBe(2);
        expect([...root.querySelectorAll('b')].map(node => node.textContent)).toEqual(['A', 'B']);
        expect(root.querySelectorAll('b')[0]).toBe(nodes[0]);
        expect(root.querySelectorAll('b')[1]).toBe(nodes[1]);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('seeds an already-settled resource rendered inline inside a later continuation', async () =>
    {
        const fast = vi.fn(() => Promise.resolve('fast'));
        const slow = Promise.withResolvers<string>();
        const parent = vi.fn(() => slow.promise);
        const app = () =>
        {
            const inner = createResource(fast);
            const outer = createResource(parent);
            return h('main', {}, boundary([outer], () => h('section', {}, h('span', {}, outer.data()), showValue(inner))));
        };
        const page = streamPage(renderToStream(app));
        await nextTurn();
        slow.resolve('slow');
        const root = await page;
        const served = root.querySelector('b');
        expect(root.textContent).toBe('slowfast');
        hydrate(app, root);
        expect(root.querySelector('b')).toBe(served);
        expect(root.textContent).toBe('slowfast');
        expect([parent.mock.calls.length, fast.mock.calls.length]).toEqual([1, 1]);
    });

    it('keeps both keys in the shared cache and serves a subsequent reader without a fetch', async () =>
    {
        const fetch = vi.fn((id: string) => Promise.resolve(id));
        const family = cached('stream-seed-owner', fetch);
        const widget = (id: string) => showValue(createResource(() => id, family));
        const app = () => h('main', {}, Show({ when: true, children: () => widget('A') }), widget('B'));
        const root = await streamPage(renderToStream(app));
        expect(root.textContent).toBe('AB');
        resetDataCache();
        hydrate(app, root);
        const [a, b, dispose] = createRoot(stop => [
            createResource(() => 'A', family), createResource(() => 'B', family), stop
        ] as const);
        try
        {
            expect([root.textContent, a.data(), b.data(), fetch.mock.calls.length]).toEqual(['AB', 'A', 'B', 2]);
        }
        finally
        {
            dispose();
        }
    });

    it('indexes the full watch list and shares one resource across multiple boundaries', async () =>
    {
        const load = vi.fn((v: string) => Promise.resolve(v));
        const app = () =>
        {
            const first = createResource(() => load('first'));
            const second = createResource(() => load('second'));
            const initial = createResource(() => load('wrong'), { initialValue: 'initial' });
            return h('main', {}, boundary([initial, second, first], () => h('b', {}, () => first.data(), '/', () => second.data())),
                showValue(first), showValue(initial));
        };
        const root = await streamPage(renderToStream(app));
        const served = [...root.querySelectorAll('b')];
        expect(root.textContent).toBe('first/secondfirstinitial');
        hydrate(app, root);
        expect(root.textContent).toBe('first/secondfirstinitial');
        expect(load.mock.calls.flat()).toEqual(['first', 'second']);
        expect([...root.querySelectorAll('b')].every((b, i) => b === served[i])).toBe(true);
    });

    it('adopts a nested boundary when its parent times out on the server', async () =>
    {
        const outer = vi.fn(() => Promise.withResolvers<string>().promise);
        const inner = vi.fn(() => Promise.resolve('saved'));
        const app = () =>
        {
            const slow = createResource(outer);
            return h('main', {}, Suspense({ on: [slow], fallback: () => h('section', {}, showValue(createResource(inner))),
                children: () => h('p', {}, 'finished') }));
        };
        const root = await streamPage(renderToStream(app, { settleTimeoutMs: 50 }));
        const node = root.querySelector('b');
        expect(node?.textContent).toBe('saved');
        hydrate(app, root);
        expect(root.querySelector('b')).toBe(node);
        expect([outer.mock.calls.length, inner.mock.calls.length]).toEqual([2, 1]);
    });

    it('applies all watched seeds together before the adopted boundary renders', async () =>
    {
        const app = () =>
        {
            const a = createResource(() => Promise.resolve('A'));
            const b = createResource(() => Promise.resolve('B'));
            return h('main', {}, Show({ when: () => a.loading() || b.loading(), children: () => h('i', {}, 'fetching'),
                fallback: () => h('strong', {}, () => [a.data(), b.data()].join('/')) }),
            boundary([a, b], () => h('small', {}, 'ready')));
        };
        const root = await streamPage(renderToStream(app));
        expect(root.textContent).toBe('fetchingready');
        const served = root.querySelector('small');
        hydrate(app, root);
        expect(root.querySelector('small')).toBe(served);
        expect(root.querySelector('strong')?.textContent).toBe('A/B');
    });

    it('keeps the captured watch list when its caller edits the original array in place', async () =>
    {
        const first = Promise.withResolvers<string>();
        const second = Promise.withResolvers<string>();
        let watched!: Resource<string>[];
        let replacement!: Resource<string>;
        const root = document.createElement('div');
        document.body.append(root);
        render(() =>
        {
            const initial = createResource(() => first.promise);
            replacement = createResource(() => second.promise);
            watched = [initial];
            return boundary(watched, () => h('b', {}, 'ready'));
        }, root);
        expect(root.textContent).toBe('waiting');
        watched[0] = replacement;
        first.resolve('first');
        await nextTurn();
        expect(root.textContent).toBe('ready');
        second.resolve('second');
    });

    it.each(['length', 'name'])('diagnoses a changed boundary list %s in development', async change =>
    {
        let client = false;
        const app = () =>
        {
            const a = createResource(() => Promise.resolve('A'), { name: 'slot-A' });
            const b = createResource(() => Promise.resolve('B'), { name: 'slot-B' });
            const on = !client ? [a, b] : change === 'length' ? [a] : [b, a];
            return h('main', {}, boundary(on, () => h('b', {}, () => a.data())));
        };
        const root = await streamPage(renderToStream(app));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        client = true;
        hydrate(app, root);
        const messages = warn.mock.calls.map(([message]) => String(message)).join('\n');
        expect(messages).toMatch(/Suspense/i);
        expect(messages).toMatch(change === 'length' ? /2.*1/s : /slot-A.*slot-B|slot-B.*slot-A/s);
        await vi.waitFor(() => expect(root.textContent).toBe('A'));
    });
});

describe('seed window release', () =>
{
    it('preserves a newer shared-cache request when a later boundary adopts a reader of the same key', async () =>
    {
        let client = false;
        const requests: AbortSignal[] = [];
        const results: Array<(v: string) => void> = [];
        const family = cached('late-boundary-cache', (_id: string, signal: AbortSignal) =>
        {
            if (!client)
            {
                return Promise.resolve('server');
            }
            requests.push(signal);
            const next = Promise.withResolvers<string>();
            results.push(next.resolve);
            return next.promise;
        });
        let shared!: Resource<string>;
        const shellApp = () =>
        {
            shared = createResource(() => 'A', family);
            return h('p', {}, 'shell');
        };
        const page = () => showValue(shared);
        const root = await streamPage(renderToStream(() => h('main', {},
            h('section', { id: 'shell' }, shellApp()), h('section', { id: 'page' }, page()))));
        const shell = root.querySelector<HTMLElement>('#shell')!;
        const body = root.querySelector<HTMLElement>('#page')!;
        resetDataCache();
        client = true;
        hydrate(shellApp, shell);
        expect(requests).toHaveLength(1);
        const [other, dispose] = createRoot(stop => [createResource(() => 'A', family), stop] as const);
        try
        {
            const fresh = other.refetch();
            expect(requests).toHaveLength(2);
            hydrate(page, body);
            expect(requests[0]!.aborted).toBe(true);
            expect(requests[1]!.aborted).toBe(false);
            results[1]!('fresh');
            results[0]!('stale');
            await fresh;
            expect([other.data(), shared.data(), body.textContent]).toEqual(['fresh', 'fresh', 'fresh']);
        }
        finally
        {
            dispose();
            render(() => h('i', {}), body);
            render(() => h('i', {}), shell);
        }
    });

    it.each(['plain', 'cached'])('an explicit %s refetch before adoption waits for the new request', async kind =>
    {
        let client = false;
        const retry = Promise.withResolvers<string>();
        const load = vi.fn(() => client ? retry.promise : Promise.resolve('server'));
        const fetch = kind === 'cached' ? cached('refetch-held-seed', load) : load;
        let waiter: Promise<void> | undefined;
        let settled = false;
        const app = () =>
        {
            const item = createResource(fetch);
            if (client)
            {
                waiter = item.refetch().then(() =>
                {
                    settled = true;
                });
            }
            return h('main', {}, showValue(item));
        };
        const root = await streamPage(renderToStream(app));
        expect(root.textContent).toBe('server');
        resetDataCache();
        client = true;
        hydrate(app, root);
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(load).toHaveBeenCalledTimes(2);
        retry.resolve('new response');
        await waiter;
        expect([settled, root.textContent]).toEqual([true, 'new response']);
    });

    it.each(['untouched', 'refetch', 'source change', 'already settled'])('adopts a resource in a later root after %s', async scenario =>
    {
        let client = false;
        const pending: Array<{ signal: AbortSignal; resolve: (value: string) => void }> = [];
        const [key, setKey] = createSignal('A');
        let shared!: Resource<string>;
        const buildShell = () =>
        {
            shared = createResource(key, (_id, signal) =>
            {
                if (!client)
                {
                    return Promise.resolve('from server');
                }
                const request = Promise.withResolvers<string>();
                pending.push({ signal, resolve: request.resolve });
                return request.promise;
            });
            return h('p', {}, 'shell');
        };
        const page = () => showValue(shared);
        const root = await streamPage(renderToStream(() => h('main', {},
            h('div', { id: 'shell' }, buildShell()), h('div', { id: 'page' }, page()))));
        const shell = root.querySelector<HTMLElement>('#shell')!;
        const body = root.querySelector<HTMLElement>('#page')!;
        const served = body.querySelector('b');
        expect(served?.textContent).toBe('from server');
        client = true;
        hydrate(buildShell, shell);
        expect(pending).toHaveLength(1);
        const first = pending[0]!;
        let waiterSettled = false;
        let waiter: Promise<void> | undefined;
        if (scenario === 'refetch')
        {
            waiter = shared.refetch().then(() =>
            {
                waiterSettled = true;
            });
        }
        else if (scenario === 'source change')
        {
            setKey('B');
        }
        else if (scenario === 'already settled')
        {
            first.resolve('from client');
            await nextTurn();
        }
        hydrate(page, body);
        if (scenario === 'untouched')
        {
            expect(first.signal.aborted).toBe(true);
            expect(body.querySelector('b')).toBe(served);
            first.resolve('late client result');
            await nextTurn();
            expect([shared.data(), body.textContent]).toEqual(['from server', 'from server']);
        }
        else
        {
            if (scenario !== 'already settled')
            {
                expect(pending).toHaveLength(2);
                expect(first.signal.aborted).toBe(true);
                expect(waiterSettled).toBe(false);
                expect(pending[1]!.signal.aborted).toBe(false);
                pending[1]!.resolve('from client');
                first.resolve('stale client result');
                await waiter;
                await nextTurn();
            }
            expect([shared.data(), body.textContent]).toEqual(['from client', 'from client']);
        }
        render(() => h('i', {}), body);
        render(() => h('i', {}), shell);
    });

    it('starts an unlisted fetch in its original owner once and keeps incidental reads independent', async () =>
    {
        const context = createContext('missing');
        const [stamp, setStamp] = createSignal(1);
        const load = vi.fn(() => Promise.resolve('listed'));
        const starts: unknown[] = [];
        const cleaned = vi.fn();
        let client = false;
        const app = () =>
        {
            provideContext(context, 'provided');
            if (client)
            {
                createResource(() =>
                {
                    starts.push([useContext(context), stamp()]);
                    onCleanup(cleaned);
                    return Promise.resolve('unlisted');
                });
            }
            return h('main', {}, showValue(createResource(load)));
        };
        const root = await streamPage(renderToStream(app));
        const served = root.querySelector('b');
        client = true;
        hydrate(app, root);
        expect(starts).toEqual([['provided', 1]]);
        expect(root.querySelector('b')).toBe(served);
        expect(load).toHaveBeenCalledOnce();
        setStamp(2);
        expect(starts).toHaveLength(1);
        render(() => h('i', {}), root);
        expect(cleaned).toHaveBeenCalledOnce();
    });

    it('does not run a disposed held resource or consume a later boundary seed', async () =>
    {
        let client = false;
        const obsolete = vi.fn(() => Promise.resolve('obsolete'));
        const live = vi.fn(() => Promise.resolve('live'));
        const app = () =>
        {
            if (client)
            {
                createRoot(stop =>
                {
                    createResource(obsolete);
                    stop();
                });
            }
            return h('main', {}, showValue(createResource(live)));
        };
        const root = await streamPage(renderToStream(app));
        const served = root.querySelector('b');
        client = true;
        hydrate(app, root);
        expect([obsolete.mock.calls.length, live.mock.calls.length, root.textContent]).toEqual([0, 1, 'live']);
        expect(root.querySelector('b')).toBe(served);
    });

    it('keeps a failed seed chunk on its fallback and reports serialization failure once', async () =>
    {
        let client = false;
        const onError = vi.fn();
        const load = vi.fn(() => Promise.resolve(client ? 'client' : 9n));
        const app = () =>
        {
            const item = createResource(load);
            return h('main', {}, boundary([item], () => h('b', {}, () => String(item.data()))));
        };
        const root = await streamPage(renderToStream(app, { onError }));
        expect(root.textContent).toBe('waiting');
        expect(onError).toHaveBeenCalledOnce();
        expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(TypeError);
        const main = root.firstElementChild;
        client = true;
        hydrate(app, root);
        await vi.waitFor(() => expect(root.textContent).toBe('client'));
        expect(root.firstElementChild).toBe(main);
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('drops descendants of a failed chunk and still delivers a valid sibling', async () =>
    {
        const onError = vi.fn();
        const app = () =>
        {
            const invalid = createResource(() => Promise.resolve(1n));
            const valid = createResource(() => Promise.resolve('2 < 3 & 4'));
            return h('main', {}, boundary([invalid], () => h('section', {},
                showValue(createResource(() => Promise.resolve('nested-only'))))), showValue(valid));
        };
        const wire = await new Response(renderToStream(app, { onError })).text();
        expect(wire).not.toContain('nested-only');
        const root = await streamPage(wire);
        expect(root.textContent).toBe('waiting2 < 3 & 4');
        expect(onError).toHaveBeenCalledOnce();
    });
});
