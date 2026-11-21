// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEffect, createMemoryHistory, createRoot, createRouter, h, render, Routes } from 'azerothjs';
import type { Route, RouteComponent, Router } from 'azerothjs';

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

function gate<T>()
{
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r =>
    {
        resolve = r;
    });
    return { promise, resolve };
}

const hosts: HTMLElement[] = [];
afterEach(() =>
{
    for (const host of hosts.splice(0))
    {
        render(() => h('div', {}), host);
        host.remove();
    }
});

const page = (title: string): RouteComponent => () => h('main', { 'data-route-focus': '', tabindex: -1 }, title);

function mount(routes: Route[], initial: string)
{
    const host = document.createElement('div');
    document.body.appendChild(host);
    hosts.push(host);
    const mounts: string[] = [];
    const states: string[] = [];
    const frames: string[] = [];
    let router!: Router;
    render(() =>
    {
        router = createRouter({ routes, history: createMemoryHistory(initial), scroll: false });
        createEffect(() =>
        {
            states.push(router.state().kind);
        });
        createEffect(() =>
        {
            const verdict = router.state();
            const location = verdict.kind === 'match' ? verdict.match.pathname : verdict.kind;
            frames.push(`${ location } ${ router.pending() ? 'pending' : 'idle' }`);
        });
        return h('div', {}, Routes({
            router,
            fallback: () =>
            {
                mounts.push('missing');
                return h('h1', { tabindex: -1 }, 'Missing');
            },
            blocked: ({ status }) =>
            {
                mounts.push(`blocked ${ status }`);
                return h('h1', { tabindex: -1 }, `Blocked ${ status }`);
            }
        }));
    }, host);
    return { host, router, mounts, states, frames };
}

describe('guarded navigation and presentation', () =>
{
    it('exposes an undecided initial verdict to consumers without Routes', async () =>
    {
        const admission = gate<boolean>();
        let router!: Router;
        const dispose = createRoot(stop =>
        {
            router = createRouter({
                routes: [{ path: '/gallery', component: page('Gallery'), guard: () => admission.promise }],
                history: createMemoryHistory('/gallery')
            });
            return stop;
        });
        try
        {
            expect(router.state()).toEqual({ kind: 'pending' });
            expect(router.match()).toBeNull();
            expect(router.pending()).toBe(true);
            admission.resolve(true);
            await flush();
            expect(router.state().kind).toBe('match');
            expect(router.match()?.pathname).toBe('/gallery');
            expect(router.pending()).toBe(false);
        }
        finally
        {
            dispose();
        }
    });

    it('stays blank through a cold guard and a subsequent chunk, then admits without moving focus', async () =>
    {
        const admission = gate<boolean>();
        const chunk = gate<{ default: RouteComponent }>();
        const { host, router, mounts, states } = mount([{ path: '/gallery', guard: () => admission.promise, lazy: () => chunk.promise }], '/gallery');
        const before = document.activeElement;
        expect(router.pending()).toBe(true);
        expect(router.match()).toBeNull();
        expect(states).toEqual(['pending']);
        expect(mounts).toEqual([]);
        expect(host.textContent).toBe('');
        admission.resolve(true);
        await flush();
        expect(router.pending()).toBe(true);
        expect(router.state().kind).toBe('match');
        expect(mounts).toEqual([]);
        expect(host.textContent).toBe('');
        chunk.resolve({ default: page('Gallery') });
        await flush();
        expect(router.pending()).toBe(false);
        expect(states).toEqual(['pending', 'match']);
        expect(host.textContent).toBe('Gallery');
        expect(mounts).toEqual([]);
        expect(document.activeElement).toBe(before);
    });

    it('keeps the previous page during the guard and lazy wait', async () =>
    {
        const admission = gate<boolean>();
        const chunk = gate<{ default: RouteComponent }>();
        const { host, router, mounts } = mount([
            { path: '/', component: page('Home') },
            { path: '/gallery', guard: () => admission.promise, lazy: () => chunk.promise }
        ], '/');
        const home = host.querySelector('main');
        router.navigate('/gallery');
        expect(host.querySelector('main')).toBe(home);
        admission.resolve(true);
        await flush();
        expect(host.querySelector('main')).toBe(home);
        chunk.resolve({ default: page('Gallery') });
        await flush();
        expect(host.textContent).toBe('Gallery');
        expect(mounts).toEqual([]);
    });

    it.each(['sync', 'resolved', 'rejected'] as const)('publishes a %s veto directly to the blocked presentation', async mode =>
    {
        const admission = gate<boolean>();
        const failure = new Error('Gallery is unavailable');
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try
        {
            const { router, host, mounts, states, frames } = mount([
                { path: '/', component: page('Home') },
                { path: '/later', component: page('Later'), guard: () => mode === 'sync'
                    ? false
                    : admission.promise.then(value =>
                    {
                        if (mode === 'rejected')
                        {
                            throw failure;
                        }
                        return value;
                    }) }
            ], '/');
            router.navigate('/later');
            if (mode !== 'sync')
            {
                expect(host.textContent).toBe('Home');
                frames.length = 0;
                admission.resolve(false);
                await flush();
                expect(frames).toEqual(['blocked idle']);
            }
            expect(router.state()).toEqual({ kind: 'blocked', status: 403 });
            expect(host.textContent).toBe('Blocked 403');
            expect(states).toEqual(['match', 'blocked']);
            expect(mounts).toEqual(['blocked 403']);
            expect(document.activeElement).toBe(host.querySelector('h1'));
            if (mode === 'rejected')
            {
                expect(errors.mock.calls.some(call => call.includes(failure))).toBe(true);
            }
            else
            {
                expect(errors).not.toHaveBeenCalled();
            }
        }
        finally
        {
            errors.mockRestore();
        }
    });

    it('recognizes a real missing URL immediately', () =>
    {
        const { router, mounts, states, host } = mount([{ path: '/', component: page('Home') }], '/missing');
        expect(router.pending()).toBe(false);
        expect(states).toEqual(['not-found']);
        expect(mounts).toEqual(['missing']);
        expect(host.textContent).toBe('Missing');
    });

    it('keeps the previously rendered denial while the next route decides', async () =>
    {
        const admission = gate<boolean>();
        const { router, host, mounts } = mount([
            { path: '/closed', guard: () => false, component: page('Closed') },
            { path: '/gallery', guard: () => admission.promise, component: page('Gallery') }
        ], '/closed');
        const held = host.querySelector('h1');
        expect(held?.textContent).toBe('Blocked 403');
        router.navigate('/gallery');
        expect(host.querySelector('h1')).toBe(held);
        expect(router.pending()).toBe(true);
        admission.resolve(true);
        await flush();
        expect(host.textContent).toBe('Gallery');
        expect(mounts).toEqual(['blocked 403']);
    });

    it.each([
        { boot: true, asynchronous: false },
        { boot: true, asynchronous: true },
        { boot: false, asynchronous: false },
        { boot: false, asynchronous: true }
    ])('settles its canonical query on boot=$boot, async=$asynchronous', async ({ boot, asynchronous }) =>
    {
        const queries: string[] = [];
        const { router, host, mounts } = mount([
            { path: '/', component: page('Home') },
            { path: '/catalog', component: page('Catalog'), guard: ({ query }) =>
            {
                const value = String(query.page ?? '');
                queries.push(value);
                const verdict = value === '1' ? true : '/catalog?page=1';
                return asynchronous ? Promise.resolve(verdict) : verdict;
            } }
        ], boot ? '/catalog' : '/');
        if (!boot)
        {
            router.navigate('/catalog');
        }
        await flush();
        expect(router.location().fullPath).toBe('/catalog?page=1');
        expect(queries).toEqual(['', '1']);
        expect(router.match()?.pathname).toBe('/catalog');
        expect(router.pending()).toBe(false);
        expect(host.textContent).toBe('Catalog');
        expect(mounts).toEqual([]);
    });

    it('holds the previous settled presentation while a new query is being decided', async () =>
    {
        const admission = gate<boolean>();
        const guardQueries: string[] = [];
        const loads: string[] = [];
        const { host, router } = mount([{
            path: '/catalog', component: page('Catalog'),
            guard: ({ query }) =>
            {
                const edition = String(query.edition);
                guardQueries.push(edition);
                return edition === 'two' ? admission.promise : true;
            },
            loader: ({ query }) =>
            {
                loads.push(String(query.edition)); return Promise.resolve(query.edition);
            }
        }], '/catalog?edition=one');
        await flush();
        const original = host.querySelector('main');
        expect(guardQueries).toEqual(['one']);
        expect(loads).toEqual(['one']);
        router.navigate('/catalog?edition=two');
        expect(guardQueries).toEqual(['one', 'two']);
        expect(router.pending()).toBe(true);
        expect(loads).toEqual(['one']);
        expect(host.querySelector('main')).toBe(original);
        expect(router.state().kind).toBe('match');
        expect(router.location().search).toBe('?edition=two');
        admission.resolve(true);
        await flush();
        expect(loads).toEqual(['one', 'two']);
        expect(router.pending()).toBe(false);
    });

    it('a hash-only navigation preserves the page, guard and loader', async () =>
    {
        const guards: string[] = [];
        const loads: string[] = [];
        const { host, router } = mount([{
            path: '/catalog', component: page('Catalog'),
            guard: ({ pathname }) =>
            {
                guards.push(pathname); return true;
            },
            loader: () =>
            {
                loads.push('catalog'); return Promise.resolve('catalog');
            }
        }], '/catalog');
        await flush();
        const original = host.querySelector('main');
        router.navigate('/catalog#notes');
        await flush();
        expect(router.location().hash).toBe('#notes');
        expect(guards).toEqual(['/catalog']);
        expect(loads).toHaveLength(1);
        expect(host.querySelector('main')).toBe(original);
    });

    it.each([false, true])('a refused redirect retains an already settled screen, async blocker=%s', async asynchronous =>
    {
        const admission = gate<boolean | string>();
        const blocker = gate<boolean>();
        const { router, host, mounts } = mount([
            { path: '/', component: page('Home') },
            { path: '/catalog', guard: () => admission.promise, component: page('Catalog') }
        ], '/');
        router.navigate('/catalog');
        const to: unknown[] = [];
        const stop = router.block(context =>
        {
            to.push(context.to); return asynchronous ? blocker.promise : false;
        });
        admission.resolve('/catalog?page=1');
        await flush();
        expect(router.state().kind).toBe('match');
        expect(host.textContent).toBe('Home');
        expect(router.pending()).toBe(asynchronous);
        blocker.resolve(false);
        await flush();
        expect(router.location().fullPath).toBe('/catalog');
        expect(router.state().kind).toBe('match');
        expect(router.pending()).toBe(false);
        expect(host.textContent).toBe('Home');
        expect(mounts).toEqual([]);
        expect(to).toEqual(['/catalog?page=1']);
        stop();
        router.navigate('/');
        expect(host.textContent).toBe('Home');
    });

    it.each([false, true])('a refused canonical redirect on cold boot settles blocked, async blocker=%s', async asynchronous =>
    {
        const admission = gate<string>();
        const decision = gate<boolean>();
        const { router, host, mounts, states } = mount([{
            path: '/gallery', component: page('Gallery'), guard: () => admission.promise
        }], '/gallery');
        const requested: unknown[] = [];
        router.block(context =>
        {
            requested.push(context.to);
            return asynchronous ? decision.promise : false;
        });
        admission.resolve('/gallery?view=grid');
        await flush();
        if (asynchronous)
        {
            expect(router.state().kind).toBe('pending');
            expect(router.pending()).toBe(true);
        }
        decision.resolve(false);
        await flush();
        expect(requested).toEqual(['/gallery?view=grid']);
        expect(router.location().fullPath).toBe('/gallery');
        expect(router.state()).toEqual({ kind: 'blocked', status: 403 });
        expect(host.textContent).toBe('Blocked 403');
        expect(states).not.toContain('not-found');
        expect(mounts).toEqual(['blocked 403']);
    });

    it('a redirect waiting for a leave blocker cannot replace a newer accepted location', async () =>
    {
        const admission = gate<string>();
        const confirmation = gate<boolean>();
        const { router, host, mounts } = mount([
            { path: '/', component: page('Home') },
            { path: '/catalog', component: page('Catalog'), guard: ({ query }) => query.page === '1' ? true : admission.promise },
            { path: '/gallery', component: page('Gallery') }
        ], '/');
        router.navigate('/catalog');
        const canonical = '/catalog?page=1';
        router.block(({ to }) => to === canonical ? confirmation.promise : true);
        admission.resolve(canonical);
        await flush();
        router.navigate('/gallery');
        expect(host.textContent).toBe('Gallery');
        confirmation.resolve(true);
        await flush();
        expect(router.location().fullPath).toBe('/gallery');
        expect(router.state().kind).toBe('match');
        expect(host.textContent).toBe('Gallery');
        expect(mounts).toEqual([]);
    });

    it('a delayed guard on a previous visit cannot overwrite a newly accepted page', async () =>
    {
        const admission = gate<boolean | string>();
        const { router, host, mounts } = mount([
            { path: '/', component: page('Home') },
            { path: '/catalog', guard: () => admission.promise, component: page('Catalog') },
            { path: '/gallery', component: page('Gallery') }
        ], '/');
        router.navigate('/catalog');
        expect(router.pending()).toBe(true);
        router.navigate('/gallery');
        admission.resolve('/catalog?page=1');
        await flush();
        expect(router.location().fullPath).toBe('/gallery');
        expect(router.state().kind).toBe('match');
        expect(host.textContent).toBe('Gallery');
        expect(mounts).toEqual([]);
    });

    it.each(['initial canonical query', 'different route'] as const)('commits the %s redirect control', async control =>
    {
        const target = control === 'different route' ? '/gallery' : '/catalog?page=1';
        const { host, router, mounts } = mount([
            { path: '/catalog', guard: ({ query }) => query.page === '1' ? true : '/gallery', component: page('Catalog') },
            { path: '/gallery', component: page('Gallery') }
        ], control === 'different route' ? '/catalog' : target);
        await flush();
        expect(router.location().fullPath).toBe(target);
        expect(router.state().kind).toBe('match');
        expect(router.pending()).toBe(false);
        expect(host.textContent).toBe(control === 'different route' ? 'Gallery' : 'Catalog');
        expect(mounts).toEqual([]);
    });

    it('continues to render a legitimate not-found while the next location decides', async () =>
    {
        const admission = gate<boolean>();
        const { router, host, mounts } = mount([{ path: '/gallery', guard: () => admission.promise, component: page('Gallery') }], '/missing');
        const missing = host.querySelector('h1');
        router.navigate('/gallery');
        expect(host.querySelector('h1')).toBe(missing);
        admission.resolve(true);
        await flush();
        expect(host.textContent).toBe('Gallery');
        expect(mounts).toEqual(['missing']);
    });
});
