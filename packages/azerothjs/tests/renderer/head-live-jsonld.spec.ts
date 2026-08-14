// @vitest-environment happy-dom
//
// LIVE JSON-LD: the function form re-resolves reactively and SWAPS its block when the
// loader data it reads settles or changes - found live in the browser as a Person block
// naming the PREVIOUS user (the registration snapshot held the old route data), pinned
// here with an animated transition in the mix.
import { it, expect, beforeEach } from 'vitest';
import { h, render, useHead, useLoader, createRouter, createMemoryHistory, Routes, Outlet } from 'azerothjs';
import { resetHead } from 'azerothjs/internal';
import type { Route, Router, MountNode } from 'azerothjs';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => resetHead());

it('a loader-derived jsonLd tracks the resource across param navigations', async () =>
{
    const Layout = (props: { children?: MountNode | undefined }): MountNode =>
        h('div', {}, Outlet({ children: props.children }));
    const Leaf = (): HTMLElement =>
    {
        const profile = useLoader<{ name: string }>();
        useHead({ jsonLd: () => ({ '@type': 'Person', name: profile.data()?.name ?? 'None' }) });
        return h('span', {}, 'x');
    };
    const routes: Route[] =
    [{
        path: '/users',
        component: Layout,
        children: [{
            path: ':id',
            component: Leaf,
            loader: async ({ params }) => ({ name: String(params.id).toUpperCase() })
        }]
    }];
    const container = document.createElement('div');
    document.body.appendChild(container);
    let router!: Router;
    render(() =>
    {
        router = createRouter({ routes, history: createMemoryHistory('/users/aria') });
        return h('div', {}, Routes({ router, transition: 'page', transitionDuration: 100 }));
    }, container);
    await flush();

    const dump = (): string[] => [...document.head.querySelectorAll('script[data-azeroth-head="jsonld"]')].map((s) => s.textContent);
    expect(dump()).toEqual(['{"@type":"Person","name":"ARIA"}']);

    router.navigate('/users/cael');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(dump()).toEqual(['{"@type":"Person","name":"CAEL"}']);

    render(() => h('div', {}), container);
    container.remove();
});
