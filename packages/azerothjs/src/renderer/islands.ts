/**
 * The client half of islands architecture: find every island anchor the server emitted, load
 * its module through the caller's registry, and hydrate that subtree alone. The shell around
 * the islands stays exactly the HTML the server sent, with no framework code touching it.
 *
 * Loading goes through a registry deliberately. A dynamic import of a string the bundler
 * cannot see breaks code-splitting and 404s in production, whereas `import.meta.glob`
 * produces exactly this registry shape, so each island becomes its own chunk and the call
 * site stays one line.
 */

import { createRoot, runInMode } from '../reactivity/index.ts';
import { DEV } from '../reactivity/dev.ts';
import { isHydrationNode, HydrationCursor, HydrationMismatchError } from '../reactivity/internal.ts';
import { containerDisposers } from './container-disposers.ts';

/** What an island loader resolves to: the component, or a module whose default is the component. */
export type IslandComponent = (props: Record<string, unknown>) => HTMLElement;

/** Loader registry: island src -> dynamic import (e.g. from import.meta.glob). */
export type IslandRegistry = Record<string, () => Promise<{ default: IslandComponent } | IslandComponent>>;

/**
 * Revives every island under `root`, loading each anchor's module from the registry, parsing
 * its embedded props, and hydrating that island's existing markup in place.
 *
 * Islands are independent: they load and hydrate in parallel, and a failure is contained to
 * one island. An unregistered `src`, a rejected loader or malformed props JSON each warn and
 * leave THAT island static while the rest revive.
 *
 * Islands do not nest. An anchor inside another island's subtree is skipped with a warning.
 *
 * Props cross the server-client boundary as a data attribute, so they must be
 * JSON-serializable.
 *
 * @param registry - Maps island src to loader. Use a bundler-visible form such as
 *                   `import.meta.glob`; raw dynamic-import strings do not split into chunks
 *                   and 404 in production.
 * @param root - Where to search. Defaults to the whole document.
 * @returns The number of islands revived.
 * @example
 * hydrateIslands(import.meta.glob('./islands/*.azeroth'));
 *
 * @see {@link hydrate} for a fully interactive app, where the whole page is hydrated.
 */
export async function hydrateIslands(registry: IslandRegistry, root: ParentNode = document): Promise<number>
{
    const anchors = Array.from(root.querySelectorAll('[data-azeroth-island]'));
    let revived = 0;

    // allSettled plus a per-anchor catch: one island failing to load must not break the others,
    // and anchor attributes come from server HTML, so one serialization bug degrades to one
    // static island rather than a whole-page outage.
    await Promise.allSettled(anchors.map(async (anchor) =>
    {
        // An anchor inside another island's subtree belongs to markup only its parent could own.
        if (anchor.parentElement?.closest('[data-azeroth-island]'))
        {
            if (DEV)
            {
                console.warn(`hydrateIslands: nested island "${ anchor.getAttribute('data-azeroth-island') }" skipped - islands do not nest.`);
            }
            return;
        }

        const src = anchor.getAttribute('data-azeroth-island') ?? '';
        // Object.hasOwn: a plain index would treat an inherited key (`constructor`,
        // `toString`) as a loader and call it, crashing instead of degrading.
        const load = Object.hasOwn(registry, src) ? registry[src] : undefined;
        if (!load)
        {
            if (DEV)
            {
                console.warn(`hydrateIslands: no loader registered for "${ src }" - island left static.`);
            }
            return;
        }

        try
        {
            const loaded = await load();
            const component = typeof loaded === 'function' ? loaded : loaded.default;
            const props = JSON.parse(anchor.getAttribute('data-azeroth-props') ?? '{}') as Record<string, unknown>;

            hydrateIslandRoot(() => component(props), anchor as HTMLElement);
            revived++;
        }
        catch (error)
        {
            // error, not a gated warn: the island's interactive code did not load, the exception
            // is swallowed here, and production is where that needs a signal.
            console.error(`hydrateIslands: island "${ src }" failed to revive - left static.`, error);
        }
    }));

    return revived;
}

/**
 * Adopts ONE island in place. The anchor IS the island's root element (the server rides
 * the island attributes on the component's own root - no wrapper node), so this walks a
 * single-node cursor over the anchor itself rather than a container's children. On a
 * structural mismatch, the anchor is replaced in place with a fresh client render - the
 * shell around it is never touched.
 *
 * @internal
 */
function hydrateIslandRoot(component: () => HTMLElement, anchor: HTMLElement): void
{
    // Tear down any previous mount on this island first (parity with hydrate()/render()).
    const previousDispose = containerDisposers.get(anchor);
    if (previousDispose)
    {
        previousDispose();
        containerDisposers.delete(anchor);
    }

    const parent = anchor.parentNode as Node;

    try
    {
        runInMode('hydrate', () =>
        {
            createRoot((dispose) =>
            {
                containerDisposers.set(anchor, dispose);

                const root = component() as unknown;
                if (!isHydrationNode(root))
                {
                    throw new HydrationMismatchError('island component did not produce a hydratable node');
                }

                // A cursor over exactly the anchor: the descriptor claims the island's
                // root element itself, then recurses into its children as usual.
                const cursor = new HydrationCursor(parent, [anchor]);
                root.hydrate(cursor);
                cursor.assertExhausted('island root');
            });
        });
    }
    catch (error)
    {
        if (!(error instanceof HydrationMismatchError))
        {
            throw error;
        }

        if (DEV)
        {
            console.warn(`${ error.message } - island replaced with a fresh client render.`);
        }

        const partialDispose = containerDisposers.get(anchor);
        if (partialDispose)
        {
            partialDispose();
            containerDisposers.delete(anchor);
        }

        // Replace-in-place: build the island fresh (plain dom mode) inside its own root so
        // its effects are owned and disposable, then swap it for the server markup.
        const fresh = createRoot((dispose) =>
        {
            const el = component();
            containerDisposers.set(el, dispose);
            return el;
        });
        anchor.replaceWith(fresh);
    }
}
