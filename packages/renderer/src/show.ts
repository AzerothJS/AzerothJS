/**
 * MODULE: renderer/show
 *
 * <Show> renders its children when a condition is true and an optional fallback (or
 * nothing) when false, swapping the active branch reactively. It exists because the
 * obvious alternative - an inline reactive ternary inside h() - rebuilds BOTH branches
 * on every flip and gives the inactive branch no disposal scope. Show builds only the
 * active branch, inside its own createRoot, so swapping disposes the old subtree's
 * effects/components as one unit. On swap, branch nodes are removed one at a time (not
 * via innerHTML) so a MutationObserver can observe the removal - Portal auto-cleanup
 * relies on this.
 */

import type { DisposeFn, HydrationCursor as HydrationCursorType } from '@azerothjs/reactivity';
import { createSignal, createMemo, createEffect, createRoot, isStringMode, isHydrating, untrack, serializeChild, wrapContentsAnchored, hydrationNode } from '@azerothjs/reactivity';
import { type CoTarget, createCoMarkers, appendToCo, clearCo, adoptCoRange } from '@azerothjs/component';
import { hydrateChild, materializeChild, resolveReactive } from './h.ts';
import type { Child } from './types.ts';

/**
 * Props for {@link Show}.
 *
 * @typeParam W - The type of the `when` value. Defaults to `boolean` for the plain conditional form;
 *   when `when` is a value/getter of some other type, the children callback receives an accessor to its
 *   NARROWED (non-nullish) value.
 */
export interface ShowProps<W = boolean>
{
    /**
     * Reactive condition. A value, or a getter (thunk/signal) for reactivity. The
     * compiler emits a getter-object prop (`{ get when() { return cond; } }`); a manual
     * caller may pass `() => cond` or a signal. resolveReactive unwraps it on each read.
     * The branch is shown while this is TRUTHY; a change that keeps it truthy does NOT
     * rebuild the branch (only a truthy<->falsy flip does).
     */
    when: W | (() => W);

    /**
     * Optional fallback rendered when `when` is falsy. Nothing is rendered if omitted OR if the thunk
     * returns a nullish value, so a conditionally-present fallback (`fallback={maybeNode}`) is valid.
     */
    fallback?: () => HTMLElement | null | undefined;

    /**
     * Content shown while `when` is truthy. Two forms, both built lazily (only while visible):
     *   - a plain thunk `() => node` (the common conditional case), or
     *   - a CALLBACK `(value) => node` that receives an ACCESSOR to the narrowed, non-nullish `when`
     *     value: `<Show when={user()}>{(user) => <Avatar name={user().name}/>}</Show>`. The accessor
     *     stays reactive and never yields null while the branch is mounted - no `!`, no snapshot IIFE.
     * A plain thunk simply ignores the accessor argument, so both forms share this one signature.
     */
    children: (value: () => NonNullable<W>) => HTMLElement;
}

/**
 * Show
 *
 * PURPOSE:
 * Reactively renders `children` when `when` is true, else `fallback` (or nothing),
 * swapping the active branch whenever the condition flips.
 *
 * WHY IT EXISTS:
 * A JS ternary inside a reactive hole works for trivial cases but (1) re-evaluates and
 * rebuilds BOTH arms whenever the hole re-runs, (2) gives neither arm a disposal scope,
 * so effects created in a branch leak across flips, and (3) loses DOM state (focus,
 * scroll, uncontrolled inputs) because nodes are recreated. Show builds ONLY the active
 * branch, in its own root, and swaps surgically.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, renderer; a control-flow component. `<Show>` in `.azeroth` lowers
 * to a `component` binding at a `slot` marker (its co-range); its `children`/`fallback`
 * become render-function sub-plans. At runtime it is mode-dispatched: DOM swap on the
 * client, single-branch serialization for SSR, and adoption during hydration.
 *
 * INPUT CONTRACT:
 * - props.when: boolean or getter; read reactively via resolveReactive.
 * - props.children / props.fallback: thunks returning an HTMLElement; built lazily, only
 *   while their branch is active.
 *
 * OUTPUT CONTRACT:
 * - Returns an HTMLElement-typed handle: a comment-marker co-range on the client (so
 *   Show is legal directly inside <table>/<select>/<ul>), a serialized contents-anchor in
 *   SSR, or a hydration descriptor while hydrating.
 *
 * WHY THIS DESIGN:
 * The branch runs inside createRoot so one dispose tears the whole subtree down on swap.
 * The factory is read under untrack so only `when` drives the swap effect - a signal read
 * inside the branch must not rebuild the entire branch (which would drop focus/scroll);
 * inner reactive children still track under their own effects. Comment markers (not a
 * wrapper element) keep the branch a direct child of the real parent.
 *
 * WHEN TO USE:
 * For conditionally mounting a subtree, especially one with effects, components, or DOM
 * state that must be created/destroyed as a unit on toggle.
 *
 * WHEN NOT TO USE:
 * For toggling a single attribute/class (bind that reactively instead). For choosing
 * among many cases, use {@link Switch}/{@link Match}.
 *
 * EDGE CASES:
 * - No fallback + false: renders nothing (an empty co-range).
 * - SSR evaluates `when` exactly once (no live effect) and emits only the active branch.
 * - Hydration adopts the server branch on the first effect run; later toggles use the
 *   normal DOM swap. A leftover server node in the range is a SSR/CSR mismatch and trips
 *   the hydrate fallback.
 *
 * PERFORMANCE NOTES:
 * Only the active branch is built. A flip disposes the old branch (O(subtree)) and builds
 * the new one once; a `when` change that does not flip the boolean does not rebuild.
 *
 * DEVELOPER WARNING:
 * Replacing <Show> with a raw ternary reintroduces double-build, effect leaks, and lost
 * DOM state. Keep `children`/`fallback` as thunks - calling them eagerly defeats the
 * lazy, single-branch construction.
 *
 * @param props - {@link ShowProps}: `when`, `children`, optional `fallback`.
 * @returns An HTMLElement-typed control-flow handle.
 * @see {@link Switch}
 * @see {@link For}
 * @example
 * Show({
 *   when: isLoggedIn,
 *   fallback: () => h('p', {}, 'Please log in'),
 *   children: () => h('button', { onClick: logout }, 'Logout')
 * });
 */
export function Show<W>(props: ShowProps<W>): HTMLElement
{
    // SSR: evaluate `when` ONCE (no live effect), emit the active branch inside a
    // contents anchor the client hydrator can adopt. The children callback gets a
    // constant accessor to that one evaluated value.
    if (isStringMode())
    {
        const whenValue = untrack(() => resolveReactive(props.when));
        const inner = whenValue
            ? serializeChild(props.children((): NonNullable<W> => whenValue as NonNullable<W>))
            : (props.fallback ? serializeChild(props.fallback()) : '');
        return wrapContentsAnchored('show', inner) as unknown as HTMLElement;
    }

    // Hydration: adopt the server wrapper and its current branch on the first effect run;
    // later toggles use the normal DOM swap.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            const { target, contentCursor } = adoptCoRange(cursor);
            driveShow(props, target, true, contentCursor);
        }) as unknown as HTMLElement;
    }

    // Fresh client render: NO wrapper element - comment markers bracket the active branch
    // so it is a DIRECT child of the real parent (legal inside <table>/<select>/<ul>).
    const { fragment, target } = createCoMarkers('show');

    driveShow(props, target, false);

    return fragment as unknown as HTMLElement;
}

/**
 * Wires the reactive branch effect onto `target`. Shared by the DOM path (a marker
 * range) and the hydration path (the adopted server span).
 *
 * @internal
 * @param props - The Show props.
 * @param target - Where to render branches: a marker range or the adopted server span.
 * @param hydrateFirstRun - When true, the first effect run adopts the span's existing
 *                          server children instead of appending new ones.
 * @param hydrationCursor - The cursor over the server range (hydration path only).
 */
function driveShow<W>(props: ShowProps<W>, target: CoTarget, hydrateFirstRun: boolean, hydrationCursor?: HydrationCursorType): void
{
    let branchDispose: DisposeFn | null = null;
    let firstRun = hydrateFirstRun;

    // Two children shapes share one prop. A THUNK `() => node` (arity 0) keeps the original contract: the
    // swap effect reads `when` directly, so the branch rebuilds on ANY tracked `when` change (the thunk has
    // no accessor, so a rebuild is how its content refreshes). A value CALLBACK `(value) => node` (arity 1)
    // opts into the narrowed-accessor model below.
    const usesValue = props.children.length >= 1;

    let valueAccessor: () => NonNullable<W>;
    let readTruthy: () => boolean;

    if (usesValue)
    {
        // The NARROWED value the callback reads. This signal is updated ONLY while `when` is truthy, so a
        // binding inside the branch never observes a null: when `when` goes falsy the signal keeps its last
        // truthy value and the branch is torn down (the binding never re-reads and crashes). This is what
        // lets `<Show when={x()}>{(x) => x().foo}</Show>` replace a snapshot IIFE safely.
        const [value, setValue] = createSignal<W>(untrack(() => resolveReactive(props.when)) as W);
        createEffect(() =>
        {
            const current = resolveReactive(props.when);
            if (current)
            {
                setValue(() => current as W);
            }
        });
        valueAccessor = (): NonNullable<W> => value() as NonNullable<W>;

        // The swap is driven by TRUTHINESS (a memo): a `when` change that stays truthy does not bump the
        // boolean, so the branch is NOT rebuilt - only a truthy<->falsy flip rebuilds. Value changes reach
        // the branch through `valueAccessor` instead, with no rebuild (no lost focus/scroll/DOM state).
        const truthy = createMemo(() => Boolean(resolveReactive(props.when)));
        readTruthy = truthy;
    }
    else
    {
        // Thunk form: a plain accessor (unused by the thunk) and the original "read `when` every run" swap.
        valueAccessor = (): NonNullable<W> => resolveReactive(props.when) as NonNullable<W>;
        readTruthy = (): boolean => Boolean(resolveReactive(props.when));
    }

    // Builds the active branch's content: the children (truthy) or the fallback (falsy). Children is invoked
    // WITH the narrowed accessor; a thunk ignores it. Building is untracked (it must not subscribe the swap
    // effect; inner reactive bindings track under their own effects) and resolved (a nested thunk like
    // `fallback={<Show/>}` is unwrapped to the real node).
    const buildActive = (isTruthy: boolean): Child => (isTruthy
        ? untrack(() => resolveReactive(props.children(valueAccessor)))
        : (props.fallback ? untrack(() => resolveReactive(props.fallback)) : undefined)) as Child;

    createEffect(() =>
    {
        const isTruthy = readTruthy();

        if (firstRun)
        {
            // Hydration first run: adopt existing server children rather than appending.
            firstRun = false;
            if (isTruthy || props.fallback !== undefined)
            {
                createRoot((d) =>
                {
                    branchDispose = d;
                    hydrateChild(buildActive(isTruthy), hydrationCursor as HydrationCursorType);
                });
            }

            // Every server node in the range must be claimed; a leftover means SSR/CSR
            // diverged, which hydrate() recovers from.
            hydrationCursor?.assertExhausted('<Show> content');
            return teardownBranch;
        }

        if (isTruthy || props.fallback !== undefined)
        {
            createRoot((d) =>
            {
                branchDispose = d;
                // materializeChild: the resolved value may be any child type (string, array, node) -
                // coerce it to an insertable node rather than assuming an element.
                appendToCo(target, materializeChild(buildActive(isTruthy)));
            });
        }

        // teardownBranch is the SINGLE teardown path: run before every re-render AND on
        // dispose, so no toggle leaks the rendered subtree's effects.
        return teardownBranch;
    });

    function teardownBranch(): void
    {
        if (branchDispose)
        {
            branchDispose();
            branchDispose = null;
        }

        // Remove branch nodes one-by-one (so a MutationObserver fires - Portal cleanup
        // relies on it) and run component destroy hooks; clearCo never touches the markers.
        clearCo(target);
    }
}
