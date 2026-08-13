/**
 * Conditional rendering with a disposal scope. The obvious alternative - a reactive ternary
 * inside a hole - rebuilds BOTH branches on every flip and gives neither one a scope, so
 * effects created in a branch leak across toggles. Show builds only the active branch,
 * inside its own root, and swapping disposes the outgoing subtree as a unit.
 *
 * On a swap the branch's nodes are removed one at a time rather than through innerHTML, so
 * a MutationObserver can observe each removal. Portal's automatic cleanup depends on that.
 */

import type { DisposeFn } from '../reactivity/index.ts';
import type { HydrationCursor as HydrationCursorType } from '../reactivity/internal.ts';
import { createMemo, createEffect, createRoot, isStringMode, isHydrating, untrack } from '../reactivity/index.ts';
import { serializeChild, wrapContentsAnchored, hydrationNode } from '../reactivity/internal.ts';
import { type CoTarget, type MountNode, createCoMarkers, appendToCo, clearCo, adoptCoRange } from '../component/index.ts';
import { hydrateChild, materializeChild, resolveReactive } from './h.ts';
import type { Child } from './types.ts';

/**
 * Props for {@link Show}.
 *
 * @typeParam W - The `when` value's type. Defaults to `boolean` for the plain conditional
 *                form; for any other type the children callback receives an accessor to the
 *                NARROWED, non-nullish value.
 */
export interface ShowProps<W = boolean>
{
    /**
     * The condition: a value, or a getter for reactivity. The branch is shown while this is
     * TRUTHY, and only a truthy-to-falsy flip rebuilds - a change that stays truthy leaves the
     * mounted branch alone, preserving its focus, scroll and uncontrolled input state.
     */
    when: W | (() => W);

    /**
     * Rendered while `when` is falsy. Nothing renders if it is omitted or if the thunk returns
     * a nullish value, so a conditionally-present fallback is valid.
     */
    fallback?: () => MountNode | null | undefined;

    /**
     * Content shown while `when` is truthy, built lazily and only while visible. Either a
     * plain thunk, or a callback receiving an ACCESSOR to the narrowed non-nullish `when`
     * value:
     *
     * ```
     * <Show when={user()}>{(user) => <Avatar name={user().name}/>}</Show>
     * ```
     *
     * The accessor stays reactive and does not yield null while the branch is mounted, so
     * neither a `!` nor a snapshot IIFE is needed. A plain thunk ignores the argument, which
     * is why both forms share one signature.
     */
    children: (value: () => NonNullable<W>) => MountNode | MountNode[];
}

/**
 * Renders `children` while `when` is truthy and `fallback` otherwise, swapping branches as
 * the condition flips.
 *
 * Only the active branch is ever built, and it runs inside its own root, so one dispose
 * tears the whole outgoing subtree down. The branch factory is read under untrack, so a
 * signal read INSIDE the branch does not rebuild it - which is what preserves focus, scroll
 * position and uncontrolled input state across unrelated updates. Reactive children within
 * the branch still track under their own effects.
 *
 * The returned handle is a pair of comment markers rather than a wrapper element, so a Show
 * is legal directly inside `<table>`, `<select>` and `<ul>`, where the parser would hoist a
 * stray element out.
 *
 * Under SSR `when` is evaluated exactly once and only the active branch is emitted. While
 * hydrating, the server's branch is adopted on the first effect run and later toggles are
 * ordinary DOM swaps; a leftover server node in the range is a mismatch and trips the
 * hydration fallback.
 *
 * @param props - See {@link ShowProps}.
 * @returns A control-flow handle, typed as a node so it composes like one.
 * @example
 * Show({
 *     when: isLoggedIn,
 *     fallback: () => h('p', {}, 'Please log in'),
 *     children: () => h('button', { onClick: logout }, 'Logout')
 * });
 *
 * @see {@link Switch} to choose among several cases.
 */
export function Show<W>(props: ShowProps<W>): MountNode
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
        return wrapContentsAnchored('show', inner) as unknown as MountNode;
    }

    // Hydration: adopt the server wrapper and its current branch on the first effect run;
    // later toggles use the normal DOM swap.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            const { target, contentCursor } = adoptCoRange(cursor);
            driveShow(props, target, true, contentCursor);
        }) as unknown as MountNode;
    }

    // Fresh client render: NO wrapper element - comment markers bracket the active branch
    // so it is a DIRECT child of the real parent (legal inside <table>/<select>/<ul>).
    const { fragment, target } = createCoMarkers('show');

    driveShow(props, target, false);

    return fragment;
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
        // The NARROWED value the callback reads: the current truthy `when`, or the last truthy value once
        // `when` goes falsy (the branch is torn down on that flip; a binding validating during the teardown
        // window must still see a real value). This is what lets `<Show when={x()}>{(x) => x().foo}</Show>`
        // replace a snapshot IIFE safely.
        //
        // It must be PULL-derived, never pushed by a separate effect: subscribers of a producer have no
        // ordering guarantee, and an effect created during a write wave defers its first run - so a pushing
        // effect can lose the race against the truthy memo below and hand the branch a stale seed. A memo
        // recomputes AT THE READ, from the same `when` state the truthiness decision observed, so a mounted
        // branch cannot observe the seed no matter where or when this Show was constructed.
        let lastTruthy = untrack(() => resolveReactive(props.when)) as W;

        const narrowed = createMemo<W>(() =>
        {
            const current = resolveReactive(props.when);

            if (current)
            {
                lastTruthy = current as W;
            }

            return current ? current as W : lastTruthy;
        });

        valueAccessor = narrowed as () => NonNullable<W>;

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
