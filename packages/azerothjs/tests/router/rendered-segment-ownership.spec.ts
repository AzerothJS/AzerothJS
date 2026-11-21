// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import {
    batch, createEffect, createMemoryHistory, createRouter, createSignal, h, Outlet, render, Routes, Show,
    useMatch, useParams, useQuery, useRoute, useSearch
} from 'azerothjs';
import type { Route, RouteComponent, Router } from 'azerothjs';

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
const hosts: HTMLElement[] = [];
afterEach(() =>
{
    for (const host of hosts.splice(0))
    {
        render(() => h('div', {}), host);
    }
});

function open(view: () => HTMLElement): HTMLElement
{
    const host = document.createElement('div');
    hosts.push(host);
    render(view, host);
    return host;
}

describe('rendered route ownership', () =>
{
    it('holds segment parameters until presentation commits, keeps raw URL live and updates only the retained owner', async () =>
    {
        const chunk = Promise.withResolvers<RouteComponent>();
        const guard = Promise.withResolvers<boolean>();
        let router!: Router;
        let sample!: () => unknown[];
        let foreign!: Router;
        const labels: Array<string | undefined> = [];
        const layouts: Array<string | undefined> = [];
        const host = open(() =>
        {
            foreign = createRouter({ routes: [{ path: '/palette/:size', component: () => h('i', {}, 'Palette') }],
                history: createMemoryHistory('/palette/mini') });
            router = createRouter({ history: createMemoryHistory('/gallery/paper/wide?tone=red'), routes: [{
                path: '/gallery', component: ({ children }) =>
                {
                    const params = useParams();
                    createEffect(() =>
                    {
                        layouts.push(params().size);
                    });
                    return h('section', {}, Outlet({ children }));
                },
                children: [
                    { path: 'paper/:size', component: () =>
                    {
                        const params = useParams();
                        const explicit = useParams(router);
                        const match = useMatch();
                        const route = useRoute(router);
                        const query = useQuery();
                        const search = useSearch();
                        const palette = useParams(foreign);
                        createEffect(() =>
                        {
                            labels.push(params().size);
                        });
                        sample = () => [explicit().size, match()?.params.size, route().params.size, route().pathname,
                            route().hash, query().tone, search().tone, palette().size];
                        return h('p', {}, 'Paper');
                    } },
                    { path: 'linen/:size', guard: () => guard.promise, lazy: () => chunk.promise }
                ]
            }] });
            return h('main', {}, Routes({ router, transition: 'fade', transitionDuration: 1000 }));
        });
        const initial = host.querySelector('p');
        const layout = host.querySelector('section');
        router.navigate('/gallery/paper/wide?tone=rose#swatch');
        expect(host.querySelector('p')).toBe(initial);
        expect(sample()).toEqual(['wide', 'wide', 'wide', '/gallery/paper/wide', '#swatch', 'rose', 'rose', 'mini']);
        router.navigate('/gallery/linen/compact?tone=blue#swatch');
        expect(labels).toEqual(['wide']);
        expect(layouts).toEqual(['wide']);
        guard.resolve(true);
        await flush();
        expect(router.match()?.params.size).toBe('compact');
        expect(host.querySelector('p')).toBe(initial);
        foreign.navigate('/palette/tall');
        expect(sample()).toEqual(['wide', 'wide', 'wide', '/gallery/linen/compact', '#swatch', 'blue', 'blue', 'tall']);
        expect(labels).toEqual(['wide']);
        expect(layouts).toEqual(['wide']);
        chunk.resolve(() => h('p', {}, 'Linen'));
        await flush();
        expect(host.querySelector('section')).toBe(layout);
        expect(host.textContent).toContain('Linen');
        expect(labels).toEqual(['wide']);
        expect(layouts).toEqual(['wide', 'compact']);
    });

    it('keeps a layout live when a batch samples its hooks between navigation away and back', () =>
    {
        let router!: Router;
        let sample!: () => unknown[];
        let galleries = 0;
        const host = open(() =>
        {
            router = createRouter({ history: createMemoryHistory('/gallery/wide'), routes: [
                { path: '/gallery', component: ({ children }) =>
                {
                    galleries++;
                    const params = useParams();
                    const match = useMatch();
                    const query = useQuery();
                    sample = () => [params().size, match()?.matched[0]?.path, query().tone];
                    return h('section', {}, Outlet({ children }));
                }, children: [{ path: ':size', component: () => h('p', {}, 'Gallery tile') }] },
                { path: '/palette/:size', component: () => h('p', {}, 'Palette tile') }
            ] });
            return h('main', {}, Routes({ router }));
        });
        const section = host.querySelector('section');
        const tile = host.querySelector('p');
        batch(() =>
        {
            router.navigate('/palette/mini');
            expect(sample().slice(0, 2)).toEqual(['wide', '/gallery']);
            router.navigate('/gallery/wide?tone=green');
        });
        expect(host.querySelector('section')).toBe(section);
        expect(host.querySelector('p')).toBe(tile);
        expect(sample()).toEqual(['wide', '/gallery', 'green']);
        router.navigate('/gallery/compact?tone=blue');
        expect(sample()).toEqual(['compact', '/gallery', 'blue']);
        expect(galleries).toBe(1);
    });

    it('a structural router may expose an intermediate match without retiring the still-mounted layout', () =>
    {
        let size!: () => string | undefined;
        let constructions = 0;
        const routes: Route[] = [
            { path: '/gallery', component: ({ children }) =>
            {
                constructions++;
                const match = useMatch();
                size = () => match()?.params.size;
                return h('section', {}, Outlet({ children }));
            }, children: [{ path: ':size', component: () => h('i', {}, 'Tile') }] },
            { path: '/palette/:size', component: () => h('i', {}, 'Palette') }
        ];
        const at = (path: string): Router => createRouter({ history: createMemoryHistory(path), routes });
        const original = at('/gallery/wide');
        const away = at('/palette/mini').match();
        const later = at('/gallery/compact').match();
        const [current, setCurrent] = createSignal(original.match());
        const structural: Router = { ...original, match: current };
        const host = open(() => h('main', {}, Routes({ router: structural })));
        const layout = host.querySelector('section');
        batch(() =>
        {
            setCurrent(away);
            expect(structural.match()?.params.size).toBe('mini');
            expect(size()).toBe('wide');
            setCurrent(original.match());
        });
        expect(host.querySelector('section')).toBe(layout);
        setCurrent(later);
        expect(size()).toBe('compact');
        expect(constructions).toBe(1);
    });

    it('a leaving layout keeps its last displayed child when an intermediate sibling never mounted', () =>
    {
        const made: string[] = [];
        let selection!: () => string | undefined;
        const tile = (caption: string): RouteComponent => () =>
        {
            made.push(caption);
            return h('p', {}, caption);
        };
        const routes: Route[] = [
            { path: '/gallery', component: ({ children }) =>
            {
                const match = useMatch();
                selection = () => match()?.route.name;
                return h('section', {}, Outlet({ children }));
            }, children: [
                { path: 'paper', name: 'Paper', component: tile('Paper') },
                { path: 'linen', name: 'Linen', component: tile('Linen') }
            ] },
            { path: '/palette', component: ({ children }) => h('aside', {}, Outlet({ children })),
                children: [{ path: 'tile', name: 'Palette', component: tile('Palette') }] }
        ];
        const at = (path: string): Router => createRouter({ history: createMemoryHistory(path), routes });
        const original = at('/gallery/paper');
        const middle = at('/gallery/linen').match();
        const final = at('/palette/tile').match();
        const [current, setCurrent] = createSignal(original.match());
        const structural: Router = { ...original, match: current };
        const host = open(() => h('main', {}, Routes({ router: structural, transition: 'fade', transitionDuration: 1000 })));
        const departing = host.querySelector('section');
        expect(selection()).toBe('Paper');
        batch(() =>
        {
            setCurrent(middle);
            expect(structural.match()?.route.name).toBe('Linen');
            selection();
            setCurrent(final);
        });
        expect(made).toEqual(['Paper', 'Palette']);
        expect(host.querySelector('section')).toBe(departing);
        expect(departing?.textContent).toBe('Paper');
        expect(host.querySelector('aside')?.textContent).toBe('Palette');
        expect(selection()).toBe('Paper');
    });

    it('identifies the same static leaf under distinct parent parameters and retains its deferred child context', () =>
    {
        const branches: Array<{ size: () => string | undefined; reveal: () => void }> = [];
        let router!: Router;
        const host = open(() =>
        {
            router = createRouter({ history: createMemoryHistory('/gallery/wide/tile'), routes: [{
                path: '/gallery/:size', component: ({ children }) => h('section', {}, Outlet({ children })),
                children: [{ path: 'tile', component: () =>
                {
                    const params = useParams();
                    const [openDetail, setOpenDetail] = createSignal(false);
                    branches.push({ size: () => params().size, reveal: () => setOpenDetail(true) });
                    return h('article', {}, 'Tile', Show({ when: openDetail, children: () =>
                    {
                        const scoped = useParams(router);
                        return h('small', {}, () => scoped().size);
                    } }));
                } }]
            }] });
            return h('main', {}, Routes({ router, transition: 'fade', transitionDuration: 1000 }));
        });
        const outgoing = host.querySelector('article')!;
        router.navigate('/gallery/compact/tile');
        expect(branches).toHaveLength(2);
        expect(branches.map(branch => branch.size())).toEqual(['wide', 'compact']);
        branches[0]!.reveal();
        branches[1]!.reveal();
        expect(outgoing.querySelector('small')?.textContent).toBe('wide');
        expect(Array.from(host.querySelectorAll('article small'), item => item.textContent)).toEqual(['wide', 'compact']);
        router.navigate('/gallery/wide/tile');
        expect(branches).toHaveLength(3);
        expect(branches.map(branch => branch.size())).toEqual(['wide', 'compact', 'wide']);
    });

    it.each([true, false])('constructs one incoming descendant across an outgoing nested Outlet (cold=%s)', async cold =>
    {
        const chunk = Promise.withResolvers<RouteComponent>();
        const made: string[] = [];
        const leaf = (label: string): RouteComponent => () =>
        {
            made.push(label);
            return h('p', {}, label);
        };
        const layout = (name: string): RouteComponent => ({ children }) => h('section', { 'data-layout': name }, Outlet({ children }));
        let router!: Router;
        const host = open(() =>
        {
            router = createRouter({ history: createMemoryHistory('/paper/tile'), routes: [
                { path: '/paper', component: layout('paper'), children: [{ path: 'tile', component: leaf('Paper tile') }] },
                { path: '/linen', component: layout('linen'), children: [
                    cold ? { path: 'tile', lazy: () => chunk.promise } : { path: 'tile', component: leaf('Linen tile') }
                ] }
            ] });
            return h('main', {}, Routes({ router, transition: 'fade', transitionDuration: 1000 }));
        });
        const departing = host.querySelector('section')!;
        router.navigate('/linen/tile');
        if (cold)
        {
            expect(made).toEqual(['Paper tile']);
            chunk.resolve(leaf('Linen tile'));
            await flush();
        }
        expect(made).toEqual(['Paper tile', 'Linen tile']);
        expect(departing.textContent).toBe('Paper tile');
        expect(host.querySelector('[data-layout="linen"]')?.textContent).toBe('Linen tile');
        expect(host.querySelectorAll('p')).toHaveLength(2);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        expect(departing.classList.contains('fade-leave-to')).toBe(true);
        departing.dispatchEvent(new Event('transitionend'));
        expect(host.querySelectorAll('p')).toHaveLength(1);
    });
});
