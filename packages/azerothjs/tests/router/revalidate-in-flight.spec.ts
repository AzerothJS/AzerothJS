// @vitest-environment happy-dom
//
// revalidate(), router.revalidate() and an enhanced <Form> while a fetch of the entry is in flight,
// in an app with a router: the call waits for data fetched after it, whenever that fetch began.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Form, RouterProvider, Routes, createMemoryHistory, createRoot, createRouter, h, render, revalidate } from 'azerothjs';
import type { Route, Router } from 'azerothjs';
import type { Cart } from '../support/gated-cart.ts';
import { GatedServer, cartFamily, mount, track, turns, until } from '../support/gated-cart.ts';
import { resetDataCache } from 'azerothjs/internal';

afterEach(() =>
{
    vi.unstubAllGlobals();
    resetDataCache();
    document.body.innerHTML = '';
});

function beside(): void
{
    const routes: Route[] = [{ path: '/', component: () => document.createElement('div') }];
    createRouter({ routes, history: createMemoryHistory('/') });
}

function loaderRouter(server: GatedServer): { router: Router; dispose: () => void }
{
    let dispose!: () => void;
    const router = createRoot((d) =>
    {
        dispose = d;
        const routes: Route[] = [{ path: '/cart', component: () => document.createElement('div'), loader: ({ signal }) => server.get(signal) }];
        return createRouter({ routes, history: createMemoryHistory('/cart') });
    });
    return { router, dispose };
}

const levelCount = (router: Router): number | undefined => (router.loaders[0]?.data() as Cart | undefined)?.count;

interface FormPage
{
    router: Router;
    form: () => HTMLFormElement;
    submitting: () => boolean;
    settled: (number | undefined)[];

    /** How many times anything called router.revalidate(), the <Form> included. */
    revalidations: () => number;
}

/** A page whose loader reads the cart and whose enhanced <Form> posts an add the server applies. */
function formPage(server: GatedServer): FormPage
{
    const settled: (number | undefined)[] = [];
    let revalidations = 0;
    const page = (): HTMLElement => Form
    ({
        onSettled: () =>
        {
            settled.push(levelCount(router));
        },
        children: h('button', { type: 'submit' }, 'add')
    }) as HTMLElement;
    const routes: Route[] = [{ path: '/todos', loader: ({ signal }) => server.get(signal), component: page }];
    const respond = async (_url: unknown, init?: RequestInit): Promise<Response> =>
    {
        if (init?.method === 'POST')
        {
            server.count += 1;
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('', { status: 204, headers: { 'x-azeroth-csrf-cookie': 'azcsrf=tok' } });
    };
    vi.stubGlobal('fetch', vi.fn(respond));
    const router = createRouter({ routes, history: createMemoryHistory('/todos') });
    const revalidateLoaders = router.revalidate;
    router.revalidate = () =>
    {
        revalidations += 1;
        return revalidateLoaders();
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(() => RouterProvider({ router, children: () => Routes({ fallback: () => h('p', {}, 'not found') }) }), host);
    const form = (): HTMLFormElement => host.querySelector('form')!;
    return {
        router,
        form,
        submitting: () => form().hasAttribute('data-azeroth-submitting'),
        settled,
        revalidations: () => revalidations
    };
}

function submit(form: HTMLFormElement): void
{
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('revalidate with a fetch in flight, with a router', () =>
{
    for (const inFlight of [false, true])
    {
        it(`revalidate(fn) after a direct server write resolves at the written value (a fetch in flight: ${ String(inFlight) })`, async () =>
        {
            const server = new GatedServer(0);
            const getCart = cartFamily(server, `direct-write-${ String(inFlight) }`);
            const m = mount(getCart, beside);
            await server.releaseGet(0);
            if (inFlight)
            {
                void revalidate(getCart);
                await server.arrived(1);
            }
            server.count = 1;
            let atResolve: number | undefined;
            const awaited = track(revalidate(getCart).then(() =>
            {
                atResolve = m.cart.data()?.count;
            }));
            await turns();
            expect(awaited.done()).toBe(false);
            await server.drain();
            await until(() => awaited.done(), 'revalidate');
            expect(atResolve).toBe(1);
            expect(m.cart.data()?.count).toBe(1);
            m.dispose();
        });

        it(`router.revalidate() after a write resolves at the written value (a loader fetch in flight: ${ String(inFlight) })`, async () =>
        {
            const server = new GatedServer(0);
            const { router, dispose } = loaderRouter(server);
            await server.releaseGet(0);
            expect(levelCount(router)).toBe(0);
            if (inFlight)
            {
                void router.revalidate();
                await server.arrived(1);
            }
            server.count = 1;
            let atResolve: number | undefined;
            const awaited = track(router.revalidate().then(() =>
            {
                atResolve = levelCount(router);
            }));
            await turns();
            expect(awaited.done()).toBe(false);
            await server.drain();
            await until(() => awaited.done(), 'router.revalidate()');
            expect(atResolve).toBe(1);
            dispose();
        });
    }

    it('revalidate(fn) with no write during the first fetch waits for the follow-up and resolves at its data', async () =>
    {
        const server = new GatedServer(0);
        const getCart = cartFamily(server, 'first-fetch');
        const m = mount(getCart, beside);
        await server.arrived(0);
        server.count = 3;
        let atResolve: number | undefined;
        const awaited = track(revalidate(getCart).then(() =>
        {
            atResolve = m.cart.data()?.count;
        }));
        await turns();
        expect(awaited.done()).toBe(false);
        await server.drain();
        await until(() => awaited.done(), 'revalidate');
        expect(atResolve).toBe(3);
        expect(server.gets).toHaveLength(2);
        m.dispose();
    });
});

describe('an enhanced <Form> submit with the page\'s loader fetch in flight', () =>
{
    it('during a revalidate\'s fetch settles at the server value, submitting until that data lands', async () =>
    {
        const server = new GatedServer(0);
        const page = formPage(server);
        await server.releaseGet(0);
        void page.router.revalidate();
        const refresh = await server.arrived(1);
        submit(page.form());
        await until(() => page.revalidations() === 2, 'the form to revalidate');
        refresh.release();
        await turns();
        expect(page.settled).toEqual([]);
        expect(page.submitting()).toBe(true);
        await server.drain();
        await until(() => page.settled.length === 1, 'onSettled');
        await turns();
        expect(page.settled).toEqual([1]);
        expect(levelCount(page.router)).toBe(1);
        expect(page.submitting()).toBe(false);
    });

    it('during the first load settles at the server value, submitting until that data lands', async () =>
    {
        const server = new GatedServer(0);
        const page = formPage(server);
        const firstLoad = await server.arrived(0);
        submit(page.form());
        await until(() => page.revalidations() === 1, 'the form to revalidate');
        firstLoad.release();
        await turns();
        expect(page.settled).toEqual([]);
        expect(page.submitting()).toBe(true);
        await server.drain();
        await until(() => page.settled.length === 1, 'onSettled');
        await turns();
        expect(page.settled).toEqual([1]);
        expect(levelCount(page.router)).toBe(1);
        expect(page.submitting()).toBe(false);
    });
});
