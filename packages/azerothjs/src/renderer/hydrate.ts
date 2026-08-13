/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Brings server-rendered markup to life without recreating it. The component runs in
 * 'hydrate' mode, so h() and the control-flow components return adoption descriptors instead
 * of DOM; the descriptor tree is then walked against the existing nodes, attaching listeners
 * and effects in place.
 *
 * When the server and client trees diverge it falls back to a full client render, so the app
 * always boots. Calling render() on an SSR container instead would clear the markup and
 * rebuild it, costing a flash and the page's focus, scroll and input state.
 */

import { createRoot } from '../reactivity/index.ts';
import { DEV } from '../reactivity/dev.ts';
import { isHydrationNode, HydrationCursor, HydrationMismatchError, resetSeedScopes, beginHydrationPass, runInPass, settleHydrationPass } from '../reactivity/internal.ts';
import type { MountNode } from '../component/index.ts';
import { containerDisposers } from './container-disposers.ts';
import { render } from './render.ts';

/**
 * Adopts the server-rendered DOM in `container`, attaching listeners and effects to the
 * existing nodes rather than clearing and rebuilding them.
 *
 * The client tree must match the server's structurally. A mismatch is not fatal - it warns
 * in development, disposes the partial mount and falls back to a clean {@link render} - but
 * it silently costs the no-flash benefit, so keep SSR and client rendering the same tree for
 * the same inputs. That fallback also covers a root component that produces no hydratable
 * node, and it fires for a deferred mismatch, such as a route still waiting on a lazy chunk,
 * exactly as it does for a synchronous one.
 *
 * A previous mount on the same container, from either render or hydrate, is disposed first.
 *
 * @param component - The same thunk {@link render} takes. In hydrate mode it returns a
 *                    descriptor tree rather than DOM.
 * @param container - The element holding the server-rendered markup.
 * @example
 * hydrate(() => App({}), document.getElementById('app')!);
 *
 * @see {@link render} for a purely client-rendered app.
 */
export function hydrate(component: () => MountNode, container: HTMLElement): void
{
    // A streamed page's seed ids count from zero per hydration pass.
    resetSeedScopes();

    const previousDispose = containerDisposers.get(container);
    if (previousDispose)
    {
        previousDispose();
        containerDisposers.delete(container);
    }

    /**
     * Also the pass's completion barrier. Adoption is not always finished when the call below
     * returns - a route waiting on a lazy chunk adopts from a later effect run - and a failure
     * there would otherwise escape as an unhandled rejection, leaving the server's markup on
     * screen and inert. The pass calls this instead, so a deferred mismatch ends the same way
     * a synchronous one does.
     */
    function fallBackToClientRender(error: unknown): void
    {
        if (!(error instanceof HydrationMismatchError))
        {
            throw error;
        }

        if (DEV)
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

    const pass = beginHydrationPass(fallBackToClientRender);

    try
    {
        runInPass(pass, () =>
        {
            createRoot((dispose) =>
            {
                containerDisposers.set(container, dispose);

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
    finally
    {
        // Closes the pass unless something took a deferHydration ticket, in which case the
        // last release closes it. Runs on the throw path too: runInPass has already routed
        // the error to the fallback and closed the pass, and settling again is harmless.
        settleHydrationPass(pass);
    }
}
