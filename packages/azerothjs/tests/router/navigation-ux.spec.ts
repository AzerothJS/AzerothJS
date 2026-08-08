// The navigation-UX layer (unit 5.3): guards (pass/veto/redirect, sync + async, first
// veto wins), redirect() thrown from loaders, leave blockers (push + best-effort pop),
// history stamping surfaced as location().navigationKind/delta/key, managed scrolling,
// route-change focus, and Link's prefix-aware `end` matching + reactive `to`.
import { describe, it, expect, vi } from 'vitest';
import { createRoot, createSignal, render } from 'azerothjs';
import {
    createRouter, createMemoryHistory, redirect,
    Routes, Link, matchAndLoad
} from 'azerothjs';
import type { LinkProps, Route, Router } from 'azerothjs';

const leaf = (): HTMLElement => document.createElement('div');
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function withRouter(routes: Route[], initialUrl: string, fn: (router: Router) => Promise<void> | void): Promise<void>
{
    let dispose!: () => void;
    let router!: Router;
    createRoot((d) =>
    {
        dispose = d;
        router = createRouter({ routes, history: createMemoryHistory(initialUrl) });
    });
    try
    {
        await fn(router);
    }
    finally
    {
        dispose();
    }
}

describe('history stamps: navigationKind, delta, and key ride the location payload', () =>
{
    it('keys are stable across revisits; delta reads -1/+1 for back/forward', async () =>
    {
        const routes: Route[] = [{ path: '/a', component: leaf }, { path: '/b', component: leaf }];
        await withRouter(routes, '/a', (router) =>
        {
            const keyA = router.location().key;
            router.navigate('/b');
            const keyB = router.location().key;
            expect(keyB).not.toBe(keyA);

            router.back();
            expect(router.location().key).toBe(keyA);   // the SAME entry, the same stamp
            expect(router.location().delta).toBe(-1);

            router.forward();
            expect(router.location().key).toBe(keyB);
            expect(router.location().delta).toBe(1);
            expect(router.location().navigationKind).toBe('pop');
        });
    });
});

describe('route guards: root-to-leaf, before anything renders or loads', () =>
{
    it('a passing guard chain loads and matches; loaders never start before guards pass', async () =>
    {
        const order: string[] = [];
        const routes: Route[] = [{
            path: '/g',
            component: leaf,
            guard: () =>
            {
                order.push('guard'); return true;
            },
            loader: async () =>
            {
                order.push('loader'); return 'ok';
            }
        }];
        await withRouter(routes, '/g', async (router) =>
        {
            await flush();
            expect(order).toEqual(['guard', 'loader']);
            expect(router.loaders[0]!.data()).toBe('ok');
        });
    });

    it('a veto RESTORES the previous location; the guarded route never matches', async () =>
    {
        const guard = vi.fn(() => false);
        const routes: Route[] = [
            { path: '/open', component: leaf },
            { path: '/locked', component: leaf, guard, loader: async () => 'secret' }
        ];
        await withRouter(routes, '/open', async (router) =>
        {
            router.navigate('/locked');
            await flush();
            expect(guard).toHaveBeenCalledTimes(1);
            expect(router.location().pathname).toBe('/open');       // restored
            expect(router.match()?.route.path).toBe('/open');       // never matched /locked
            expect(router.loaders[0]!.data()).toBeUndefined();      // never loaded
        });
    });

    it('a guard returning a target redirects (replace: the vetoed entry does not survive)', async () =>
    {
        const routes: Route[] = [
            { path: '/home', component: leaf },
            { path: '/login', component: leaf },
            { path: '/admin', component: leaf, guard: () => '/login' }
        ];
        await withRouter(routes, '/home', async (router) =>
        {
            router.navigate('/admin');
            await flush();
            expect(router.location().pathname).toBe('/login');

            router.back();  // the /admin entry was REPLACED by /login - back lands on /home
            expect(router.location().pathname).toBe('/home');
        });
    });

    it('an ASYNC guard holds the navigation (pending true, old match intact) until it settles', async () =>
    {
        let release!: (verdict: boolean) => void;
        const hold = new Promise<boolean>((resolve) =>
        {
            release = resolve;
        });
        const routes: Route[] = [
            { path: '/from', component: leaf },
            { path: '/slow', component: leaf, guard: () => hold }
        ];
        await withRouter(routes, '/from', async (router) =>
        {
            router.navigate('/slow');
            expect(router.pending()).toBe(true);
            expect(router.match()?.route.path).toBe('/from');   // held

            release(true);
            await flush();
            expect(router.match()?.route.path).toBe('/slow');
            expect(router.pending()).toBe(false);
        });
    });

    it('guards compose down the chain - the parent veto wins before the child runs', async () =>
    {
        const childGuard = vi.fn(() => true);
        const routes: Route[] = [
            { path: '/safe', component: leaf },
            {
                path: '/parent', component: leaf, guard: () => false,
                children: [{ path: 'child', component: leaf, guard: childGuard }]
            }
        ];
        await withRouter(routes, '/safe', async (router) =>
        {
            router.navigate('/parent/child');
            await flush();
            expect(childGuard).not.toHaveBeenCalled();
            expect(router.location().pathname).toBe('/safe');
        });
    });
});

describe('redirect() from a loader', () =>
{
    it('a loader that throws redirect() turns the navigation into the target', async () =>
    {
        const routes: Route[] = [
            { path: '/users', component: leaf },
            {
                path: '/users/:id', component: leaf,
                loader: async ({ params }) =>
                {
                    if (params.id === 'gone')
                    {
                        // eslint-disable-next-line @typescript-eslint/only-throw-error -- redirect() IS the documented throwable sentinel
                        throw redirect('/users');
                    }
                    return params.id;
                }
            }
        ];
        await withRouter(routes, '/users/gone', async (router) =>
        {
            await flush();
            expect(router.location().pathname).toBe('/users');
        });
    });

    it('matchAndLoad surfaces guard and loader redirects for the server 302', async () =>
    {
        const guarded: Route[] = [{ path: '/admin', component: leaf, guard: () => '/login' }];
        expect(await matchAndLoad(guarded, new URL('http://local/admin')))
            .toEqual({ redirect: '/login', replace: true });

        const throwing: Route[] = [{
            path: '/old', component: leaf, loader: async () =>
            {
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- redirect() IS the documented throwable sentinel
                throw redirect('/new', { replace: false });
            }
        }];
        expect(await matchAndLoad(throwing, new URL('http://local/old')))
            .toEqual({ redirect: '/new', replace: false });

        // A guard VETO is a DISTINCT blocked result (a 403), never null - collapsing it into
        // null was the SSR authorization bypass (a renderer treated null as "render anyway").
        const vetoed: Route[] = [{ path: '/locked', component: leaf, guard: () => false, loader: async () => 'x' }];
        expect(await matchAndLoad(vetoed, new URL('http://local/locked'))).toEqual({ blocked: true, status: 403 });

        // No route matched -> a distinct not-found result (a real 404), also not null.
        expect(await matchAndLoad(guarded, new URL('http://local/nope'))).toEqual({ notFound: true });
    });
});

describe('leave blockers', () =>
{
    it('a sync false blocks the navigation; unregistering lets it through', async () =>
    {
        const routes: Route[] = [{ path: '/a', component: leaf }, { path: '/b', component: leaf }];
        await withRouter(routes, '/a', async (router) =>
        {
            const unblock = router.block(() => false);
            router.navigate('/b');
            expect(router.location().pathname).toBe('/a');

            unblock();
            router.navigate('/b');
            expect(router.location().pathname).toBe('/b');
        });
    });

    it('an async blocker HOLDS the navigation and commits only on allow', async () =>
    {
        let release!: (allowed: boolean) => void;
        const routes: Route[] = [{ path: '/a', component: leaf }, { path: '/b', component: leaf }];
        await withRouter(routes, '/a', async (router) =>
        {
            router.block(() => new Promise<boolean>((resolve) =>
            {
                release = resolve;
            }));
            router.navigate('/b');
            expect(router.location().pathname).toBe('/a'); // held

            release(true);
            await flush();
            expect(router.location().pathname).toBe('/b');
        });
    });

    it('a blocked BACK is undone best-effort (the URL returns to where the user was)', async () =>
    {
        const routes: Route[] = [{ path: '/a', component: leaf }, { path: '/b', component: leaf }];
        await withRouter(routes, '/a', async (router) =>
        {
            router.navigate('/b');
            router.block(() => false);
            router.back();
            await flush();
            expect(router.location().pathname).toBe('/b'); // the pop was undone
        });
    });
});

describe('managed scrolling', () =>
{
    it('push scrolls to top by default; scroll:false leaves it alone; config off disables', async () =>
    {
        const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
        try
        {
            const routes: Route[] = [{ path: '/a', component: leaf }, { path: '/b', component: leaf }];
            await withRouter(routes, '/a', async (router) =>
            {
                router.navigate('/b');
                await flush();
                expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0 });

                scrollTo.mockClear();
                router.navigate('/a', { scroll: false });
                await flush();
                expect(scrollTo).not.toHaveBeenCalled();
            });

            scrollTo.mockClear();
            let dispose!: () => void;
            let offRouter!: Router;
            createRoot((d) =>
            {
                dispose = d;
                offRouter = createRouter({ routes, history: createMemoryHistory('/a'), scroll: false });
            });
            offRouter.navigate('/b');
            await flush();
            expect(scrollTo).not.toHaveBeenCalled();
            dispose();
        }
        finally
        {
            scrollTo.mockRestore();
        }
    });

    it('scrollBehavior overrides the default decision', async () =>
    {
        const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
        try
        {
            const routes: Route[] = [{ path: '/a', component: leaf }, { path: '/b', component: leaf }];
            let dispose!: () => void;
            let router!: Router;
            createRoot((d) =>
            {
                dispose = d;
                router = createRouter({
                    routes,
                    history: createMemoryHistory('/a'),
                    scrollBehavior: () => ({ x: 0, y: 120 })
                });
            });
            router.navigate('/b');
            await flush();
            expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 120 });
            dispose();
        }
        finally
        {
            scrollTo.mockRestore();
        }
    });
});

describe('route-change focus', () =>
{
    it('after a navigation the new route content receives focus (data-route-focus wins)', async () =>
    {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const pageA = (): HTMLElement =>
        {
            const el = document.createElement('div'); el.textContent = 'a'; return el;
        };
        const pageB = (): HTMLElement =>
        {
            const el = document.createElement('div');
            const heading = document.createElement('h1');
            heading.setAttribute('data-route-focus', '');
            heading.textContent = 'b';
            el.append(heading);
            return el;
        };
        let router!: Router;
        render(() =>
        {
            router = createRouter({
                routes: [{ path: '/a', component: pageA }, { path: '/b', component: pageB }],
                history: createMemoryHistory('/a')
            });
            return Routes({ router });
        }, host);
        try
        {
            router.navigate('/b');
            await flush();
            const active = document.activeElement as HTMLElement | null;
            expect(active?.tagName).toBe('H1');
            expect(active?.hasAttribute('data-route-focus')).toBe(true);
        }
        finally
        {
            render(() => document.createElement('span'), host);
            host.remove();
        }
    });

    it('tags the fallback region for ring suppression without touching inline styles; leaves marked targets alone', async () =>
    {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const plain = (): HTMLElement =>
        {
            const el = document.createElement('div'); el.textContent = 'plain'; return el;
        };
        const marked = (): HTMLElement =>
        {
            const el = document.createElement('div');
            const heading = document.createElement('h1');
            heading.setAttribute('data-route-focus', '');
            heading.textContent = 'marked';
            el.append(heading);
            return el;
        };
        let router!: Router;
        render(() =>
        {
            router = createRouter({
                routes: [{ path: '/plain', component: plain }, { path: '/marked', component: marked }],
                history: createMemoryHistory('/marked')
            });
            return Routes({ router });
        }, host);
        try
        {
            await flush();
            router.navigate('/plain');
            await flush();
            const fallback = document.activeElement as HTMLElement | null;
            // Fallback region: tagged for the overridable ring-suppression rule, inline style untouched.
            expect(fallback?.hasAttribute('data-azeroth-route-focus-fallback')).toBe(true);
            expect(fallback?.style.outline).toBe('');
            // The rule arrives as a constructable stylesheet, not an injected <style>: an inline
            // element is refused by any strict CSP while still sitting in the DOM looking correct.
            const adopted = document.adoptedStyleSheets
                .flatMap((sheet) => Array.from(sheet.cssRules).map((rule) => rule.cssText));
            expect(adopted.some((rule) => rule.includes('data-azeroth-route-focus-fallback'))).toBe(true);
            expect(document.querySelector('style[data-azeroth-route-focus-fallback]')).toBeNull();

            router.navigate('/marked');
            await flush();
            const opted = document.activeElement as HTMLElement | null;
            // The app opted in via [data-route-focus]: the router tags nothing and touches no styles.
            expect(opted?.hasAttribute('data-route-focus')).toBe(true);
            expect(opted?.hasAttribute('data-azeroth-route-focus-fallback')).toBe(false);
            expect(opted?.style.outline).toBe('');
        }
        finally
        {
            render(() => document.createElement('span'), host);
            host.remove();
        }
    });
});

describe('Link: prefix-aware active matching + reactive to', () =>
{
    function mountLink(router: Router, props: { to: LinkProps['to']; end?: boolean }): HTMLAnchorElement
    {
        const host = document.createElement('div');
        render(() => Link({ router, activeClass: 'on', children: 'x', ...props }), host);
        return host.querySelector('a') as HTMLAnchorElement;
    }

    it('default matching is prefix-aware; end:true demands exactness; root auto-exact', async () =>
    {
        const routes: Route[] = [
            { path: '/', component: leaf },
            { path: '/users', component: leaf },
            { path: '/users/:id', component: leaf }
        ];
        await withRouter(routes, '/users/42', (router) =>
        {
            createRoot(() =>
            {
                expect(mountLink(router, { to: '/users' }).className).toBe('on');           // prefix hit
                expect(mountLink(router, { to: '/users', end: true }).className).toBe(''); // exact miss
                expect(mountLink(router, { to: '/use' }).className).toBe('');              // segment boundary holds
                expect(mountLink(router, { to: '/' }).className).toBe('');                 // root auto-exact
            });
        });
    });

    it('the function form of `to` is REACTIVE: href and active state track it', async () =>
    {
        const routes: Route[] = [{ path: '/users/:id', component: leaf }];
        await withRouter(routes, '/users/2', async (router) =>
        {
            const [id, setId] = createSignal('1');
            let anchor!: HTMLAnchorElement;
            createRoot(() =>
            {
                anchor = mountLink(router, { to: () => `/users/${ id() }` });
            });
            expect(anchor.getAttribute('href')).toBe('/users/1');
            expect(anchor.className).toBe('');

            setId('2');
            await flush();
            expect(anchor.getAttribute('href')).toBe('/users/2');
            expect(anchor.className).toBe('on'); // now matches the current location
        });
    });
});
