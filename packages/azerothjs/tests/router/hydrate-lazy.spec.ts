// @vitest-environment happy-dom
//
// Hydrating a <Routes> whose matched chunk has NOT landed yet.
//
// This is the case that proved the render context had the wrong lifetime. <Routes> cannot
// adopt on its first effect run while the chunk is cold, so it returns having claimed
// nothing; the run that finally adopts is scheduled by the reactive system, after hydrate()'s
// synchronous window has closed. That run used to see 'dom', build fresh DOM instead of an
// adoption descriptor, and throw where it tried to adopt - as an unhandled rejection, because
// hydrate()'s own catch had long since returned. The server's markup stayed on screen wired
// to nothing.
//
// Markup cannot tell an adopted page from an abandoned one - the nodes look identical, which
// is exactly why the bug shipped. So the oracle here is a real CLICK, and the warm-component
// control runs first: if the harness cannot deliver a click at all (delegated handlers are
// attached at the document, so a detached container silently swallows them) the control fails
// and the lazy case's failure means nothing.
import { describe, it, expect, vi } from 'vitest';
import {
    batch, catchError, createEffect, createSignal, h, hydrate, render, renderToString, createRouter, createMemoryHistory,
    Dynamic, For, Match, onCleanup, Routes, Show, Switch, Transition, TransitionGroup
} from 'azerothjs';
import type { Route, RouteComponent, Router } from 'azerothjs';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A counter whose button is the liveness probe: inert markup cannot move the text. */
function CounterPage(): HTMLElement
{
    const [count, setCount] = createSignal(0);
    return h('section', {},
        h('span', { id: 'out' }, () => `count:${ count() }`),
        h('button', { id: 'go', onClick: () => setCount(count() + 1) }, 'inc'));
}

/** A structurally DIFFERENT page, for the divergence case. */
function OtherPage(): HTMLElement
{
    const [count, setCount] = createSignal(0);
    return h('article', {},
        h('span', { id: 'out' }, () => `other:${ count() }`),
        h('button', { id: 'go', onClick: () => setCount(count() + 1) }, 'inc'));
}

/**
 * Server markup for the routed tree. The server always has the component in hand - the
 * loader pass pre-resolves lazy chunks before it renders - so the table here uses the
 * resolved form and the emitted HTML is byte-identical to the lazy app's. That keeps the
 * only difference between these tests on the CLIENT, where the defect lives.
 */
function ssrPage(component: RouteComponent): HTMLElement
{
    const routes: Route[] = [{ path: '/', component }];
    const router = createRouter({ routes, history: createMemoryHistory('/') });
    const container = document.createElement('div');
    container.innerHTML = renderToString(() => h('div', { id: 'app' }, Routes({ router })));
    // Delegated handlers live on the document; a detached container never sees a click.
    document.body.appendChild(container);
    return container;
}

/** A client router whose chunk stays pending until the returned release is called. */
function coldRouter(component: RouteComponent): { router: Router; land: () => void }
{
    let release!: (chunk: { default: RouteComponent }) => void;
    const chunk = new Promise<{ default: RouteComponent }>((resolve) =>
    {
        release = resolve;
    });
    const router = createRouter({
        routes: [{ path: '/', lazy: () => chunk }],
        history: createMemoryHistory('/')
    });
    return { router, land: (): void => release({ default: component }) };
}

const mount = (router: Router, container: HTMLElement): void =>
    hydrate(() => h('div', { id: 'app' }, Routes({ router })), container);

const click = (container: HTMLElement): void =>
    container.querySelector<HTMLButtonElement>('#go')!.click();

const readout = (container: HTMLElement): string | null =>
    container.querySelector('#out')!.textContent;

describe('<Routes> hydration with a deferred chunk', () =>
{
    it.each(['Switch', 'Dynamic', 'Transition', 'TransitionGroup', 'reactive child'] as const)(
        'adopts the served node of a cold %s and updates it', async control =>
        {
            const [shown, setShown] = createSignal(true);
            const item = (): HTMLElement => h('p', { id: 'item' }, 'visible');
            const pages = {
                Switch: () => Switch({ children: [Match({ when: shown, children: item })] }),
                Dynamic: () => Dynamic({ component: () => shown() ? item : null }),
                Transition: () => Transition({ when: shown, children: item }),
                TransitionGroup: () => TransitionGroup({ each: () => shown() ? [1] : [], key: id => id, children: item }),
                'reactive child': () => h('article', {}, 'item: ', () => shown() ? item() : '')
            };
            const page = pages[control];
            const container = ssrPage(page);
            const serverNode = container.querySelector('#item');
            expect(serverNode).not.toBeNull();
            const { router, land } = coldRouter(page);
            mount(router, container);
            land();
            await flush();
            expect(container.querySelector('#item')).toBe(serverNode);
            setShown(false);
            expect(container.querySelector('#item')).toBeNull();
            container.remove();
        }
    );

    it('keeps older sibling updates and explicit application batches in their normal order', async () =>
    {
        const [awake, setAwake] = createSignal(false);
        const [value, setValue] = createSignal(0);
        let siblingValue = 'before';
        const observed: string[] = [];
        const sibling = document.createElement('div');
        render(() =>
        {
            createEffect(() =>
            {
                if (awake())
                {
                    siblingValue = 'after';
                }
            });
            return Show({ when: awake, children: () => h('p', {}, 'neighbor') });
        }, sibling);
        const page = () => Show({ when: true, children: () => h('p', { id: 'adopted' }, 'page') });
        const container = ssrPage(page);
        const served = container.querySelector('#adopted');
        const { router, land } = coldRouter(() =>
        {
            setAwake(true);
            batch(() =>
            {
                createEffect(() =>
                {
                    observed.push(`${ siblingValue }:${ value() }`);
                });
                setValue(1);
            });
            return page();
        });
        mount(router, container);
        land();
        await flush();
        expect(container.querySelector('#adopted')).toBe(served);
        expect(sibling.textContent).toBe('neighbor');
        expect(observed).toEqual(['after:1']);
        container.remove();
    });

    it.each([false, true])('disposes every rejected route subtree before mismatch recovery (nested: %s)', async nested =>
    {
        const [version, setVersion] = createSignal(0);
        const observed: number[] = [];
        const disposals: number[] = [];
        let builds = 0;
        const replacement = (): HTMLElement =>
        {
            const id = ++builds;
            onCleanup(() => disposals.push(id));
            createEffect(() =>
            {
                version();
                observed.push(id);
            });
            return h('article', { id: 'replacement' }, 'new page');
        };
        const asTree = (leaf: Route): Route[] => nested
            ? [{ path: '/p', component: ({ children }) => h('main', {}, children), children: [leaf] }]
            : [leaf];
        const path = nested ? 'x' : '/';
        const url = nested ? '/p/x' : '/';
        const server = createRouter({
            routes: asTree({ path, component: () => h('p', {}, 'served') }),
            history: createMemoryHistory(url)
        });
        const container = document.createElement('div');
        container.innerHTML = renderToString(() => h('div', { id: 'app' }, Routes({ router: server })));
        let release!: (chunk: { default: RouteComponent }) => void;
        const chunk = new Promise<{ default: RouteComponent }>(resolve =>
        {
            release = resolve;
        });
        const client = createRouter({ routes: asTree({ path, lazy: () => chunk }), history: createMemoryHistory(url) });
        mount(client, container);
        release({ default: replacement });
        await flush();
        expect(container.querySelector('#replacement')?.textContent).toBe('new page');
        expect(disposals).toEqual([1]);
        observed.length = 0;
        setVersion(1);
        expect(observed).toEqual([2]);
    });

    it.each(['Show', 'For', 'Switch', 'Dynamic', 'Transition', 'TransitionGroup'] as const)(
        'releases rejected %s branches and previously adopted rows before rebuilding', async control =>
        {
            const [version, setVersion] = createSignal(0);
            const observed: number[] = [];
            const disposed: number[] = [];
            let builds = 0;
            const wrap = (leaf: (row: number) => HTMLElement) =>
            {
                const last = () => leaf(2);
                switch (control)
                {
                    case 'Show': return Show({ when: true, children: last });
                    case 'Switch': return Switch({ children: [Match({ when: true, children: last })] });
                    case 'Dynamic': return Dynamic({ component: () => last });
                    case 'Transition': return Transition({ when: true, children: last });
                    case 'For': return For({ each: [1, 2], key: row => row, children: row => leaf(row()) });
                    case 'TransitionGroup': return TransitionGroup({ each: [1, 2], key: row => row, children: leaf });
                }
            };
            const container = ssrPage(() => wrap(() => h('p', {}, 'served')));
            const { router, land } = coldRouter(() => wrap(row =>
            {
                const id = ++builds;
                onCleanup(() => disposed.push(id));
                createEffect(() =>
                {
                    version();
                    observed.push(id);
                });
                return row === 1 ? h('p', {}, 'served') : h('article', {}, 'current');
            }));
            mount(router, container);
            land();
            await flush();
            const count = control === 'For' || control === 'TransitionGroup' ? 2 : 1;
            expect(builds).toBe(2 * count);
            expect(disposed).toEqual(count === 2 ? [2, 1] : [1]);
            expect(container.querySelectorAll('article')).toHaveLength(1);
            observed.length = 0;
            setVersion(1);
            expect(observed).toEqual(count === 2 ? [3, 4] : [2]);
            container.remove();
        }
    );

    it('does not let a closed route ticket replace a newer mount', async () =>
    {
        let builds = 0;
        const container = ssrPage(CounterPage);
        const { router, land } = coldRouter(() =>
        {
            builds++;
            return h('article', {}, 'abandoned');
        });
        mount(router, container);
        const newNode = h('main', {}, 'replacement');
        render(() => newNode, container);
        land();
        await flush();
        expect(builds).toBe(0);
        expect(container.firstChild).toBe(newNode);
        container.remove();
    });

    it.each([false, true])('adopts a route whose markers the parser placed in an implied tbody (cold: %s)', async cold =>
    {
        const clickRow = vi.fn();
        const page = () => h('tr', { id: 'routed-row', onClick: clickRow }, h('td', {}, 'route'));
        const table = (router: Router) => h('table', {}, h('tr', {}, h('td', {}, 'first')), Routes({ router }));
        const ready = () => createRouter({ routes: [{ path: '/', component: page }], history: createMemoryHistory('/') });
        const container = document.createElement('div');
        document.body.appendChild(container);
        container.innerHTML = renderToString(() => table(ready()));
        const served = container.querySelector('#routed-row');
        expect(served?.parentNode?.nodeName).toBe('TBODY');
        const held = coldRouter(page);
        hydrate(() => table(cold ? held.router : ready()), container);
        held.land();
        await flush();
        const adopted = container.querySelector<HTMLElement>('#routed-row');
        expect(adopted).toBe(served);
        adopted?.click();
        expect(clickRow).toHaveBeenCalledTimes(1);
        container.remove();
    });

    it('adopts the original range when a batch delays the first driver run', () =>
    {
        const page = () => Show({ when: true, children: () => h('p', { id: 'held' }, 'served') });
        const container = ssrPage(page);
        const served = container.querySelector('#held');
        batch(() =>
        {
            const router = createRouter({ routes: [{ path: '/', component: page }], history: createMemoryHistory('/') });
            mount(router, container);
        });
        expect(served).not.toBeNull();
        expect(container.querySelector('#held')).toBe(served);
        container.remove();
    });

    it('leaves the original pass available for a later cold sibling', async () =>
    {
        const [shown, setShown] = createSignal(true);
        const page = () => Show({ when: shown, children: () => h('p', {}, 'served') });
        const ready = () => createRouter({ routes: [{ path: '/', component: page }], history: createMemoryHistory('/') });
        const shell = (first: Router, second: Router) => h('main', {}, Routes({ router: first }), Routes({ router: second }));
        const container = document.createElement('div');
        container.innerHTML = renderToString(() => shell(ready(), ready()));
        const served = container.querySelectorAll('p');
        const { router, land } = coldRouter(page);
        hydrate(() => shell(ready(), router), container);
        land();
        await flush();
        expect(served).toHaveLength(2);
        expect(container.querySelectorAll('p')[0]).toBe(served[0]);
        expect(container.querySelectorAll('p')[1]).toBe(served[1]);
        setShown(false);
        expect(container.querySelectorAll('p')).toHaveLength(0);
    });

    it('keeps a replacement installed synchronously by the deferred component', async () =>
    {
        const container = ssrPage(CounterPage);
        const replacement = document.createElement('main');
        const disposed = vi.fn();
        const { router, land } = coldRouter(() =>
        {
            onCleanup(disposed);
            render(() => replacement, container);
            return h('article', {}, 'abandoned');
        });
        mount(router, container);
        land();
        await flush();
        expect(container.firstChild).toBe(replacement);
        expect(disposed).toHaveBeenCalledTimes(1);
        container.remove();
    });

    it.each([false, true])('recovers a structural mismatch inside an application error scope (cold: %s)', async cold =>
    {
        const container = ssrPage(() => Show({ when: true, children: () => h('p', {}, 'served') }));
        const client = () => Show({ when: true, children: () => h('article', {}, 'current') });
        const ready = createRouter({ routes: [{ path: '/', component: client }], history: createMemoryHistory('/') });
        const held = coldRouter(client);
        const caught = vi.fn();
        catchError(() => mount(cold ? held.router : ready, container), caught);
        held.land();
        await flush();
        expect(container.querySelector('article')?.textContent).toBe('current');
        expect(caught).not.toHaveBeenCalled();
        container.remove();
    });

    it('disposes failed settled-view construction and reports its application error once', () =>
    {
        const failure = new Error('fallback constructor');
        const disposed = vi.fn();
        const caught = vi.fn();
        const router = createRouter({ routes: [], history: createMemoryHistory('/missing') });
        const container = document.createElement('div');
        container.innerHTML = renderToString(() => Routes({ router, fallback: () => h('p', {}, 'no page') }));
        catchError(() => hydrate(() => Routes({ router, fallback: () =>
        {
            onCleanup(disposed);
            throw failure;
        } }), container), caught);
        expect(caught.mock.calls).toEqual([[failure]]);
        expect(disposed).toHaveBeenCalledTimes(1);
    });

    it('continues a row rollback when one cleanup throws and reports that failure separately', async () =>
    {
        const failedCleanup = new Error('rejected row cleanup');
        const caught = vi.fn();
        const disposed: number[] = [];
        const rows = (row: (id: number) => HTMLElement) =>
            For({ each: [1, 2], key: id => id, children: id => row(id()) });
        const container = ssrPage(() => rows(() => h('p', {}, 'served')));
        const { router, land } = coldRouter(() => rows(id =>
        {
            onCleanup(() =>
            {
                disposed.push(id);
                if (id === 2)
                {
                    throw failedCleanup;
                }
            });
            return id === 1 ? h('p', {}, 'served') : h('article', {}, 'new');
        }));
        catchError(() => mount(router, container), caught);
        land();
        await flush();
        expect(container.querySelector('article')?.textContent).toBe('new');
        expect(disposed).toEqual([2, 1]);
        expect(caught.mock.calls).toEqual([[failedCleanup]]);
        container.remove();
    });

    it('routes a deferred application error to its original scope once', async () =>
    {
        const failure = new Error('page construction failed');
        const caught = vi.fn();
        const disposed = vi.fn();
        const container = ssrPage(CounterPage);
        const { router, land } = coldRouter(() =>
        {
            onCleanup(disposed);
            throw failure;
        });
        catchError(() => mount(router, container), caught);
        land();
        await flush();
        expect(caught.mock.calls).toEqual([[failure]]);
        expect(disposed).toHaveBeenCalledTimes(1);
        container.remove();
    });

    it('CONTROL: a warm component hydrates into a live page', async () =>
    {
        const container = ssrPage(CounterPage);
        const router = createRouter({
            routes: [{ path: '/', component: CounterPage }],
            history: createMemoryHistory('/')
        });

        mount(router, container);
        await flush();

        click(container);
        expect(readout(container)).toBe('count:1');
    });

    it('a cold chunk still adopts, and the adopted page is live', async () =>
    {
        const container = ssrPage(CounterPage);
        const serverSection = container.querySelector('section');
        const { router, land } = coldRouter(CounterPage);

        mount(router, container);
        // Nothing has been adopted yet: the chunk is still in flight.
        land();
        await flush();

        // The server's node is ADOPTED, not replaced - so this also fails if adoption
        // degraded to a full client render.
        expect(container.querySelector('section')).toBe(serverSection);

        // The assertion that actually failed before the fix. Identical markup, dead page.
        click(container);
        expect(readout(container)).toBe('count:1');
    });

    it('a cold chunk that diverges from the server falls back to a clean client render', async () =>
    {
        // The completion barrier. A deferred adoption failure used to escape as an unhandled
        // rejection and leave the inert server markup behind; it must reach the same fallback
        // a synchronous mismatch reaches.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            const container = ssrPage(CounterPage);
            const serverSection = container.querySelector('section');
            const { router, land } = coldRouter(OtherPage);

            mount(router, container);
            land();
            await flush();

            // Scan every call: these helpers build the router outside a root, which emits its
            // own unrelated warning first.
            const messages = warn.mock.calls.map((c) => String(c[0] ?? ''));
            expect(messages.some((m) => /falling back to full client render/.test(m))).toBe(true);

            // Recovered rather than abandoned: the diverging page is mounted AND live.
            expect(container.contains(serverSection)).toBe(false);
            click(container);
            expect(readout(container)).toBe('other:1');
        }
        finally
        {
            warn.mockRestore();
        }
    });

    it('navigating after a deferred adoption renders normally, not as another adoption', async () =>
    {
        // The pass closes once adoption is done, so later re-runs of the very same effect see
        // 'dom' again. If the pass leaked, this navigation would try to adopt server markup
        // that is no longer there.
        const container = ssrPage(CounterPage);
        let release!: (chunk: { default: RouteComponent }) => void;
        const chunk = new Promise<{ default: RouteComponent }>((resolve) =>
        {
            release = resolve;
        });
        const router = createRouter({
            routes: [
                { path: '/', lazy: () => chunk },
                { path: '/other', component: OtherPage }
            ],
            history: createMemoryHistory('/')
        });

        mount(router, container);
        release({ default: CounterPage });
        await flush();

        router.navigate('/other');
        await flush();

        expect(container.querySelector('article')).not.toBeNull();
        click(container);
        expect(readout(container)).toBe('other:1');
    });
});

describe('the rest of the shell stays live while a pass is held open', () =>
{
    it('a sibling <Show> keeps swapping normally while the route waits for its chunk', async () =>
    {
        // Holding the pass open across a cold chunk is a new state this tree never had: the
        // shell is adopted and interactive while adoption is still owed elsewhere. This pins
        // that the two do not interfere - an ordinary toggle is an ordinary DOM swap, and the
        // route still adopts afterwards.
        //
        // NOT a guard against over-broad pass re-entry. A version of this fix that let EVERY
        // computation born during the pass re-enter it passes this test and the whole suite
        // too; the narrower rule below (only the ticket holder resumes) is a design choice,
        // not something this test discriminates. See the ledger.
        const [on, setOn] = createSignal(true);
        const shell = (router: Router): HTMLElement => h('div', { id: 'app' },
            Show({ when: on, children: () => h('p', { id: 'p' }, 'yes') }),
            Routes({ router }));

        const seed = createRouter({
            routes: [{ path: '/', component: CounterPage }],
            history: createMemoryHistory('/')
        });
        const container = document.createElement('div');
        container.innerHTML = renderToString(() => shell(seed));
        document.body.appendChild(container);

        const { router, land } = coldRouter(CounterPage);
        hydrate(() => shell(router), container);

        // Adopted in the synchronous window, so it is live now - while the route's chunk is
        // still in flight and the pass is still open.
        expect(container.querySelector('#p')).not.toBeNull();

        setOn(false);
        await flush();
        expect(container.querySelector('#p')).toBeNull();

        setOn(true);
        await flush();
        expect(container.querySelector('#p')).not.toBeNull();

        // And the route still adopts correctly afterwards.
        land();
        await flush();
        click(container);
        expect(readout(container)).toBe('count:1');
    });
});
