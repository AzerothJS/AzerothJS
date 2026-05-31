// ============================================================================
// AZEROTHJS DEMO — App Shell
// ============================================================================
//
// The persistent layout: a sidebar of nav Links on the left and
// the routed content (via <Routes>) on the right. The sidebar
// Links use activeClass, so the current section highlights and
// announces aria-current automatically.
//
// ============================================================================

import { h, Link, Routes, defineComponent } from '@azerothjs/core';
import { router, NAV } from './router.ts';

const Sidebar = defineComponent(() =>
    h('aside', { class: 'sidebar' },
        h('div', { class: 'brand' },
            h('span', { class: 'brand-mark' }, '⚛️'),
            h('span', { class: 'brand-name' }, 'AzerothJS')),
        h('nav', { class: 'nav' },
            NAV.map(item => Link({
                to: item.path,
                router,
                class: 'nav-link',
                activeClass: 'nav-link-active',
                children: h('span', {},
                    h('span', { class: 'nav-icon' }, item.icon),
                    h('span', {}, item.label))
            }))),
        h('div', { class: 'sidebar-foot' },
            h('p', {}, 'Fine-grained · No VDOM'),
            h('p', { class: 'muted' }, 'Built with AzerothJS'))));

/** The root component: sidebar + routed content. */
export const AppShell = defineComponent(() =>
    h('div', { class: 'shell' },
        Sidebar({}),
        h('main', { class: 'content' },
            Routes({
                router,
                fallback: () => h('div', { class: 'page' },
                    h('h1', { class: 'page-title' }, '404'),
                    h('p', { class: 'page-subtitle' }, 'No route matched this URL.'),
                    Link({ to: '/', router, class: 'btn btn-primary', children: 'Go home' }))
            }))));
