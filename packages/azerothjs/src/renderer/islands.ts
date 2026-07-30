/**
 * MODULE: renderer/islands
 *
 * The client half of islands architecture: find every island anchor the server emitted
 * (island() in azerothjs), load its module through the caller's registry, and run the
 * existing {@link hydrate} against that subtree alone. The page shell around the islands stays
 * exactly the HTML the server sent - no framework code ever touches it. Loading is
 * registry-based on purpose: a bare dynamic import of a string the bundler cannot see breaks
 * code-splitting and 404s in production, whereas Vite's import.meta.glob produces exactly the
 * registry shape this accepts, so each island becomes its own chunk and the call site is one line.
 */

import { createRoot, runInMode } from '../reactivity/index.ts';
import { isHydrationNode, HydrationCursor, HydrationMismatchError } from '../reactivity/internal.ts';
import { containerDisposers } from './container-disposers.ts';

/** What an island loader resolves to: the component, or a module whose default is the component. */
export type IslandComponent = (props: Record<string, unknown>) => HTMLElement;

/** Loader registry: island src -> dynamic import (e.g. from import.meta.glob). */
export type IslandRegistry = Record<string, () => Promise<{ default: IslandComponent } | IslandComponent>>;

/**
 * hydrateIslands
 *
 * PURPOSE:
 * Revives every island under `root`: for each anchor, matches its `src` against the registry,
 * loads the module, parses the embedded props, and hydrates the island's existing markup in place.
 *
 * WHY IT EXISTS:
 * Islands architecture ships a mostly-static page and hydrates only interactive regions, so the
 * client JS and hydration cost scale with the islands, not the whole page. This is the one
 * client entry point that locates those regions and brings each to life independently, leaving
 * the surrounding server HTML untouched.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, renderer; the client driver for partial hydration. It reuses {@link hydrate}
 * per-island, so each island adopts its own server DOM (no full-page hydration).
 *
 * INPUT CONTRACT:
 * - registry: src -> loader. The idiomatic form is import.meta.glob('./islands/*.azeroth'),
 *   which the bundler can see and split.
 * - root: where to search; defaults to the whole document.
 *
 * OUTPUT CONTRACT:
 * - Resolves to the number of islands revived. Unknown srcs warn and stay static; nested
 *   anchors (an island inside another island's subtree) are skipped with a warning.
 *
 * WHY THIS DESIGN:
 * Registry loading (not string dynamic import) keeps code-splitting working and avoids silent
 * production 404s. Per-island hydrate() means each interactive region is independent - one
 * island failing to load does not break the others, and the static shell never runs framework code.
 *
 * WHEN TO USE:
 * As the client entry of an islands/partial-hydration page, once on load.
 *
 * WHEN NOT TO USE:
 * For a fully-interactive SPA - use {@link hydrate} (or {@link render}) on the whole app instead.
 *
 * EDGE CASES:
 * - A src with no registered loader warns and leaves that island static.
 * - A loader rejection or malformed props JSON warns and leaves THAT island static; the
 *   remaining islands still revive.
 * - Nested island anchors are skipped (islands do not nest).
 * - Props are read from the anchor's data attribute and JSON-parsed (defaulting to {}).
 *
 * PERFORMANCE NOTES:
 * Islands load and hydrate in parallel (Promise.allSettled). Cost scales with the number/size
 * of islands, not the page; each island is its own code-split chunk.
 *
 * DEVELOPER WARNING:
 * Use a bundler-visible registry (import.meta.glob), not raw dynamic-import strings, or chunks
 * will not split and will 404 in production. Island props must be JSON-serializable (they cross
 * the server->client boundary as a data attribute).
 *
 * @param registry - src -> loader (e.g. import.meta.glob('./islands/*.azeroth')).
 * @param root - Where to search (default: document).
 * @returns A promise resolving to the number of islands revived.
 * @see {@link hydrate}
 * @example
 * import { hydrateIslands } from '../renderer/index.ts';
 * hydrateIslands(import.meta.glob('./islands/*.azeroth'));
 */
export async function hydrateIslands(registry: IslandRegistry, root: ParentNode = document): Promise<number>
{
    const anchors = Array.from(root.querySelectorAll('[data-azeroth-island]'));
    let revived = 0;

    // allSettled + a per-anchor catch: the module contract is that one island failing to
    // load does not break the others, and anchor attributes come from server HTML - one
    // serialization bug must degrade to one static island, not a whole-page outage.
    await Promise.allSettled(anchors.map(async (anchor) =>
    {
        // Islands do not nest: an anchor inside another island's subtree belongs to markup only
        // its parent could own.
        if (anchor.parentElement?.closest('[data-azeroth-island]'))
        {
            console.warn(`hydrateIslands: nested island "${ anchor.getAttribute('data-azeroth-island') }" skipped - islands do not nest.`);
            return;
        }

        const src = anchor.getAttribute('data-azeroth-island') ?? '';
        // Object.hasOwn: a plain index would treat an inherited key (`constructor`,
        // `toString`) as a loader and call it, crashing instead of degrading.
        const load = Object.hasOwn(registry, src) ? registry[src] : undefined;
        if (!load)
        {
            console.warn(`hydrateIslands: no loader registered for "${ src }" - island left static.`);
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
            console.warn(`hydrateIslands: island "${ src }" failed to revive - left static.`, error);
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

        const proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
        if (!proc || proc.env?.NODE_ENV !== 'production')
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
