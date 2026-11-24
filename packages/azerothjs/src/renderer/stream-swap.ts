/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The browser half of streaming SSR: the small runtime a streamed page carries inline.
 *
 * Each out-of-order chunk calls `__AZS(id)`, which merges the chunk's resource seeds into
 * the global store hydration reads, then swaps the boundary's fallback DOM - the range
 * between `<!--azc:suspense:ID-->` and its BALANCED `<!--/azc-->` - for the template's
 * settled children. After the swap the DOM is byte-equal to a buffered render of that
 * settled state, which is what lets hydration adopt it node for node.
 *
 * {@link azsRuntime} must stay SELF-CONTAINED: no imports, no outer captures, and no
 * TypeScript-only syntax that survives erasure, because it ships through
 * Function.prototype.toString into an inline script. The tests invoke the same exported
 * function, so the code browsers run is the code under test.
 */

import { escapeAttr } from '../reactivity/ssr.ts';

/** @internal The window shape the runtime installs onto. */
interface AzsWindow
{
    __AZS_S?: Record<string, unknown>;
    __AZS?: ((id: number) => void) & {
        swapped?: WeakSet<Comment>;
        delivered?: WeakSet<Comment>;
        discard?: (first: ChildNode | null, end: ChildNode | null) => void;
    };
}

/** The hydration client takes DOM ownership after claiming a numbered boundary. */
interface StreamAnchor extends Comment
{
    __azsClaimed?: boolean;
}

/** @internal A legacy swap runtime leaves its already delivered boundary indistinguishable. */
export function claimStreamBoundary(open: StreamAnchor): boolean | undefined
{
    open.__azsClaimed = true;
    const swap = (globalThis as AzsWindow).__AZS;
    return swap === undefined ? false : (swap.delivered ?? swap.swapped)?.has(open);
}

/** Discard the seed groups whose numbered markers will be removed by local recovery. */
export function discardStreamRange(start: ChildNode, end: ChildNode): void
{
    (globalThis as AzsWindow).__AZS?.discard?.(start.nextSibling, end);
}

/** Retire all numbered groups whose markers leave with the root's existing contents. */
export function discardStreamChildren(root: HTMLElement): void
{
    (globalThis as AzsWindow).__AZS?.discard?.(root.firstChild, null);
}

/** @internal Installs the seed store and the swap entry point. Self-contained by contract. */
export function azsRuntime(): void
{
    const host = globalThis as AzsWindow;
    const store: Record<string, unknown> = host.__AZS_S ?? {};
    host.__AZS_S = store;
    const delivered = host.__AZS?.delivered ?? new WeakSet<Comment>();
    function walkBoundaries(first: ChildNode | null, end: ChildNode | null, visit: (id: string, marker: Comment) => void): void
    {
        if (first === null || first === end)
        {
            return;
        }
        // Restrict the walk to these siblings and their subtrees. A range's exclusive
        // end is its closing comment, so the walker also visits the stopping point.
        const walker = document.createTreeWalker(first.parentNode as Node, 128 /* SHOW_COMMENT */);
        walker.currentNode = first;
        for (let node = first.nodeType === 8 ? first as Node : walker.nextNode(); node !== null && node !== end; node = walker.nextNode())
        {
            const marker = node as Comment;
            const id = /^azc:suspense:(\d+)$/.exec(marker.data)?.[1];
            if (id !== undefined)
            {
                visit(id, marker);
            }
        }
    }
    function discard(first: ChildNode | null, end: ChildNode | null): void
    {
        const ids = new Set<string>();
        walkBoundaries(first, end, id => ids.add(id));
        if (ids.size > 0)
        {
            for (const key of Object.keys(store))
            {
                const dot = key.indexOf('.');
                if (dot > 0 && ids.has(key.slice(0, dot)))
                {
                    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- only groups removed with this range
                    delete store[key];
                }
            }
        }
    }
    host.__AZS = function (id: number): void
    {
        const doc = document;
        const seedScript = doc.querySelector(`script[data-azs-seed="${ id }"]`);
        seedScript?.remove();
        const template = doc.querySelector<HTMLTemplateElement>(`template[data-azs="${ id }"]`);
        if (template === null)
        {
            return;
        }
        const target = `azc:suspense:${ id }`;
        let open: StreamAnchor | null = null;
        const stack: Node[] = [doc.body];
        while (stack.length > 0 && open === null)
        {
            let child = (stack.pop() as Node).firstChild;
            while (child !== null)
            {
                if (child.nodeType === 8 && (child as Comment).data === target)
                {
                    open = child as Comment;
                    break;
                }
                if (child.nodeType === 1)
                {
                    stack.push(child);
                }
                child = child.nextSibling;
            }
        }
        if (open === null || open.__azsClaimed)
        {
            // A client-owned or removed boundary has no server DOM work left.
            template.remove();
            return;
        }
        // Balanced walk: nested azc ranges inside the fallback raise depth, so the close
        // found matches THIS boundary's open - the same discipline the hydrator uses.
        let depth = 0;
        let node = open.nextSibling;
        const removable: ChildNode[] = [];
        while (node !== null)
        {
            if (node.nodeType === 8)
            {
                const data = (node as Comment).data;
                if (data.indexOf('azc:') === 0)
                {
                    depth++;
                }
                else if (data === '/azc')
                {
                    if (depth === 0)
                    {
                        break;
                    }
                    depth--;
                }
            }
            removable.push(node);
            node = node.nextSibling;
        }
        if (node === null)
        {
            template.remove();
            return;
        }
        discard(open.nextSibling, node);
        for (const gone of removable)
        {
            gone.remove();
        }
        // A late or orphaned chunk never installs seeds for a range the client owns.
        if (seedScript !== null)
        {
            try
            {
                const parsed = JSON.parse(seedScript.textContent) as Record<string, unknown>;
                for (const key of Object.keys(parsed))
                {
                    if (/^\d+\.(?:\d+|l)$/.test(key))
                    {
                        store[key] = parsed[key];
                    }
                }
            }
            catch
            {
                // A torn seed is recovered when hydration claims the delivered range.
            }
        }
        // Already-settled descendants arrived inside this template. Remember their
        // selected branch independently of seed JSON, which can be torn or absent.
        const inline = template.getAttribute('data-azs-inline');
        if (inline)
        {
            const ids = new Set(inline.split(' '));
            walkBoundaries(template.content.firstChild, null, (childId, marker) =>
            {
                if (ids.has(childId))
                {
                    delivered.add(marker);
                }
            });
        }
        (node.parentNode as ParentNode).insertBefore(template.content, node);
        delivered.add(open);
        template.remove();
    };
    host.__AZS.discard = discard;
    host.__AZS.delivered = delivered;
    // Ordinal-based clients cannot read these seeds. Let them adopt their fallback
    // or recover before evaluating settled children with the wrong data type.
    host.__AZS.swapped = new WeakSet<Comment>();
}

/**
 * @internal The inline script installing {@link azsRuntime}, emitted once per stream before
 * the first out-of-order chunk. `nonce` feeds a CSP that disallows bare inline scripts.
 */
export function streamRuntimeScript(nonce?: string): string
{
    const attribute = nonce === undefined ? '' : ` nonce="${ escapeAttr(nonce) }"`;
    return `<script${ attribute }>(${ azsRuntime.toString() })();document.currentScript.remove()</script>`;
}
