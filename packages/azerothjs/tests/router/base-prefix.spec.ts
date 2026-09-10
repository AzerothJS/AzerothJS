// @vitest-environment happy-dom
//
// The url prefix reaches the client the way the language does: the server pins it for the
// render, stamps <html data-azeroth-base>, and a router built with no explicit base adopts it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    Form, LOADER_HANDOFF_VERSION, Link, RouterProvider, Routes, createBrowserHistory, createMemoryHistory, createRoot,
    createRouter, h, render, renderToString, useLoader
} from 'azerothjs';
import type { Route, Router } from 'azerothjs';
import { renderWithBase } from 'azerothjs/internal';

const routes: Route[] = [
    { path: '/', component: (): HTMLElement => h('p', { id: 'home' }, 'home') },
    { path: '/about', component: (): HTMLElement => h('p', { id: 'about' }, 'about') },
    { path: '/contact', component: (): HTMLElement => h('p', { id: 'contact' }, 'contact') },
    { path: '/users/:id', component: (): HTMLElement => h('p', { id: 'user' }, 'user') }
];

function stamp(base: string | null): void
{
    if (base === null)
    {
        document.documentElement.removeAttribute('data-azeroth-base');
    }
    else
    {
        document.documentElement.setAttribute('data-azeroth-base', base);
    }
}

function withRouter<T>(url: string, fn: (router: Router) => T, config: Partial<Parameters<typeof createRouter>[0]> = {}): T
{
    let out!: T;
    createRoot((dispose) =>
    {
        out = fn(createRouter({ routes, history: createMemoryHistory(url), ...config }));
        dispose();
    });
    return out;
}

afterEach(() =>
{
    stamp(null);
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('a router built with no base adopts the document stamp', () =>
{
    it('matches the prefixed url in app space and writes prefixed hrefs', () =>
    {
        stamp('/fa');
        withRouter('/fa/about', (router) =>
        {
            expect(router.match()?.route.path).toBe('/about');
            expect(router.location().pathname).toBe('/about');
            expect(router.href('/about')).toBe('/fa/about');
            expect(router.href('/')).toBe('/fa');
            expect(router.href({ pathname: '/', query: { a: '1' } })).toBe('/fa?a=1');
            expect(router.href('/#top')).toBe('/fa#top');
        });
        withRouter('/%66a/about', (router) =>
        {
            expect(router.match()?.route.path).toBe('/about');
            expect(router.location().pathname).toBe('/about');
        });
    });

    it('renders <Link> anchors under the prefix', () =>
    {
        stamp('/fa');
        const container = document.createElement('div');
        document.body.appendChild(container);
        createRoot((dispose) =>
        {
            const router = createRouter({ routes, history: createMemoryHistory('/fa/about') });
            render(() => h('div', {}, Link({ to: '/about', router, children: 'about' }), Link({ to: '/', router, children: 'home' })), container);
            const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
            expect(hrefs).toEqual(['/fa/about', '/fa']);
            dispose();
        });
    });

    it('adopts a handoff whose path is the app path, and refuses one that carries the prefix', async () =>
    {
        stamp('/fa');
        const loader = vi.fn(() => Promise.resolve('live'));
        const seeded: Route[] = [{
            path: '/about',
            loader,
            component: (): HTMLElement =>
            {
                const item = useLoader<string>();
                return h('p', { id: 'seen' }, () => item.data() ?? 'none');
            }
        }];
        const boot = (path: string): HTMLElement =>
        {
            const container = document.createElement('div');
            document.body.appendChild(container);
            const router = createRouter({
                routes: seeded,
                history: createMemoryHistory('/fa/about'),
                initialLoaderData: { version: LOADER_HANDOFF_VERSION, path, data: ['seeded'] }
            });
            render(() => RouterProvider({ router, children: () => Routes({ fallback: () => h('p', {}, 'nf') }) }), container);
            return container;
        };
        const adopted = boot('/about');
        expect(adopted.querySelector('#seen')?.textContent).toBe('seeded');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(loader).not.toHaveBeenCalled();

        boot('/fa/about');
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(loader).toHaveBeenCalled();
    });

    it('an explicit base wins, and a base that normalizes to empty opts out', () =>
    {
        stamp('/fa');
        withRouter('/fa/about', (router) =>
        {
            expect(router.match()).toBeNull();
            expect(router.href('/about')).toBe('/app/about');
        }, { base: '/app' });
        for (const optOut of ['', '/'])
        {
            withRouter('/fa/about', (router) =>
            {
                expect(router.match()).toBeNull();
                expect(router.location().pathname).toBe('/fa/about');
                expect(router.href('/about')).toBe('/about');
                expect(router.href('/')).toBe('/');
            }, { base: optOut });
        }
    });

    it.each(['//evil.example', '/fa/x', 'fa', '/pt_BR', 'https://x', '', '/\\evil'])('a stamp of %j yields no base', (junk) =>
    {
        stamp(junk);
        withRouter('/about', (router) =>
        {
            expect(router.match()?.route.path).toBe('/about');
            expect(router.href('/about')).toBe('/about');
        });
    });

    it('with no stamp the router behaves as before', () =>
    {
        withRouter('/about', (router) =>
        {
            expect(router.match()?.route.path).toBe('/about');
            expect(router.href('/about')).toBe('/about');
        });
    });
});

describe('the empty base is the identity', () =>
{
    it('keeps every root spelling as a string', () =>
    {
        withRouter('/about', (router) =>
        {
            expect(router.href('/')).toBe('/');
            expect(router.href({ pathname: '/', query: { a: '1' } })).toBe('/?a=1');
            expect(router.href('/#top')).toBe('/#top');
        });
    });

    it('navigate("/") really goes home under a browser history', () =>
    {
        history.replaceState(null, '', '/blog/post?page=2');
        createRoot((dispose) =>
        {
            const router = createRouter({ routes, history: createBrowserHistory() });
            router.navigate('/');
            expect(location.pathname).toBe('/');
            expect(location.search).toBe('');
            expect(router.location().pathname).toBe('/');
            dispose();
        });
    });
});

describe('a multi-segment base', () =>
{
    it('strips and joins every segment', () =>
    {
        withRouter('/app/v2/about', (router) =>
        {
            expect(router.match()?.route.path).toBe('/about');
            expect(router.location().pathname).toBe('/about');
            expect(router.href('/about')).toBe('/app/v2/about');
            expect(router.href('/')).toBe('/app/v2');
        }, { base: '/app/v2' });
        withRouter('/app/v2', (router) =>
        {
            expect(router.match()?.route.path).toBe('/');
        }, { base: '/app/v2' });
        withRouter('/app/v3/about', (router) =>
        {
            expect(router.match()).toBeNull();
        }, { base: '/app/v2' });
    });
});

describe('the server pin', () =>
{
    const page = (): string => renderToString(() =>
    {
        const router = createRouter({ routes, history: createMemoryHistory('/fa/about') });
        return h('div', {}, Link({ to: '/about', router, children: 'about' }), Link({ to: '/', router, children: 'home' }));
    });

    it('pins a string render, and the document stamp is never read under string mode', () =>
    {
        expect(renderWithBase('/fa', page)).toContain('href="/fa/about"');
        expect(renderWithBase('/fa', page)).toContain('href="/fa"');
        stamp('/fa');
        expect(page()).toContain('href="/about"');
    });

    it.each(['//evil.example', '/fa/x', 'fa', '/pt_BR', 'https://x', ''])('refuses %j', (junk) =>
    {
        expect(() => renderWithBase(junk, page)).toThrow(/one language tag/);
    });
});

describe('<Form> under a base', () =>
{
    function actionOf(action: string | undefined, url = '/fa/contact'): string | null
    {
        const container = document.createElement('div');
        document.body.appendChild(container);
        let out: string | null = null;
        createRoot((dispose) =>
        {
            const router = createRouter({ routes, history: createMemoryHistory(url) });
            render(() => Form({ router, ...(action !== undefined ? { action } : {}), children: h('button', {}, 'go') }), container);
            out = container.querySelector('form')?.getAttribute('action') ?? null;
            dispose();
        });
        return out;
    }

    it('posts to the page it is on', () =>
    {
        stamp('/fa');
        expect(actionOf(undefined)).toBe('/fa/contact');
        stamp(null);
        expect(actionOf(undefined, '/contact')).toBe('/contact');
    });

    it('never posts off-origin from a url whose remainder reads as an authority', () =>
    {
        stamp('/fa');
        for (const url of ['/fa//evil.example/x', '/fa/\\evil.example/x'])
        {
            expect(actionOf(undefined, url), url).not.toMatch(/^[/\\]{2}/);
        }
    });

    it('prefixes an absolute app path and leaves every other spelling alone', () =>
    {
        stamp('/fa');
        expect(actionOf('/x')).toBe('/fa/x');
        expect(actionOf('\\evil')).toBe('/fa\\evil');
        // A javascript: action never renders at all: the renderer refuses it before this rule sees it.
        for (const verbatim of ['', '?x=1', 'subscribe', 'https://other/x', '/\\evil', '//evil'])
        {
            expect(actionOf(verbatim), JSON.stringify(verbatim)).toBe(verbatim);
        }
    });
});
