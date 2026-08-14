// @vitest-environment happy-dom
//
// String mode on a NESTED chain is a PINNED evaluation - the
// child markup and the azc:outlet anchors are present, and NO live effect subscribes to
// anything (the subscription probe: a signal read through text holes in every segment must
// end the render with zero subscribers). Plus: markers-off output is byte-clean of
// framework bookkeeping.
import { describe, it, expect } from 'vitest';
import { createSignal, h, renderToString } from 'azerothjs';
import { createRouter, createMemoryHistory, Routes, Outlet } from 'azerothjs';
import { subscriberCount } from 'azerothjs/internal';
import type { Route, Router, MountNode } from 'azerothjs';

function nestedApp(): { routes: Route[]; probe: () => string; count: () => number }
{
    const [probe] = createSignal('live');
    const Layout = (props: { children?: MountNode | undefined }): MountNode =>
        h('div', { id: 'layout' },
            h('em', {}, () => probe()),
            Outlet({ children: props.children }));
    const Leaf = (): HTMLElement => h('span', { id: 'leaf' }, () => probe());
    const routes: Route[] =
    [{
        path: '/users',
        component: Layout,
        children: [{ path: ':id', component: Leaf }]
    }];
    return { routes, probe, count: (): number => subscriberCount(probe) };
}

function serverRouter(routes: Route[], url: string): Router
{
    return createRouter({ routes, history: createMemoryHistory(url) });
}

describe('string mode on a nested chain', () =>
{
    it('emits the nested markup inside azc:outlet anchors', () =>
    {
        const { routes } = nestedApp();
        const html = renderToString(() =>
            h('div', { id: 'app' }, Routes({ router: serverRouter(routes, '/users/7') })));

        expect(html).toContain('<!--azc:routes-->');
        expect(html).toContain('<!--azc:outlet-->');
        expect(html).toContain('id="leaf"');
        // The child markup nests INSIDE the layout markup, inside the outlet range.
        const layoutStart = html.indexOf('id="layout"');
        const outletStart = html.indexOf('<!--azc:outlet-->');
        const leafStart = html.indexOf('id="leaf"');
        const layoutEnd = html.indexOf('</div>', leafStart);
        expect(layoutStart).toBeGreaterThan(-1);
        expect(outletStart).toBeGreaterThan(layoutStart);
        expect(leafStart).toBeGreaterThan(outletStart);
        expect(layoutEnd).toBeGreaterThan(leafStart);
    });

    it('creates ZERO live effects: the pinned evaluation leaves no subscriber behind', () =>
    {
        const { routes, count } = nestedApp();
        const html = renderToString(() =>
            h('div', { id: 'app' }, Routes({ router: serverRouter(routes, '/users/7') })));

        // Both segments' text holes resolved the probe eagerly - the values are IN the
        // output - yet nothing stayed subscribed: no hole effect, no slot effect, no
        // driver went live.
        expect(html).toContain('live');
        expect(count()).toBe(0);
    });

    it('a leaf chain (flat route) still serializes synchronously with its anchors', () =>
    {
        const routes: Route[] = [{ path: '/', component: (): HTMLElement => h('main', { id: 'home' }, 'home') }];
        const html = renderToString(() => h('div', {}, Routes({ router: serverRouter(routes, '/') })));
        expect(html).toContain('<!--azc:routes-->');
        expect(html).toContain('id="home"');
    });
});

describe('markers-off output is byte-clean', () =>
{
    it('no azc anchors, no comments, same visible markup', () =>
    {
        const { routes } = nestedApp();
        const html = renderToString(() =>
            h('div', { id: 'app' }, Routes({ router: serverRouter(routes, '/users/7') })), { markers: false });

        expect(html).not.toContain('azc:');
        expect(html).not.toContain('<!--');
        expect(html).toContain('id="layout"');
        expect(html).toContain('id="leaf"');
    });
});
