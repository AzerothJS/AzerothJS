// ============================================================================
// AZEROTHJS DEMO — Home Page
// ============================================================================

import { h, Link, defineComponent } from '@azerothjs/core';
import { PageHeader, Stat } from '../ui.ts';
import { router } from '../router.ts';

const PILLARS = [
    {
        icon: '⚡',
        title: 'Fine-grained reactivity',
        body: 'Signals, memos, and effects update the exact DOM nodes that changed — no virtual DOM, no component re-renders.'
    },
    {
        icon: '🧩',
        title: 'Real DOM, directly',
        body: 'h() returns actual elements. Bindings wire to nodes at creation; updates are plain mutations.'
    },
    {
        icon: '📦',
        title: 'Components, two ways',
        body: 'Function components with defineComponent or classes with AzerothComponent — over one reactive model.'
    },
    {
        icon: '🔌',
        title: 'Batteries included',
        body: 'Router, forms, async resources, global stores, error boundaries, suspense, and AI streaming.'
    }
];

export const HomePage = defineComponent(() =>
    h('div', { class: 'page home' },
        h('div', { class: 'hero' },
            h('div', { class: 'hero-badge' }, '⚛️ AzerothJS'),
            PageHeader('A delightful, fine-grained framework', 'Zero virtual DOM. Direct DOM updates. One reactive model from signals to streaming.'),
            h('div', { class: 'hero-cta' },
                Link({ to: '/reactivity', router, class: 'btn btn-primary', children: 'Explore reactivity →' }),
                Link({ to: '/data', router, class: 'btn', children: 'See async & streaming' }))),
        h('div', { class: 'stat-grid' },
            Stat('0', 'Runtime deps'),
            Stat('8', 'Packages'),
            Stat('434', 'Tests passing'),
            Stat('0', 'Virtual DOM')),
        h('div', { class: 'pillar-grid' },
            PILLARS.map(p => h('div', { class: 'glass pillar' },
                h('div', { class: 'pillar-icon' }, p.icon),
                h('h3', { class: 'pillar-title' }, p.title),
                h('p', { class: 'pillar-body' }, p.body))))
    ));
