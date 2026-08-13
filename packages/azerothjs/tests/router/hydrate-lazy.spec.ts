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
import { createSignal, h, hydrate, renderToString, createRouter, createMemoryHistory, Routes, Show } from 'azerothjs';
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
