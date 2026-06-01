// ============================================================================
// AZEROTHJS DEMO — Compiler Page
// ============================================================================
//
// Renders a component that was authored in a `.azeroth` file and
// compiled to h() by @azerothjs/compiler (via the Vite plugin).
// This is the two halves connecting: markup syntax → runtime.
//
// ============================================================================

import { h, defineComponent } from '@azerothjs/core';
import { DemoCard, PageHeader, Callout } from '../ui.ts';
import LiveCounter from './live-counter.azeroth';
import StyledCard from './styled-card.azeroth';

export const CompilerPage = defineComponent(() =>
    h('div', { class: 'page' },
        PageHeader('Compiler', 'The other half: components written in AzerothJS markup (a JSX-style syntax), compiled to h() by our own compiler.'),
        Callout('tip', 'These components live in demo/pages/*.azeroth. The Vite plugin compiles their markup to h() calls — then they run with the exact same fine-grained reactivity as every hand-written demo.'),
        DemoCard(
            {
                title: 'Live .azeroth Component',
                description: 'Authored as markup ({count()}, onClick, conditional), compiled live, fully reactive.',
                tags: ['.azeroth', 'compiler', 'vite-plugin']
            },
            LiveCounter()),
        DemoCard(
            {
                title: 'Scoped CSS via css``',
                description: 'A .azeroth component with co-located, hashed, collision-free styles — injected once, no build-time scope pass needed.',
                tags: ['.azeroth', 'css', 'scoped']
            },
            StyledCard())));
