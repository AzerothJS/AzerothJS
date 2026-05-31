// ============================================================================
// AZEROTHJS DEMO — Routing Page (nested routes)
// ============================================================================
//
// The whole demo is already a routed app, so this page turns the
// lens on the router itself: a layout route with an <Outlet>, a
// nested index, and a `:id` detail route read via useParams. Also
// shows Router.href and explains the `base` option.
//
// ============================================================================

import {
    h,
    For,
    Link,
    Outlet,
    useParams,
    useNavigate,
    defineComponent,
    type RouteComponent
} from '@azerothjs/core';
import { DemoCard, PageHeader, Callout } from '../ui.ts';
import { router } from '../router.ts';

const CREW = ['Ada', 'Alan', 'Grace', 'Edsger', 'Barbara'];

/** Nested index — a list of links into the `:id` detail route. */
export const RoutingIndex: RouteComponent = (): HTMLElement =>
    h('div', { class: 'nested-panel' },
        h('p', { class: 'search-status' }, 'Pick a crew member — the URL and the detail panel update via a nested route:'),
        h('div', { class: 'crew-grid' },
            For({ each: () => CREW, key: (n) => n },
                (name, index) => Link({
                    to: `/routing/users/${ index() }`,
                    router,
                    class: 'crew-link',
                    activeClass: 'crew-link-active',
                    children: name
                }))));

/** Nested detail — reads the `:id` param reactively. */
export const UserDetail: RouteComponent = (): HTMLElement =>
{
    const params = useParams(router);
    const nav = useNavigate(router);
    const id = (): number => Number(params().id ?? 0);

    return h('div', { class: 'nested-panel' },
        h('div', { class: 'user-card' },
            h('div', { class: 'avatar' }, () => (CREW[id()] ?? '?').charAt(0)),
            h('div', {},
                h('div', { class: 'user-name' }, () => CREW[id()] ?? 'Unknown'),
                h('div', { class: 'user-role' }, () => `route param id = ${ params().id }`))),
        h('button', { class: 'btn btn-ghost', onClick: () => nav.navigate('/routing') }, '← Back to list'));
};

const HrefDemo = defineComponent(() =>
    DemoCard(
        {
            title: 'Links, href & base',
            description: 'Link renders a real <a href> via router.href(). Configure createRouter({ base }) and every href/navigation is prefixed automatically — app code stays base-relative.',
            tags: ['Link', 'router.href', 'base']
        },
        h('table', { class: 'href-table' },
            h('thead', {}, h('tr', {},
                h('th', {}, 'router.href(to)'), h('th', {}, 'result'))),
            h('tbody', {},
                ['/data', '/routing/users/2', 'https://example.com'].map(to =>
                    h('tr', {},
                        h('td', {}, h('code', {}, to)),
                        h('td', {}, h('code', {}, router.href(to))))))),
        Callout('info',
            h('span', {},
                'With base ', h('code', {}, '/app'), ', ',
                h('code', {}, 'href(/data)'), ' returns ',
                h('code', {}, '/app/data'),
                ' — external URLs are left untouched.'))));

/** The Routing layout route — renders its nested children in an Outlet. */
export const RoutingPage = defineComponent<{ children?: HTMLElement }>((props) =>
    h('div', { class: 'page' },
        PageHeader('Routing', 'A nested, data-style router — this very page is a layout route with an Outlet.'),
        Callout('tip', 'The sidebar links use Link with activeClass + aria-current. Below, a nested route swaps the detail panel while keeping this layout mounted.'),
        DemoCard(
            {
                title: 'Nested Route + useParams',
                description: 'This card is a layout; the panel below is rendered by a child route into <Outlet>. Clicking a name pushes /routing/users/:id.',
                tags: ['Routes', 'Outlet', 'useParams', 'Link']
            },
            Outlet({ children: props.children })),
        HrefDemo({})
    ));
