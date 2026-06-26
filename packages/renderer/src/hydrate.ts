/**
 * MODULE: renderer/hydrate
 *
 * hydrate() brings server-rendered markup to life WITHOUT recreating it. It runs the
 * component in 'hydrate' mode (so h()/control-flow return adoption descriptors instead of
 * building DOM), then walks the descriptor tree against the existing DOM in `container`,
 * attaching event listeners and reactive effects onto the live nodes. If the server and
 * client trees diverge, it throws internally and falls back to a full client render() - so
 * the app always boots. render()-ing into an SSR container instead would clear the markup
 * and rebuild (a flash, and lost focus/scroll/input state).
 */

import { createRoot, runInMode, isHydrationNode, HydrationCursor, HydrationMismatchError } from '@azerothjs/reactivity';
import { containerDisposers } from './container-disposers.ts';
import { render } from './render.ts';

/**
 * hydrate
 *
 * PURPOSE:
 * Adopts the server-rendered DOM in `container`, wiring listeners and reactive effects onto
 * the existing nodes instead of clearing and rebuilding them.
 *
 * WHY IT EXISTS:
 * SSR ships HTML the user already sees; re-rendering it on the client would flash and
 * discard DOM state. Hydration must instead claim those nodes top-down and attach behavior -
 * which the inside-out evaluation of h() cannot do directly, hence the descriptor-tree
 * approach this function drives.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, renderer; the client entry point for server-rendered pages. Runs the tree in
 * runInMode('hydrate'), so the same component code produces adoption descriptors that walk
 * the server DOM via a HydrationCursor.
 *
 * INPUT CONTRACT:
 * - component: the same thunk used for {@link render}; in hydrate mode it returns a
 *   descriptor tree, not real DOM.
 * - container: the element holding the server-rendered markup.
 *
 * OUTPUT CONTRACT:
 * - Returns void. On success the existing DOM is adopted and live; on a structural mismatch
 *   it disposes the partial mount and falls back to {@link render} (clean client render).
 *
 * WHY THIS DESIGN:
 * Wrapping the walk in createRoot gives the adopted tree the same disposal scope render()
 * provides. The mismatch -> full-render fallback guarantees the app boots even when SSR and
 * CSR disagree; the cursor's assertExhausted catches "server rendered more than expected".
 *
 * WHEN TO USE:
 * On the client, once, to revive a page rendered by renderToString/renderToDocument.
 *
 * WHEN NOT TO USE:
 * For a purely client-rendered app (use {@link render}). Do not call it on a container whose
 * markup was not produced by this framework's SSR (it will mismatch and fall back).
 *
 * EDGE CASES:
 * - Root component not producing a hydratable node, or any structural mismatch, triggers a
 *   dev warning and a clean render() fallback.
 * - A previous mount on the same container (from render or hydrate) is disposed first.
 *
 * PERFORMANCE NOTES:
 * No DOM construction on the happy path - only listener/effect attachment over existing
 * nodes. The fallback path pays for a full client render only when SSR/CSR diverged.
 *
 * DEVELOPER WARNING:
 * The client tree must match the server output structurally; a mismatch silently degrades to
 * a full re-render (losing the no-flash benefit). Keep SSR and CSR rendering the same tree
 * for the same inputs.
 *
 * @param component - A thunk that builds the root element (same as render's).
 * @param container - The element holding the server-rendered markup.
 * @returns void
 * @see {@link render}
 * @example
 * hydrate(() => App({}), document.getElementById('app')!);
 */
export function hydrate(component: () => HTMLElement, container: HTMLElement): void
{
    // Tear down any previous mount on this container first.
    const previousDispose = containerDisposers.get(container);
    if (previousDispose)
    {
        previousDispose();
        containerDisposers.delete(container);
    }

    try
    {
        runInMode('hydrate', () =>
        {
            createRoot((dispose) =>
            {
                containerDisposers.set(container, dispose);

                // In hydrate mode the component returns a descriptor tree.
                const root = component() as unknown;
                if (!isHydrationNode(root))
                {
                    throw new HydrationMismatchError('root component did not produce a hydratable node');
                }

                const cursor = new HydrationCursor(container);
                root.hydrate(cursor);
                cursor.assertExhausted('root container');
            });
        });
    }
    catch (error)
    {
        if (!(error instanceof HydrationMismatchError))
        {
            throw error;
        }

        // Structural mismatch: dev-warn and fall back to a clean client render so the app
        // boots regardless. Dispose the partial hydrate root first; render() then clears the
        // container and mounts fresh. Read NODE_ENV off globalThis (no Node type dependency).
        const proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
        if (!proc || proc.env?.NODE_ENV !== 'production')
        {
            console.warn(`${ error.message } - falling back to full client render.`);
        }

        const partialDispose = containerDisposers.get(container);
        if (partialDispose)
        {
            partialDispose();
            containerDisposers.delete(container);
        }

        render(component, container);
    }
}
