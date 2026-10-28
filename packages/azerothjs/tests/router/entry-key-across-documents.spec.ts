// @vitest-environment happy-dom
//
// A tab keeps its history entries while each reload, or a back that loads a document, evaluates
// the runtime again. The controls serve every document of the tab from one evaluation.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryAdapter, Route, RouteTransitionContext, Router, RouterConfig } from 'azerothjs';

type Runtime = typeof import('azerothjs');

const PATHS = ['/p1', '/p1b', '/p2', '/p3', '/p3x', '/p4', '/pA', '/pA2', '/pB', '/pC', '/pZ'];
const routes = (): Route[] => PATHS.map((path) => ({ path, component: () => document.createElement('div') }));
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const scrollTo = (y: number): void => window.scrollTo({ top: y, left: 0 });

async function evaluate(): Promise<Runtime>
{
    vi.resetModules();
    return await import('azerothjs');
}

/** One tab: the history outlives its documents, and each document boots a router of its own. */
class Tab
{
    public runtime: Runtime;
    public router!: Router;
    readonly #history: (runtime: Runtime) => HistoryAdapter;
    readonly #documents: boolean;
    readonly #config: Partial<RouterConfig>;
    #adapter!: HistoryAdapter;
    #dispose: () => void = () => undefined;

    constructor(runtime: Runtime, history: (runtime: Runtime) => HistoryAdapter, documents: boolean, config: Partial<RouterConfig> = {})
    {
        this.runtime = runtime;
        this.#history = history;
        this.#documents = documents;
        this.#config = config;
        this.#boot();
    }

    public get key(): string
    {
        return this.router.location().key;
    }

    public async reload(): Promise<void>
    {
        await this.#nextDocument(() => undefined);
    }

    public async backDocument(): Promise<void>
    {
        await this.#nextDocument(() => this.#adapter.back());
    }

    public close(): void
    {
        this.#dispose();
    }

    async #nextDocument(move: () => void): Promise<void>
    {
        this.#dispose();
        move();
        if (this.#documents)
        {
            this.runtime = await evaluate();
        }
        this.#boot();
    }

    #boot(): void
    {
        const runtime = this.runtime;
        this.#adapter = this.#history(runtime);
        runtime.createRoot((dispose) =>
        {
            this.#dispose = dispose;
            this.router = runtime.createRouter({ routes: routes(), history: this.#adapter, ...this.#config });
        });
    }
}

async function open(documents: boolean, url: string, config: Partial<RouterConfig> = {}): Promise<Tab>
{
    const runtime = await evaluate();
    const history = runtime.createMemoryHistory(url);
    return new Tab(runtime, () => history, documents, config);
}

beforeEach(() =>
{
    scrollTo(0);
});

for (const documents of [true, false])
{
    describe(documents ? 'entry keys when every document evaluates the runtime' : 'CONTROL: entry keys when one evaluation serves every document', () =>
    {
        it(documents ? 'a reload boots on a new evaluation of the runtime' : 'a reload boots on the same evaluation of the runtime', async () =>
        {
            const tab = await open(documents, '/p1');
            const first = tab.runtime.createRouter;
            await tab.reload();
            const same = tab.runtime.createRouter === first;
            tab.close();
            expect(same).toBe(!documents);
        });

        it('a push after a reload on the first entry gets a key of its own and scrolls to the top', async () =>
        {
            const tab = await open(documents, '/p1');
            const first = tab.key;
            await tab.reload();
            const restored = tab.key;
            scrollTo(1500);
            tab.router.navigate('/p2');
            await flush();
            const pushed = tab.key;
            const y = window.scrollY;
            tab.close();
            expect(restored).toBe(first);
            expect(pushed).not.toBe(first);
            expect(y).toBe(0);
        });

        it('no two entries share a key across reloads', async () =>
        {
            const tab = await open(documents, '/p1');
            const keys = [tab.key];
            tab.router.navigate('/p2');
            keys.push(tab.key);
            await tab.reload();
            tab.router.navigate('/p3');
            keys.push(tab.key);
            await tab.reload();
            tab.router.navigate('/p4');
            keys.push(tab.key);
            tab.close();
            expect(new Set(keys).size).toBe(keys.length);
        });

        it('a push after a reload on the third entry and two Backs scrolls to the top', async () =>
        {
            const tab = await open(documents, '/p1');
            tab.router.navigate('/p2');
            tab.router.navigate('/p3');
            await flush();
            await tab.reload();
            tab.router.back();
            await flush();
            tab.router.back();
            await flush();
            scrollTo(800);
            tab.router.navigate('/p4');
            await flush();
            const y = window.scrollY;
            tab.close();
            expect(y).toBe(0);
        });

        it('a push after two Backs that each load a document scrolls to the top', async () =>
        {
            const tab = await open(documents, '/p1');
            tab.router.navigate('/p2');
            tab.router.navigate('/p3');
            await flush();
            await tab.reload();
            await tab.backDocument();
            await tab.backDocument();
            scrollTo(800);
            tab.router.navigate('/p4');
            await flush();
            const y = window.scrollY;
            tab.close();
            expect(y).toBe(0);
        });

        it('a replace after a reload gets a key of its own and scrolls to the top', async () =>
        {
            const tab = await open(documents, '/p1');
            const first = tab.key;
            await tab.reload();
            scrollTo(1500);
            tab.router.replace('/p2');
            await flush();
            const replaced = tab.key;
            const y = window.scrollY;
            tab.close();
            expect(replaced).not.toBe(first);
            expect(y).toBe(0);
        });

        it('scrollBehavior is asked about a push after a reload', async () =>
        {
            const asked: string[] = [];
            const config: Partial<RouterConfig> = {
                scrollBehavior: ({ location }) =>
                {
                    asked.push(location.pathname);
                    return { x: 0, y: 333 };
                }
            };
            const tab = await open(documents, '/p1', config);
            await tab.reload();
            scrollTo(1500);
            tab.router.navigate('/p2');
            await flush();
            const y = window.scrollY;
            tab.close();
            expect(asked).toEqual(['/p2']);
            expect(y).toBe(333);
        });

        it('scroll: true on a push after a reload scrolls to the top', async () =>
        {
            const tab = await open(documents, '/p1');
            await tab.reload();
            scrollTo(1500);
            tab.router.navigate('/p2', { scroll: true });
            await flush();
            const y = window.scrollY;
            tab.close();
            expect(y).toBe(0);
        });

        it('the pop back across a push after a reload restores the entry it left', async () =>
        {
            const tab = await open(documents, '/p1');
            await tab.reload();
            scrollTo(400);
            tab.router.navigate('/p2');
            await flush();
            scrollTo(900);
            tab.router.back();
            await flush();
            const y = window.scrollY;
            tab.close();
            expect(y).toBe(400);
        });

        it('scroll: false on a push after a reload is spent by that push', async () =>
        {
            const tab = await open(documents, '/pZ');
            tab.router.navigate('/pA');
            await flush();
            await tab.reload();
            tab.router.navigate('/pB');
            await flush();
            await tab.reload();
            tab.router.navigate('/pC', { scroll: false });
            await flush();
            tab.router.back();
            await flush();
            scrollTo(700);
            tab.router.back();
            await flush();
            const y = window.scrollY;
            tab.close();
            // This document holds no position for /pA, so the pop lands at the top.
            expect(y).toBe(0);
        });

        it('scroll: false on a replace after a reload is spent by that replace', async () =>
        {
            const tab = await open(documents, '/pA');
            tab.router.navigate('/pB');
            await flush();
            tab.router.back();
            await flush();
            await tab.reload();
            tab.router.replace('/pA2', { scroll: false });
            await flush();
            scrollTo(700);
            tab.router.forward();
            await flush();
            const y = window.scrollY;
            tab.close();
            expect(y).toBe(0);
        });

        it('a forward pop after a scroll: false replace restores the entry it lands on', async () =>
        {
            const tab = await open(documents, '/p1');
            tab.router.navigate('/p2');
            tab.router.navigate('/p3');
            await flush();
            await tab.reload();
            tab.router.navigate('/pB');
            await flush();
            scrollTo(250);
            tab.router.navigate('/pC');
            await flush();
            tab.router.back();
            await flush();
            tab.router.back();
            await flush();
            tab.router.replace('/p3x', { scroll: false });
            await flush();
            scrollTo(700);
            tab.router.forward();
            await flush();
            const y = window.scrollY;
            tab.close();
            expect(y).toBe(250);
        });

        it('a pop is not handed the position recorded for the entry that took its key', async () =>
        {
            const tab = await open(documents, '/pA');
            tab.router.navigate('/pB');
            await flush();
            await tab.reload();
            scrollTo(500);
            tab.router.navigate('/pC');
            await flush();
            scrollTo(1200);
            tab.router.back();
            await flush();
            const atB = window.scrollY;
            tab.router.back();
            await flush();
            const atA = window.scrollY;
            tab.close();
            expect(atB).toBe(500);
            expect(atA).toBe(0);
        });

        it('go(-2) on browser history after a reload restores the entry its own position', async () =>
        {
            window.history.replaceState(null, '', '/pA');
            const tab = new Tab(await evaluate(), (runtime) => runtime.createBrowserHistory(), documents);
            await tab.reload();
            scrollTo(300);
            tab.router.navigate('/pB');
            await flush();
            scrollTo(1200);
            tab.router.navigate('/pC');
            await flush();
            window.history.go(-2);
            await flush();
            await flush();
            const at = tab.router.location().pathname;
            const y = window.scrollY;
            tab.close();
            expect(at).toBe('/pA');
            expect(y).toBe(300);
        });

        it('a key minted after a reload never repeats the key of an earlier entry replaced in place', async () =>
        {
            const tab = await open(documents, '/p1');
            tab.router.navigate('/p2');
            await flush();
            tab.router.back();
            await flush();
            tab.router.replace('/p1b');
            await flush();
            const replaced = tab.key;
            tab.router.forward();
            await flush();
            await tab.reload();
            scrollTo(600);
            tab.router.navigate('/p3');
            await flush();
            const pushed = tab.key;
            scrollTo(1200);
            tab.router.back();
            await flush();
            const atP2 = window.scrollY;
            tab.router.back();
            await flush();
            const atP1b = window.scrollY;
            tab.close();
            expect(pushed).not.toBe(replaced);
            expect(atP2).toBe(600);
            expect(atP1b).toBe(0);
        });

        it('the positional index stays right across a reload', async () =>
        {
            const tab = await open(documents, '/p1');
            tab.router.navigate('/p2');
            tab.router.navigate('/p3');
            await tab.reload();
            const deltas: number[] = [];
            tab.router.back();
            deltas.push(tab.router.location().delta);
            tab.router.back();
            deltas.push(tab.router.location().delta);
            tab.router.forward();
            deltas.push(tab.router.location().delta);
            tab.router.navigate('/p4');
            tab.router.back();
            deltas.push(tab.router.location().delta);
            tab.close();
            expect(deltas).toEqual([-1, -1, 1, -1]);
        });

        it('the positional index stays right across a back that loads a document', async () =>
        {
            const tab = await open(documents, '/p1');
            tab.router.navigate('/p2');
            tab.router.navigate('/p3');
            await tab.reload();
            await tab.backDocument();
            const deltas: number[] = [];
            tab.router.back();
            deltas.push(tab.router.location().delta);
            tab.router.forward();
            deltas.push(tab.router.location().delta);
            tab.router.forward();
            deltas.push(tab.router.location().delta);
            tab.close();
            expect(deltas).toEqual([-1, 1, 1]);
        });

        it('the transition context of a push after a reload names the new entry', async () =>
        {
            const host = document.createElement('div');
            document.body.appendChild(host);
            const seen: string[] = [];
            const transition = (context: RouteTransitionContext): null =>
            {
                seen.push(context.key);
                return null;
            };
            let runtime = await evaluate();
            const history = runtime.createMemoryHistory('/p1');
            let router!: Router;
            const mount = (): void =>
            {
                const current = runtime;
                current.render(() =>
                {
                    router = current.createRouter({ routes: routes(), history });
                    return current.Routes({ router, transition });
                }, host);
            };
            mount();
            const first = router.location().key;
            runtime.render(() => [], host);
            if (documents)
            {
                runtime = await evaluate();
            }
            mount();
            router.navigate('/p2');
            await flush();
            runtime.render(() => [], host);
            host.remove();
            expect(seen).toHaveLength(1);
            expect(seen[0]).not.toBe(first);
        });
    });
}

describe('a stamp an older build left in the tab', () =>
{
    it('a key minted beside a legacy az<n> stamp is never spelled like one, and the push scrolls to the top', async () =>
    {
        const runtime = await evaluate();
        const history = runtime.createMemoryHistory('/p1');
        history.replace('/p1', { __az: { key: 'az1', index: 0 }, state: undefined });
        const tab = new Tab(runtime, () => history, true);
        const restored = tab.key;
        scrollTo(1500);
        tab.router.navigate('/p2');
        await flush();
        const minted = tab.key;
        const y = window.scrollY;
        tab.close();
        expect(restored).toBe('az1');
        expect(minted).not.toMatch(/^az\d+$/);
        expect(y).toBe(0);
    });
});
