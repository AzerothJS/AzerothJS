// ============================================================================
// AZEROTHJS — Transition Demo
// ============================================================================
//
// Three independent toggles, each pairing the `<Transition>`
// component with a different CSS class family:
//
//   demo-fade   — opacity-only crossfade
//   demo-slide  — slide in from the right + fade
//   demo-pop    — scale up from 0.85 + fade
//
// All three share the same component (`Transition`); only the
// `name` prop and CSS rules change. The demo proves that a
// single small primitive covers a wide range of motion designs
// just by swapping out CSS — no JavaScript animation engine
// needed.
//
// ============================================================================

import {
    defineComponent,
    h,
    createSignal,
    Transition
} from '@azerothjs/core';

// ── Helpers ──────────────────────────────────────────────────

/**
 * Builds one row: a labelled toggle button plus a Transition
 * wrapper that fades/slides/pops the panel in and out.
 */
function transitionRow(label: string, transitionName: string, panelText: string): HTMLElement
{
    const [isOpen, setIsOpen] = createSignal(false);

    return h('div', { class: 'transition-demo-row' },
        h('div', { class: 'transition-demo-row-header' },
            h('span', { class: 'transition-demo-row-label' }, label),
            h('button',
                {
                    class: 'btn-ghost btn-sm',
                    onClick: () => setIsOpen(prev => !prev)
                },
                () => isOpen() ? 'Hide' : 'Show'
            )
        ),
        h('div', { class: 'transition-demo-stage' },
            Transition({
                when: isOpen,
                name: transitionName,
                children: () => h('div', { class: 'transition-demo-panel' },
                    h('span', { class: 'transition-demo-panel-name' }, transitionName),
                    h('span', { class: 'transition-demo-panel-text' }, panelText)
                )
            })
        )
    );
}

// ── Component ────────────────────────────────────────────────

export const TransitionDemo = defineComponent(() =>
    h('div', { class: 'glass' },
        h('div', { class: 'feature-tags' },
            ...['Transition', 'enter-from', 'enter-active', 'enter-to',
                'leave-from', 'leave-active', 'leave-to', 'transitionend']
                .map(tag => h('span', { class: 'feature-tag' }, tag))
        ),
        h('h2', {}, '🎬 Transition — Fade, Slide, Pop'),

        h('p', { class: 'transition-demo-intro' },
            'Same primitive, different CSS class families. <Transition> ',
            'applies enter/leave classes around mount/unmount and waits ',
            'for transitionend before removing the element from the DOM.'
        ),

        transitionRow(
            'Fade — opacity only',
            'demo-fade',
            'Crossfades over 300 ms.'
        ),
        transitionRow(
            'Slide — translate + fade',
            'demo-slide',
            'Slides in from the right over 350 ms.'
        ),
        transitionRow(
            'Pop — scale + fade',
            'demo-pop',
            'Scales up from 0.85 over 250 ms with a touch of overshoot.'
        )
    )
);
