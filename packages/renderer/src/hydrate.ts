// ============================================================================
// AZEROTHJS — hydrate() (Adopt Server-Rendered DOM)
// ============================================================================
//
// hydrate() brings server-rendered markup to life WITHOUT recreating it. It
// runs the component in 'hydrate' mode (so h()/control-flow return adoption
// descriptors instead of building DOM), then walks the resulting descriptor
// tree against the existing DOM in `container`, attaching event listeners and
// reactive effects onto the live nodes.
//
//   // server: const html = renderToString(() => App({}));
//   // client:
//   hydrate(() => App({}), document.getElementById('app')!);
//
// If the server and client trees diverge (a structural mismatch), hydration
// throws internally and falls back to a full client render() — so the app
// always boots, even when SSR/CSR disagree.
//
// ============================================================================

import { createRoot, runInMode, isHydrationNode, HydrationCursor, HydrationMismatchError } from '@azerothjs/reactivity';
import { containerDisposers } from './container-disposers.ts';
import { render } from './render.ts';

/**
 * Hydrates a server-rendered tree in `container`, adopting its existing DOM.
 *
 * Unlike {@link render}, this does NOT clear the container or append new
 * nodes — it claims the markup already there. A previous mount on the same
 * container (from render() or hydrate()) is disposed first.
 *
 * @param component - A thunk that builds the root element (same as render's)
 * @param container - The DOM element holding the server-rendered markup
 *
 * @example
 * ```ts
 * hydrate(() => App({}), document.getElementById('app')!);
 * ```
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

                root.hydrate(new HydrationCursor(container));
            });
        });
    }
    catch (error)
    {
        if (!(error instanceof HydrationMismatchError))
        {
            throw error;
        }

        // Structural mismatch — dev-warn and fall back to a clean client
        // render so the app boots regardless. Dispose the partial hydrate
        // root first; render() then clears the container and mounts fresh.
        // Read NODE_ENV off globalThis so this needs no Node type dependency.
        const proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
        if (!proc || proc.env?.NODE_ENV !== 'production')
        {
            console.warn(`${ error.message } — falling back to full client render.`);
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
