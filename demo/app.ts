// ============================================================================
// AZEROTHJS — Demo Entry
// ============================================================================
//
// A router-driven, component-based showcase of the whole framework.
// The route table and shared router live in ./router.ts; the
// persistent layout is ./shell.ts; each section is a page component
// under ./pages/.
//
// Run: npx vite demo
// ============================================================================

import { render } from '@azerothjs/core';
import { AppShell } from './shell.ts';

const root = document.getElementById('app')!;
render(() => AppShell({}), root);

// ── Hot Module Replacement ──────────────────────────────────────
//
// AzerothJS is fine-grained with no VDOM, so there's no component
// tree to reconcile — the right HMR model is a clean root re-render.
// We put the HMR boundary here at the entry: any module change
// (including a `.azeroth` file deep in the graph) bubbles to this
// `accept`, which re-renders with the FRESH module. render() disposes
// the previous tree first, so it's a flash-free swap with no page
// reload. (Typed via a tiny cast so we don't depend on vite/client.)

interface HotApi
{
    accept(dep: string, callback: (module: unknown) => void): void;
}

const hot = (import.meta as unknown as { hot?: HotApi }).hot;
if (hot)
{
    hot.accept('./shell.ts', (module) =>
    {
        if (module)
        {
            const next = module as typeof import('./shell.ts');
            render(() => next.AppShell({}), root);
        }
    });
}
