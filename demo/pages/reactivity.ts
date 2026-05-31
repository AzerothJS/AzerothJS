// ============================================================================
// AZEROTHJS DEMO — Reactivity Page
// ============================================================================
//
// Showcases the core reactive primitives: signals, memos, effects,
// batched updates, untracked reads, debounced (deferred) values,
// and O(1) selection tracking.
//
// ============================================================================

import {
    h,
    For,
    batch,
    untrack,
    classList,
    createSignal,
    createMemo,
    createEffect,
    createDeferred,
    createSelector,
    defineComponent
} from '@azerothjs/core';
import { DemoCard, PageHeader, Callout } from '../ui.ts';

// ── Signals, memos, effects ─────────────────────────────────────

const SignalsDemo = defineComponent(() =>
{
    const [count, setCount] = createSignal(0);
    const doubled = createMemo(() => count() * 2);
    const isEven = createMemo(() => count() % 2 === 0);

    // An effect mirrors the value into a small log — proof that
    // effects re-run automatically when their dependencies change.
    // Each entry has a unique id so For keys it stably (values can
    // repeat; positions can't be the key for a prepend-log).
    let logId = 0;
    const [log, setLog] = createSignal<{ id: number; value: number }[]>([]);
    createEffect(() =>
    {
        const c = count();
        untrack(() => setLog(prev => [{ id: logId++, value: c }, ...prev].slice(0, 6)));
    });

    return DemoCard(
        {
            title: 'Signals, Memos & Effects',
            description: 'A signal is the atomic unit of state; memos derive from it; effects run side-effects when it changes — all fine-grained, no re-render.',
            tags: ['createSignal', 'createMemo', 'createEffect', 'batch']
        },
        h('div', { class: 'counter-display' },
            h('span', { class: classList(['counter-value', { 'is-even': isEven }]) },
                () => String(count()))
        ),
        h('div', { class: 'stat-row' },
            h('div', { class: 'mini-stat' },
                h('span', { class: 'mini-stat-label' }, 'doubled'),
                h('span', { class: 'mini-stat-value' }, () => String(doubled()))),
            h('div', { class: 'mini-stat' },
                h('span', { class: 'mini-stat-label' }, 'parity'),
                h('span', { class: 'mini-stat-value' }, () => (isEven() ? 'even' : 'odd')))
        ),
        h('div', { class: 'btn-row' },
            h('button', { class: 'btn', onClick: () => setCount(c => c - 1) }, '− 1'),
            h('button', { class: 'btn btn-primary', onClick: () => setCount(c => c + 1) }, '+ 1'),
            // batch() collapses three writes into ONE effect flush.
            h('button',
                { class: 'btn', onClick: () => batch(() =>
                {
                    setCount(c => c + 1);
                    setCount(c => c + 1);
                    setCount(c => c + 1);
                }) },
                '+3 (batched)'),
            h('button', { class: 'btn btn-ghost', onClick: () => setCount(0) }, 'Reset')
        ),
        h('p', { class: 'effect-log-label' }, 'effect log (latest first):'),
        h('div', { class: 'effect-log' },
            For({ each: log, key: (entry) => entry.id },
                (entry) => h('span', { class: 'effect-log-chip' }, String(entry.value))))
    );
});

// ── Debounced search (createDeferred) ───────────────────────────

const DeferredDemo = defineComponent(() =>
{
    const fruits = [
        'Apple', 'Apricot', 'Banana', 'Blueberry', 'Cherry', 'Date',
        'Fig', 'Grape', 'Kiwi', 'Lemon', 'Mango', 'Orange', 'Peach',
        'Pear', 'Plum', 'Raspberry', 'Strawberry', 'Watermelon'
    ];

    const [query, setQuery] = createSignal('');
    // The deferred value only settles 300ms after the LAST keystroke.
    const deferred = createDeferred(query, { timeout: 300 });

    const results = createMemo(() =>
    {
        const q = deferred().trim().toLowerCase();
        return q === '' ? fruits : fruits.filter(f => f.toLowerCase().includes(q));
    });

    const settling = createMemo(() => query() !== deferred());

    return DemoCard(
        {
            title: 'Debounced Search',
            description: 'createDeferred wraps a signal so expensive work (here, filtering) only runs after the user stops typing.',
            tags: ['createDeferred', 'createMemo']
        },
        h('input', {
            class: 'text-input',
            type: 'text',
            placeholder: 'Filter fruits — results update 300ms after you stop…',
            onInput: (e: Event) => setQuery((e.target as HTMLInputElement).value)
        }),
        h('p', { class: 'search-status' },
            () => settling()
                ? 'typing…'
                : `${ results().length } match${ results().length === 1 ? '' : 'es' }`),
        h('div', { class: 'chip-grid' },
            For({ each: results, key: (f) => f },
                (fruit) => h('span', { class: 'chip' }, fruit)))
    );
});

// ── O(1) selection (createSelector) ─────────────────────────────

const SelectorDemo = defineComponent(() =>
{
    const swatches = [
        { id: 'rose', hex: '#f43f5e' },
        { id: 'amber', hex: '#f59e0b' },
        { id: 'emerald', hex: '#10b981' },
        { id: 'sky', hex: '#0ea5e9' },
        { id: 'violet', hex: '#8b5cf6' },
        { id: 'slate', hex: '#64748b' }
    ];

    const [selected, setSelected] = createSignal('emerald');
    // Only the previously- and newly-selected swatches' bindings
    // re-run on a change — not all six.
    const isSelected = createSelector(selected);

    return DemoCard(
        {
            title: 'O(1) Selection',
            description: 'createSelector notifies only the two affected items when the selection changes — not the whole list. Scales to thousands of rows.',
            tags: ['createSelector']
        },
        h('div', { class: 'swatch-grid' },
            For({ each: () => swatches, key: (s) => s.id },
                (swatch) => h('button', {
                    class: classList(['swatch', { 'swatch-selected': () => isSelected(swatch.id) }]),
                    style: `--swatch: ${ swatch.hex }`,
                    onClick: () => setSelected(swatch.id)
                }, swatch.id))),
        h('p', { class: 'search-status' }, () => `selected: ${ selected() }`)
    );
});

/** The Reactivity route page. */
export const ReactivityPage = defineComponent(() =>
    h('div', { class: 'page' },
        PageHeader('Reactivity', 'Fine-grained state that updates exactly what changed — nothing more.'),
        Callout('tip', 'Every value below is a signal, memo, or effect. There is no component re-render — bindings update individual DOM nodes directly.'),
        SignalsDemo({}),
        DeferredDemo({}),
        SelectorDemo({})
    ));
