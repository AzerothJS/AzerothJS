// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { object, string } from '@azerothjs/schema';
import {
    createEffect, createMemoryHistory, createRouter, createSignal, ErrorBoundary, h, hydrate, on, Outlet, render, renderToString,
    Routes, Show, useLoader, useMatch, useParams, useRenderedMatch, useRoute
} from 'azerothjs';
import type { Getter, RouteComponent, RouteMatch, Router } from 'azerothjs';

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
const hosts: HTMLElement[] = [];
afterEach(() =>
{
    for (const host of hosts.splice(0))
    {
        render(() => h('div', {}), host);
    }
});

function host(): HTMLElement
{
    const element = document.createElement('div');
    hosts.push(element);
    return element;
}

describe('useRenderedMatch', () =>
{
    it.each(['segment', 'dispatcher'] as const)('a %s match observer stays quiet on a query-only loader-key change', async which =>
    {
        const element = host();
        let router!: Router;
        let runs = 0;
        const requested: string[] = [];
        render(() =>
        {
            router = createRouter({ history: createMemoryHistory('/gallery?tone=red'), routes: [{
                path: '/gallery', search: object({ tone: string() }), loader: async ({ query }) =>
                {
                    const tone = String(query.tone);
                    requested.push(tone);
                    return tone;
                }, component: () =>
                {
                    const selected = which === 'segment' ? useMatch() : useRenderedMatch();
                    const resource = useLoader<string>();
                    createEffect(() =>
                    {
                        selected();
                        runs++;
                    });
                    return h('p', {}, () => resource.data());
                }
            }] });
            return h('main', {}, Routes({ router }));
        }, element);
        await flush();
        const first = router.match();
        const node = element.querySelector('p');
        expect([runs, node?.textContent]).toEqual([1, 'red']);
        router.navigate('/gallery?tone=blue');
        await flush();
        expect(router.match()).toBe(first);
        expect(requested).toEqual(['red', 'blue']);
        expect(element.querySelector('p')).toBe(node);
        expect(node?.textContent).toBe('blue');
        expect(runs).toBe(1);
    });

    it('retries an opted-in Outlet boundary on a new presentation and preserves a sibling fallback', async () =>
    {
        const chunk = Promise.withResolvers<RouteComponent>();
        const element = host();
        let router!: Router;
        let caught = 0;
        let attempts = 0;
        let resets = 0;
        let unrelated = 0;
        render(() =>
        {
            router = createRouter({ history: createMemoryHistory('/gallery/paper'), routes: [{
                path: '/gallery', component: ({ children }) =>
                {
                    const rendered = useRenderedMatch();
                    return h('section', {}, ErrorBoundary({
                        children: () => Outlet({ children }),
                        fallback: (_error, reset) =>
                        {
                            caught++;
                            on([rendered], () =>
                            {
                                resets++;
                                reset();
                            }, { skipInitial: true });
                            return h('i', {}, 'Retrying caption');
                        }
                    }), ErrorBoundary({
                        children: () =>
                        {
                            unrelated++;
                            throw new Error('Independent caption');
                        },
                        fallback: () => h('aside', {}, 'Independent fallback')
                    }));
                }, children: [
                    { path: 'paper', component: () =>
                    {
                        attempts++;
                        throw new Error('Paper caption');
                    } },
                    { path: 'linen', lazy: () => chunk.promise }
                ]
            }] });
            return h('main', {}, Routes({ router }));
        }, element);
        const sibling = element.querySelector('aside');
        expect(element.querySelector('i')?.textContent).toBe('Retrying caption');
        router.navigate('/gallery/linen');
        expect(router.match()?.route.path).toBe('linen');
        expect(element.querySelector('i')?.textContent).toBe('Retrying caption');
        expect([attempts, caught, resets]).toEqual([1, 1, 0]);
        chunk.resolve(() => h('p', {}, 'Linen'));
        await flush();
        expect(element.querySelector('p')?.textContent).toBe('Linen');
        expect(element.querySelector('i')).toBeNull();
        expect(element.querySelector('aside')).toBe(sibling);
        expect([attempts, caught, resets, unrelated]).toEqual([1, 1, 1, 1]);
    });

    it('distinguishes the dispatcher selection from an animated outgoing segment', () =>
    {
        const element = host();
        let router!: Router;
        let rendered!: Getter<RouteMatch | null>;
        let local!: Getter<RouteMatch | null>;
        render(() =>
        {
            router = createRouter({ history: createMemoryHistory('/paper'), routes: [
                { path: '/paper', component: () =>
                {
                    rendered = useRenderedMatch(router);
                    local = useMatch();
                    return h('p', {}, 'Paper');
                } },
                { path: '/linen', component: () => h('p', {}, 'Linen') }
            ] });
            return h('main', {}, Routes({ router, transition: 'fade', transitionDuration: 1000 }));
        }, element);
        expect(rendered()?.route.path).toBe('/paper');
        router.navigate('/linen');
        expect(element.querySelectorAll('p')).toHaveLength(2);
        expect([local()?.route.path, rendered()?.route.path]).toEqual(['/paper', '/linen']);
    });

    it('isolates nested dispatchers and requires a matching Routes for the new hook', () =>
    {
        const element = host();
        const blank = (): HTMLElement => h('i', {}, 'Blank');
        const foreign = createRouter({ history: createMemoryHistory('/blank'), routes: [{ path: '/blank', component: blank }] });
        expect(() => useRenderedMatch(foreign)).toThrow(/Routes/i);
        let small!: Router;
        let large!: Router;
        let outer!: Getter<RouteMatch | null>;
        let inner!: Getter<RouteMatch | null>;
        render(() =>
        {
            small = createRouter({ history: createMemoryHistory('/inset'), routes: [
                { path: '/inset', component: () =>
                {
                    inner = useRenderedMatch();
                    expect(() => useRenderedMatch(foreign)).toThrow(/Routes/i);
                    return h('em', {}, 'Inset');
                } },
                { path: '/caption', component: blank }
            ] });
            large = createRouter({ history: createMemoryHistory('/gallery'), routes: [
                { path: '/gallery', component: () =>
                {
                    outer = useRenderedMatch(large);
                    return h('section', {}, Routes({ router: small }));
                } }
            ] });
            return h('main', {}, Routes({ router: large }));
        }, element);
        expect([outer()?.route.path, inner()?.route.path]).toEqual(['/gallery', '/inset']);
        small.navigate('/caption');
        expect([outer()?.route.path, inner()?.route.path]).toEqual(['/gallery', '/caption']);
    });

    it('a newly mounted second Routes stays blank while the first still displays its old selection', async () =>
    {
        const element = host();
        const chunk = Promise.withResolvers<RouteComponent>();
        const instances: Array<Getter<RouteMatch | null>> = [];
        const [showSecond, setShowSecond] = createSignal(false);
        let router!: Router;
        const page = (label: string): RouteComponent => () =>
        {
            instances.push(useRenderedMatch());
            return h('p', {}, label);
        };
        render(() =>
        {
            router = createRouter({ history: createMemoryHistory('/paper'), routes: [
                { path: '/paper', component: page('Paper') }, { path: '/linen', lazy: () => chunk.promise }
            ] });
            return h('main', {}, h('section', {}, Routes({ router })),
                h('aside', {}, Show({ when: showSecond, children: () => Routes({ router }) })));
        }, element);
        router.navigate('/linen');
        setShowSecond(true);
        expect(instances).toHaveLength(1);
        expect(instances[0]!()?.route.path).toBe('/paper');
        expect(element.querySelector('section')?.textContent).toBe('Paper');
        expect(element.querySelector('aside')?.textContent).toBe('');
        chunk.resolve(page('Linen'));
        await flush();
        expect(instances).toHaveLength(3);
        expect(instances.slice(1).map(instance => instance()?.route.path)).toEqual(['/linen', '/linen']);
        expect(element.querySelector('section')?.textContent).toBe('Linen');
        expect(element.querySelector('aside')?.textContent).toBe('Linen');
    });

    it('a held 404 fallback keeps its empty segment while the accepted destination loads', async () =>
    {
        const element = host();
        const chunk = Promise.withResolvers<RouteComponent>();
        let router!: Router;
        let sample!: () => unknown[];
        let refetch!: () => Promise<void>;
        let loads = 0;
        render(() =>
        {
            router = createRouter({ history: createMemoryHistory('/missing'), routes: [
                { path: '/gallery/:size', lazy: () => chunk.promise, loader: async () =>
                {
                    loads++;
                    return 'Gallery caption';
                } }
            ] });
            const fallback = (): HTMLElement =>
            {
                const params = useParams();
                const match = useMatch();
                const displayed = useRenderedMatch();
                const loader = useLoader<string>(router);
                const route = useRoute();
                refetch = loader.refetch;
                sample = () => [params().size, match()?.route.path, displayed()?.route.path, loader.data(), route().params.size, route().pathname];
                return h('aside', {}, 'No gallery');
            };
            return h('main', {}, Routes({ router, fallback }));
        }, element);
        const previous = element.querySelector('aside');
        expect(previous?.textContent).toBe('No gallery');
        router.navigate('/gallery/wide');
        await flush();
        expect(router.match()?.params.size).toBe('wide');
        expect(router.loaders[0]!.data()).toBe('Gallery caption');
        expect(element.querySelector('aside')).toBe(previous);
        expect(loads).toBe(1);
        await refetch();
        expect(loads).toBe(1);
        expect(sample()).toEqual([undefined, undefined, undefined, undefined, undefined, '/gallery/wide']);
        chunk.resolve(() => h('p', {}, 'Gallery'));
        await flush();
        expect(element.querySelector('aside')).toBeNull();
        expect(element.textContent).toBe('Gallery');
    });

    it.each(['missing', 'blocked'] as const)('the %s fallback has a dispatcher with null selection', kind =>
    {
        const element = host();
        const fallback = (): HTMLElement => h('p', {}, useRenderedMatch()() === null ? 'No presentation' : 'Matched');
        render(() =>
        {
            const router = createRouter({ history: createMemoryHistory(kind === 'blocked' ? '/gallery' : '/elsewhere'), routes: [
                { path: '/gallery', guard: () => false, component: () => h('i', {}, 'Gallery') }
            ] });
            return h('main', {}, Routes({ router, blocked: fallback, fallback }));
        }, element);
        expect(element.textContent).toBe('No presentation');
    });

    it('renders through a structural router supplying the pre-prototype Router surface', async () =>
    {
        const element = host();
        const page: RouteComponent = () =>
        {
            const caption = useLoader<string>();
            const params = useParams();
            return h('p', {}, () => [params().size, caption.data()].join(' '));
        };
        const raw = createRouter({ history: createMemoryHistory('/gallery/wide'), routes: [
            { path: '/gallery/:size', component: page, loader: async ({ params }) => String(params.size) + ' caption' }
        ] });
        const legacy: Router = {
            location: raw.location, match: raw.match, actionResult: raw.actionResult, csrfToken: raw.csrfToken,
            setActionResult: raw.setActionResult, state: raw.state, loaders: raw.loaders, revalidate: raw.revalidate,
            prefetch: raw.prefetch, pending: raw.pending, chainReady: raw.chainReady, focusManagement: raw.focusManagement,
            block: raw.block, navigate: raw.navigate, replace: raw.replace, back: raw.back, forward: raw.forward,
            href: raw.href
        };
        render(() => h('main', {}, Routes({ router: legacy })), element);
        await flush();
        expect(element.textContent).toBe('wide wide caption');
        legacy.navigate('/gallery/compact');
        await flush();
        expect(element.textContent).toBe('compact compact caption');
    });

    it('supplies rendered match and level parameters during SSR, adoption and later navigation', () =>
    {
        const element = host();
        const page: RouteComponent = () =>
        {
            const selected = useRenderedMatch();
            const params = useParams();
            return h('h1', {}, () => [selected()?.route.name, params().size].join(' '));
        };
        const make = (): Router => createRouter({ history: createMemoryHistory('/gallery/wide'),
            routes: [{ path: '/gallery/:size', name: 'Gallery', component: page }] });
        const app = (router: Router): HTMLElement => h('main', {}, Routes({ router }));
        const server = make();
        element.innerHTML = renderToString(() => app(server));
        const served = element.querySelector('h1');
        expect(served?.textContent).toBe('Gallery wide');
        const client = make();
        hydrate(() => app(client), element);
        expect(element.querySelector('h1')).toBe(served);
        client.navigate('/gallery/compact');
        expect(element.querySelector('h1')?.textContent).toBe('Gallery compact');
    });
});
