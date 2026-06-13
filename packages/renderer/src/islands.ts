// The client half of islands: find every island anchor the server emitted
// (island() in @azerothjs/server), load its module through the caller's
// registry, and run the EXISTING hydrate() against that subtree alone. The
// page shell around the islands stays exactly the HTML the server sent -
// no framework code ever touches it.
//
// Loading is registry-based on purpose: a bare dynamic import of a string
// the bundler cannot see breaks code-splitting and silently 404s in
// production. Vite's `import.meta.glob` produces exactly the registry shape
// this accepts, so the call site is one line and every island becomes its
// own chunk.

import { hydrate } from './hydrate.ts';

/** What an island loader resolves to: the module or its component. */
export type IslandComponent = (props: Record<string, unknown>) => HTMLElement;

/** Loader registry: island src -> dynamic import. */
export type IslandRegistry = Record<string, () => Promise<{ default: IslandComponent } | IslandComponent>>;

/**
 * Revives every island under `root`: matches each anchor's `src` against
 * the registry, loads the module, parses the embedded props, and hydrates
 * the island's existing markup in place. Unknown srcs warn and stay
 * static; nested anchors are skipped (islands do not nest).
 *
 * @param registry - src -> loader; `import.meta.glob('./islands/*.azeroth')`
 *                   is the idiomatic Vite form
 * @param root - Where to search (default: the whole document)
 *
 * @returns The number of islands revived
 *
 * @example
 * ```ts
 * // Client entry of an islands page - this is ALL of it:
 * import { hydrateIslands } from '@azerothjs/renderer';
 *
 * hydrateIslands(import.meta.glob('./islands/*.azeroth'));
 * ```
 */
export async function hydrateIslands(registry: IslandRegistry, root: ParentNode = document): Promise<number>
{
    const anchors = Array.from(root.querySelectorAll('[data-azeroth-island]'));
    let revived = 0;

    await Promise.all(anchors.map(async (anchor) =>
    {
        // Islands do not nest: an anchor inside another island's subtree
        // belongs to markup only its parent could own.
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
