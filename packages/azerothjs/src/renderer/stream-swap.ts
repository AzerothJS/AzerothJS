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

/** @internal The window shape the runtime installs onto. */
interface AzsWindow
{
    __AZS_S?: Record<string, unknown>;
    __AZS?: (id: number) => void;
}

/** @internal Installs the seed store and the swap entry point. Self-contained by contract. */
export function azsRuntime(): void
{
    const host = globalThis as AzsWindow;
    const store: Record<string, unknown> = host.__AZS_S ?? {};
    host.__AZS_S = store;
    host.__AZS = function (id: number): void
    {
        const doc = document;
        const seedScript = doc.querySelector(`script[data-azs-seed="${ id }"]`);
        if (seedScript !== null)
        {
            try
            {
                const parsed = JSON.parse(seedScript.textContent) as Record<string, unknown>;
                for (const key in parsed)
                {
                    store[key] = parsed[key];
                }
            }
            catch
            {
                // A torn seed degrades to a client refetch; the swap still proceeds.
            }
            seedScript.remove();
        }
        const template = doc.querySelector<HTMLTemplateElement>(`template[data-azs="${ id }"]`);
        const target = `azc:suspense:${ id }`;
        let open: Comment | null = null;
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
        if (open === null)
        {
            // The boundary's markers are gone (a discarded nested fallback): seeds are
            // stored, the swap is a no-op.
            if (template !== null)
            {
                template.remove();
            }
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
            if (template !== null)
            {
                template.remove();
            }
            return;
        }
        for (const gone of removable)
        {
            gone.remove();
        }
        if (template !== null)
        {
            (node.parentNode as ParentNode).insertBefore(template.content, node);
            template.remove();
        }
    };
}

/**
 * @internal The inline script installing {@link azsRuntime}, emitted once per stream before
 * the first out-of-order chunk. `nonce` feeds a CSP that disallows bare inline scripts.
 */
export function streamRuntimeScript(nonce?: string): string
{
    const attribute = nonce === undefined ? '' : ` nonce="${ nonce }"`;
    return `<script${ attribute }>(${ azsRuntime.toString() })();document.currentScript.remove()</script>`;
}
