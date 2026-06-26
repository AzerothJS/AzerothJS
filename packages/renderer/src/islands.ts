/**
 * MODULE: renderer/islands
 *
 * The client half of islands architecture: find every island anchor the server emitted
 * (island() in @azerothjs/server), load its module through the caller's registry, and run the
 * existing {@link hydrate} against that subtree alone. The page shell around the islands stays
 * exactly the HTML the server sent - no framework code ever touches it. Loading is
 * registry-based on purpose: a bare dynamic import of a string the bundler cannot see breaks
 * code-splitting and 404s in production, whereas Vite's import.meta.glob produces exactly the
 * registry shape this accepts, so each island becomes its own chunk and the call site is one line.
 */

import { hydrate } from './hydrate.ts';

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
 * - Nested island anchors are skipped (islands do not nest).
 * - Props are read from the anchor's data attribute and JSON-parsed (defaulting to {}).
 *
 * PERFORMANCE NOTES:
 * Islands load and hydrate in parallel (Promise.all). Cost scales with the number/size of
 * islands, not the page; each island is its own code-split chunk.
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
 * import { hydrateIslands } from '@azerothjs/renderer';
 * hydrateIslands(import.meta.glob('./islands/*.azeroth'));
 */
export async function hydrateIslands(registry: IslandRegistry, root: ParentNode = document): Promise<number>
{
    const anchors = Array.from(root.querySelectorAll('[data-azeroth-island]'));
    let revived = 0;

    await Promise.all(anchors.map(async (anchor) =>
    {
        // Islands do not nest: an anchor inside another island's subtree belongs to markup only
        // its parent could own.
        if (anchor.parentElement?.closest('[data-azeroth-island]'))
        {
            console.warn(`hydrateIslands: nested island "${ anchor.getAttribute('data-azeroth-island') }" skipped - islands do not nest.`);
            return;
        }

        const src = anchor.getAttribute('data-azeroth-island') ?? '';
        const load = registry[src];
        if (!load)
        {
            console.warn(`hydrateIslands: no loader registered for "${ src }" - island left static.`);
            return;
        }

        const loaded = await load();
        const component = typeof loaded === 'function' ? loaded : loaded.default;
        const props = JSON.parse(anchor.getAttribute('data-azeroth-props') ?? '{}') as Record<string, unknown>;

        hydrate(() => component(props), anchor as HTMLElement);
        revived++;
    }));

    return revived;
}
