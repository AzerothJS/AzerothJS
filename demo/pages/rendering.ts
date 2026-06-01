// ============================================================================
// AZEROTHJS DEMO — Rendering Page
// ============================================================================
//
// Control-flow components: Show, For (keyed + reactive index),
// Switch/Match, Dynamic, and Portal — plus reactive class/style
// binding.
//
// ============================================================================

import {
    h,
    Show,
    For,
    Switch,
    Match,
    Dynamic,
    Portal,
    Transition,
    batch,
    classList,
    styleMap,
    createSignal,
    createMemo,
    defineComponent,
    type RouteComponent
} from '@azerothjs/core';
import { DemoCard, PageHeader, Callout } from '../ui.ts';

// ── Keyed list (For + Show + classList) ─────────────────────────

interface Todo { id: number; text: string; done: boolean }

const TodoDemo = defineComponent(() =>
{
    let nextId = 4;
    const [todos, setTodos] = createSignal<Todo[]>([
        { id: 1, text: 'Learn signals', done: true },
        { id: 2, text: 'Build a keyed list', done: false },
        { id: 3, text: 'Ship something great', done: false }
    ]);
    const [draft, setDraft] = createSignal('');
    const [filter, setFilter] = createSignal<'all' | 'active' | 'done'>('all');

    const visible = createMemo(() =>
    {
        const f = filter();
        return todos().filter(t => f === 'all' || (f === 'done') === t.done);
    });
    const remaining = createMemo(() => todos().filter(t => !t.done).length);

    function add(): void
    {
        const text = draft().trim();
        if (text === '')
        {
            return;
        }
        batch(() =>
        {
            setTodos(prev => [...prev, { id: nextId++, text, done: false }]);
            setDraft('');
        });
    }

    const filters: ('all' | 'active' | 'done')[] = ['all', 'active', 'done'];

    return DemoCard(
        {
            title: 'Keyed Todo List',
            description: 'For reuses DOM nodes by key across add/remove/filter; classList toggles reactively; Show renders the empty state.',
            tags: ['For', 'Show', 'classList', 'batch']
        },
        h('div', { class: 'input-row' },
            h('input', {
                class: 'text-input',
                type: 'text',
                placeholder: 'Add a todo and press Enter…',
                value: draft,
                onInput: (e: Event) => setDraft((e.target as HTMLInputElement).value),
                onKeydown: (e: KeyboardEvent) =>
                {
                    if (e.key === 'Enter')
                    {
                        add();
                    }
                }
            }),
            h('button', { class: 'btn btn-primary', onClick: add }, 'Add')
        ),
        h('div', { class: 'tab-row' },
            filters.map(f => h('button', {
                class: classList(['tab', { 'tab-active': () => filter() === f }]),
                onClick: () => setFilter(f)
            }, f))),
        Show({
            when: () => visible().length > 0,
            fallback: () => h('p', { class: 'empty-state' }, 'Nothing here yet.'),
            children: () => h('ul', { class: 'todo-list' },
                For({
                    each: visible,
                    key: (t) => t.id,
                    children: (todo) =>
                    {
                        const t = todo;
                        return h('li', {
                            class: classList(['todo-item', { 'todo-done': () => todos().find(x => x.id === t.id)?.done ?? false }])
                        },
                        h('label', { class: 'todo-label' },
                            h('input', {
                                type: 'checkbox',
                                checked: () => todos().find(x => x.id === t.id)?.done ?? false,
                                onChange: () => setTodos(prev =>
                                    prev.map(x => x.id === t.id ? { ...x, done: !x.done } : x))
                            }),
                            h('span', {}, t.text)),
                        h('button', {
                            class: 'icon-btn',
                            onClick: () => setTodos(prev => prev.filter(x => x.id !== t.id))
                        }, '✕'));
                    }
                }))
        }),
        h('p', { class: 'search-status' }, () => `${ remaining() } remaining`)
    );
});

// ── Reactive For index (reorder) ────────────────────────────────

const ReorderDemo = defineComponent(() =>
{
    const [items, setItems] = createSignal(
        ['Aragorn', 'Boromir', 'Gimli', 'Legolas'].map((label, i) => ({ id: i + 1, label }))
    );

    function shuffle(): void
    {
        setItems(prev =>
        {
            const next = [...prev];
            for (let i = next.length - 1; i > 0; i--)
            {
                // Deterministic-ish rotation (no Math.random in this env);
                // good enough to demonstrate reordering + reuse.
                const j = (i * 7 + 3) % (i + 1);
                [next[i], next[j]] = [next[j], next[i]];
            }
            return next;
        });
    }

    function rotate(): void
    {
        setItems(prev => prev.length > 1 ? [...prev.slice(1), prev[0]] : prev);
    }

    return DemoCard(
        {
            title: 'Reactive Index on Reorder',
            description: 'For passes a REACTIVE index getter. Reordering reuses each element (no rebuild) yet the displayed position updates live.',
            tags: ['For', 'index()']
        },
        h('div', { class: 'btn-row' },
            h('button', { class: 'btn', onClick: rotate }, 'Rotate'),
            h('button', { class: 'btn btn-primary', onClick: shuffle }, 'Shuffle')
        ),
        h('ol', { class: 'rank-list' },
            For({
                each: items,
                key: (it) => it.id,
                children: (item, index) => h('li', { class: 'rank-item' },
                    h('span', { class: 'rank-badge' }, () => `#${ index() + 1 }`),
                    h('span', { class: 'rank-label' }, item.label),
                    h('span', { class: 'rank-id' }, `id ${ item.id }`))
            }))
    );
});

// ── Switch / Match ──────────────────────────────────────────────

type Status = 'idle' | 'loading' | 'success' | 'error';

const SwitchDemo = defineComponent(() =>
{
    const order: Status[] = ['idle', 'loading', 'success', 'error'];
    const [status, setStatus] = createSignal<Status>('idle');

    function cycle(): void
    {
        setStatus(s => order[(order.indexOf(s) + 1) % order.length]);
    }

    return DemoCard(
        {
            title: 'Switch / Match',
            description: 'Renders exactly one branch for the first matching condition — a declarative switch for the DOM.',
            tags: ['Switch', 'Match']
        },
        h('div', { class: 'status-panel' },
            Switch({ children: [
                Match({ when: () => status() === 'idle',
                    children: () => h('div', { class: 'status status-idle' }, '⏸️ Idle — press cycle') }),
                Match({ when: () => status() === 'loading',
                    children: () => h('div', { class: 'status status-loading' }, '⏳ Loading…') }),
                Match({ when: () => status() === 'success',
                    children: () => h('div', { class: 'status status-success' }, '✅ Success!') }),
                Match({ when: () => status() === 'error',
                    children: () => h('div', { class: 'status status-error' }, '❌ Something failed') })
            ] })),
        h('button', { class: 'btn btn-primary', onClick: cycle }, () => `Cycle (${ status() })`)
    );
});

// ── Dynamic component swap ──────────────────────────────────────

const DynamicDemo = defineComponent(() =>
{
    const Overview: RouteComponent = () => h('p', { class: 'tab-panel' }, '📊 Overview — high-level metrics live here.');
    const Activity: RouteComponent = () => h('p', { class: 'tab-panel' }, '🔔 Activity — a feed of recent events.');
    const Settings: RouteComponent = () => h('p', { class: 'tab-panel' }, '⚙️ Settings — toggles and preferences.');

    const tabs = [
        { key: 'overview', label: 'Overview', component: Overview },
        { key: 'activity', label: 'Activity', component: Activity },
        { key: 'settings', label: 'Settings', component: Settings }
    ];
    const [active, setActive] = createSignal(tabs[0]);

    return DemoCard(
        {
            title: 'Dynamic Component',
            description: 'Dynamic swaps the rendered component at runtime from a signal — perfect for tabs, wizards, and plugin slots.',
            tags: ['Dynamic']
        },
        h('div', { class: 'tab-row' },
            tabs.map(tab => h('button', {
                class: classList(['tab', { 'tab-active': () => active().key === tab.key }]),
                onClick: () => setActive(tab)
            }, tab.label))),
        Dynamic({ component: () => active().component })
    );
});

// ── Portal + reactive style ─────────────────────────────────────

const PortalDemo = defineComponent(() =>
{
    const [open, setOpen] = createSignal(false);
    const [hue, setHue] = createSignal(210);

    return DemoCard(
        {
            title: 'Portal & Reactive Style',
            description: 'Portal renders into document.body (escaping overflow/stacking); styleMap binds inline styles reactively.',
            tags: ['Portal', 'styleMap']
        },
        h('div', {
            class: 'swatch-preview',
            style: styleMap({ background: () => `hsl(${ hue() } 80% 55%)` })
        }, () => `hsl(${ hue() } 80% 55%)`),
        h('input', {
            class: 'slider',
            type: 'range', min: '0', max: '360',
            value: () => String(hue()),
            onInput: (e: Event) => setHue(Number((e.target as HTMLInputElement).value))
        }),
        h('button', { class: 'btn btn-primary', onClick: () => setOpen(true) }, 'Open modal (portaled)'),
        Show({ when: open, children: () => Portal({ children: () =>
            h('div', { class: 'modal-overlay', onClick: () => setOpen(false) },
                h('div', {
                    class: 'modal',
                    style: styleMap({ borderColor: () => `hsl(${ hue() } 80% 55%)` }),
                    onClick: (e: Event) => e.stopPropagation()
                },
                h('h3', {}, 'I live in document.body'),
                h('p', {}, 'Yet I close when this scope unmounts — Portal auto-cleans.'),
                h('button', { class: 'btn', onClick: () => setOpen(false) }, 'Close'))) }) })
    );
});

// ── Transition (enter/leave animation) ──────────────────────────

const TransitionDemo = defineComponent(() =>
{
    const [show, setShow] = createSignal(true);

    return DemoCard(
        {
            title: 'Enter / Leave Transition',
            description: 'Transition keeps the element in the DOM through its leave animation, then removes it — driven by a CSS class family.',
            tags: ['Transition']
        },
        h('button', { class: 'btn btn-primary', onClick: () => setShow(s => !s) },
            () => show() ? 'Hide' : 'Show'),
        h('div', { class: 'transition-stage' },
            Transition({
                when: show,
                name: 'reveal',
                children: () => h('div', { class: 'transition-box' }, '✨ Animated')
            }))
    );
});

/** The Rendering route page. */
export const RenderingPage = defineComponent(() =>
    h('div', { class: 'page' },
        PageHeader('Rendering', 'Declarative control flow that compiles to direct DOM mutations.'),
        Callout('tip', 'Reorder the list below and watch each item keep its identity (and DOM node) while its position number updates live.'),
        TodoDemo({}),
        ReorderDemo({}),
        SwitchDemo({}),
        DynamicDemo({}),
        TransitionDemo({}),
        PortalDemo({})
    ));
