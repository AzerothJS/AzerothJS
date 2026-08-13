/**
 * `<select>.value` is the one DOM property whose value is decided by the element's CHILDREN
 * (see `isChildResolvedProperty` in azerothjs/semantics). Assigning it while no matching
 * `<option>` exists is a SILENT no-op, and in a real browser assigning a value that matches
 * nothing DESELECTS EVERYTHING (value '', selectedIndex -1).
 *
 * The framework's write is therefore kept as an INTENT, and each written select carries its own
 * MutationObserver: whenever ITS child list changes - rows from `<For>`, a `<Show>` reveal, a
 * streamed chunk swap, an animation-deferred removal - that one select re-applies its intent.
 *
 * WHY AN OBSERVER AND NOT A FRAMEWORK SEAM. Two generations of seams were tried and both failed
 * measurably. Per-insertion-site calls missed `<For>` and every co-range driver. A global
 * post-render walk missed everything DEFERRED out of the flush (a transition's leave removes the
 * selected option from a transitionend handler) and cost O(tracked selects) per flush - mounting
 * N select components was quadratic, and every unrelated signal write paid a full walk. The
 * observer inverts both problems: work happens only when a written select's own subtree changes,
 * and it fires AFTER the change, so "is the intent satisfied" is read from post-change truth.
 *
 * TIMING. Observer callbacks are microtasks, which run BEFORE the browser paints - measured in
 * Chrome: wrong synchronously after an insertion, repaired by the time the next frame renders.
 * The synchronous construction path (h() building an element with its children) is still settled
 * synchronously at the end of h(), so a plain first render never even reaches the microtask.
 *
 * Two rules keep re-application from becoming its own bug:
 *  - MATCH-GATED: an intent is applied only when an option carrying it exists right now.
 *  - USER-OWNED: a pick that DIVERGES from the intent stops it being applied; only a new
 *    framework write re-arms. A pick the intent already agrees with (the bind:value write-back
 *    ran on 'input', before 'change') must NOT latch, or one ordinary click permanently
 *    disarms repair.
 */

import { DEV } from '../reactivity/dev.ts';

/** What the framework last asked a select to select, and whether the user has since taken over. */
interface Intent
{
    /** A single value, or the set of values for a `multiple` select. */
    desired: string | readonly string[];

    /** True once the user changed the selection; cleared by the next framework write. */
    overridden: boolean;

    /** Watches THIS select's subtree; disconnected when the intent is dropped. */
    observer: MutationObserver | null;
}

/**
 * The intent per written select. A plain WeakMap and nothing else: each select observes itself,
 * so no code ever needs to ENUMERATE the written selects - which is what previously forced a
 * WeakRef registry, a live counter, and a walk that grew with the page.
 */
const intents = new WeakMap<HTMLSelectElement, Intent>();

/** Whether the one document-level listener for form resets is installed. */
let resetWatched = false;

/**
 * form.reset() restores each option's defaultSelected - the parsed `selected` ATTRIBUTE - with
 * NO childList mutation, so the observer never fires. A client-rendered select has no such
 * attribute at all, so reset landed on option 0 and stayed there; a hydrated one snapped to the
 * SSR-era value. Re-applying the intent one microtask after the reset's default action makes a
 * framework-driven select deterministic across both: the framework's value wins, exactly as it
 * does on any other external change, while an overridden (user-owned) select keeps the reset.
 */
function watchFormResets(): void
{
    if (resetWatched || typeof document === 'undefined')
    {
        return;
    }
    resetWatched = true;
    document.addEventListener('reset', (event) =>
    {
        const form = event.target as HTMLFormElement | null;
        if (form === null || typeof form.elements === 'undefined')
        {
            return;
        }
        // The reset's default action runs after dispatch; settle after it has applied.
        queueMicrotask(() =>
        {
            for (let i = 0; i < form.elements.length; i += 1)
            {
                const element = form.elements[i];
                if ((element as { nodeName?: string } | null)?.nodeName === 'SELECT')
                {
                    settleSelect(element as HTMLSelectElement);
                }
            }
        });
    });
}

/** Selects already carrying the change listener, so re-registering cannot stack another. */
const watched = new WeakSet<HTMLSelectElement>();

/** Applies `desired` if the options to satisfy it exist now; a no-op when they do not. */
function applyIntent(select: HTMLSelectElement, desired: string | readonly string[]): void
{
    const options = select.options;

    // An array only means anything to a `multiple` select. On a single select the DOM coerces it
    // to a comma-joined string; selecting the LAST entry instead - what a per-option loop leaves
    // behind - would be a silent divergence no reading of the HTML supports.
    if (Array.isArray(desired) && select.multiple)
    {
        const wanted = new Set(desired as readonly string[]);
        let present = false;
        for (let i = 0; i < options.length; i += 1)
        {
            const value = options[i]?.value;
            if (value !== undefined && wanted.has(value))
            {
                present = true;
                break;
            }
        }
        // An EMPTY array is an explicit "select nothing", and nothing-selected is always
        // achievable - treating it as unsatisfiable left DOM and state permanently divergent
        // with no API able to clear a multiple select at all.
        if (wanted.size === 0)
        {
            for (let i = 0; i < options.length; i += 1)
            {
                const option = options[i];
                if (option !== undefined)
                {
                    option.selected = false;
                }
            }
            return;
        }
        // MATCH GATE, the same rule the scalar branch obeys: with nothing to select, touching
        // the options would only deselect whatever is selected now.
        if (!present)
        {
            return;
        }
        // FIRST occurrence per value, matching what `select.value = x` does on the scalar path.
        // `selected = wanted.has(value)` selected EVERY option carrying a wanted value, so with
        // duplicate values - legal HTML, and ordinary in <For>-rendered rows - one click selected
        // rows the user never touched and a later click could not deselect them, because
        // matchesIntent agreed with the fanned-out state and never repaired it.
        const taken = new Set<string>();
        for (let i = 0; i < options.length; i += 1)
        {
            const option = options[i];
            if (option === undefined)
            {
                continue;
            }
            const take = wanted.has(option.value) && !taken.has(option.value);
            option.selected = take;
            if (take)
            {
                taken.add(option.value);
            }
        }
        return;
    }

    const scalar = Array.isArray(desired) ? (desired as readonly string[]).join(',') : desired;
    for (let i = 0; i < options.length; i += 1)
    {
        if (options[i]?.value === scalar)
        {
            // MATCH GATE: assigning a value no option carries clears the selection.
            select.value = scalar;
            return;
        }
    }
}

/** Whether the current selection already IS the intent, read fresh from the DOM. */
function matchesIntent(select: HTMLSelectElement, desired: string | readonly string[]): boolean
{
    if (Array.isArray(desired) && select.multiple)
    {
        const wanted = new Set(desired as readonly string[]);
        const options = select.options;
        // Mirrors applyIntent's first-occurrence rule, or a duplicate value would read as a
        // permanent mismatch and re-apply on every settle.
        const taken = new Set<string>();
        for (let i = 0; i < options.length; i += 1)
        {
            const option = options[i];
            if (option === undefined)
            {
                continue;
            }
            const take = wanted.has(option.value) && !taken.has(option.value);
            if (option.selected !== take)
            {
                return false;
            }
            if (take)
            {
                taken.add(option.value);
            }
        }
        return true;
    }
    const scalar = Array.isArray(desired) ? (desired as readonly string[]).join(',') : desired;
    if (select.multiple)
    {
        // select.value reports only the FIRST selected option, so equality alone would declare a
        // scalar intent satisfied while extra options are also selected - and never repair them.
        const options = select.options;
        let count = 0;
        for (let i = 0; i < options.length; i += 1)
        {
            if (options[i]?.selected === true)
            {
                count += 1;
            }
        }
        return count === 1 && select.value === scalar;
    }
    return select.value === scalar;
}

/** Re-applies one select's intent unless the person owns the control or the DOM already agrees. */
function settleSelect(select: HTMLSelectElement): void
{
    const intent = intents.get(select);
    if (intent === undefined || intent.overridden || matchesIntent(select, intent.desired))
    {
        return;
    }
    applyIntent(select, intent.desired);
}

/** Marks the intent user-owned when the person picks something the framework does not want. */
function watchUserInput(select: HTMLSelectElement): void
{
    if (watched.has(select))
    {
        return;
    }
    watched.add(select);
    select.addEventListener('change', () =>
    {
        const intent = intents.get(select);
        if (intent === undefined)
        {
            return;
        }
        // Latch ONLY when the pick DIVERGES from the intent. A real gesture fires 'input' before
        // 'change', and a `bind:value` write-back runs on 'input' - so by the time this listener
        // runs, the intent already IS the user's pick, and latching would permanently disarm
        // repair: nothing could ever clear it, because clearing takes a new framework write and
        // the bound signal already equals the pick. One ordinary click then left the select
        // painted empty (or on the wrong row) after any later row churn, while the signal held
        // the right value. When the DOM matches the intent, repairing IS the user's choice, so
        // there is nothing to protect; when it diverges (a one-way `value=` with no write-back),
        // the latch is doing its real job and stays.
        if (!matchesIntent(select, intent.desired))
        {
            intent.overridden = true;
        }
    });
}

/**
 * Records the framework's desired value for a select, applies it if it can be applied now, and
 * arms the observer that re-applies it whenever this select's own subtree changes.
 *
 * A new write always re-arms the intent: the application asking for a value is a later
 * instruction than whatever the user picked before it. A nullish value means "no framework
 * opinion" - it stops driving the control without clearing it, because the server deliberately
 * leaves an authored `<option selected>` standing for a nullish value and the two modes must
 * agree.
 *
 * @internal
 * @param select - The select element.
 * @param value - The value (or, for a `multiple` select, the array of values); nullish releases.
 */
export function writeSelectValue(select: HTMLSelectElement, value: unknown): void
{
    if (value === null || value === undefined)
    {
        const dropped = intents.get(select);
        if (dropped !== undefined)
        {
            dropped.observer?.disconnect();
            intents.delete(select);
        }
        return;
    }

    const desired: string | readonly string[] = Array.isArray(value)
        ? (value as unknown[]).map((entry) => String(entry))
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- mirrors el.value = v, which coerces whatever it is given
        : String(value);

    const existing = intents.get(select);
    if (existing !== undefined)
    {
        existing.desired = desired;
        existing.overridden = false;
        applyIntent(select, desired);
        return;
    }

    watchFormResets();
    const intent: Intent = { desired, overridden: false, observer: null };
    intents.set(select, intent);
    watchUserInput(select);

    // Observing does not root the select: the observer lives in the intent, the intent is keyed
    // weakly by the select, and the callback's closure over the select is the ephemeron case GC
    // handles. When the select is dropped, everything here goes with it - no registry to prune.
    if (typeof MutationObserver === 'function')
    {
        intent.observer = new MutationObserver(() =>
        {
            try
            {
                settleSelect(select);
            }
            catch (error)
            {
                // Isolated per select by construction, but a throw here would surface as an
                // unhandled microtask error. A wrong selection is not worth a crashed page.
                if (DEV)
                {
                    console.error('azeroth: applying a <select> value failed; its selection may be stale.', error);
                }
            }
        });
        // childList covers rows arriving and leaving. The other two cover an option changing in
        // PLACE, which resolves the select just as much: `characterData` for a value-less option
        // whose TEXT is its value (the form SSR's option-text matching relies on), and a filtered
        // `value` attribute for writes from outside the framework. The filter is what keeps this
        // cheap - unrelated attribute churn under the select produces no callback at all. The
        // framework's own reactive `value` writes are DOM property assignments that emit no
        // mutation record, and are settled at their write site in h.ts instead.
        intent.observer.observe(select, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['value']
        });
    }

    applyIntent(select, desired);
}

/**
 * Synchronously settles ONE element if it is a written select.
 *
 * h() calls this after appending an element's own children, so the plain construction path -
 * value written in props, options appended right after - is correct without waiting for the
 * observer's microtask. O(1) when the element is not a select.
 *
 * @internal
 * @param node - The element that just gained children.
 */
export function settleSelectValue(node: unknown): void
{
    if ((node as { nodeName?: string } | null)?.nodeName !== 'SELECT')
    {
        return;
    }
    settleSelect(node as HTMLSelectElement);
}
