/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Conditional rendering with a disposal scope. The obvious alternative - a reactive ternary
 * inside a hole - rebuilds BOTH branches on every flip and gives neither one a scope, so
 * effects created in a branch leak across toggles. Show builds only the active branch,
 * inside its own root, and swapping disposes the outgoing subtree as a unit.
 *
 * On a swap the branch's nodes are removed one at a time rather than through innerHTML, so
 * a MutationObserver can observe each removal. Portal's automatic cleanup depends on that.
 */

import { renderBranchValue } from './branch-value.ts';
import { withHydrationRoots as withBranchRoots } from './adopt-roots.ts';
import { createHydrationEffect } from '../reactivity/create-effect.ts';
import { createSetupMemo } from '../reactivity/create-memo.ts';
import type { DisposeFn } from '../reactivity/index.ts';
import type { HydrationCursor as HydrationCursorType } from '../reactivity/internal.ts';
import { createMemo, onRootDispose, isStringMode, isHydrating, untrack } from '../reactivity/index.ts';
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
     * The accessor stays reactive while mounted. After the branch closes it returns the last
     * truthy value observed for that showing, including during cleanup. A later showing
     * receives its own accessor.
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
export function driveShow<W>(props: ShowProps<W>, target: CoTarget, hydrateFirstRun: boolean, hydrationCursor?: HydrationCursorType): void
{
    let branchDispose: DisposeFn | null = null;
    let firstRun = hydrateFirstRun;

    // Two children shapes share one prop. A THUNK `() => node` (arity 0) keeps the original contract: the
    // swap effect reads `when` directly, so the branch rebuilds on ANY tracked `when` change (the thunk has
    // no accessor, so a rebuild is how its content refreshes). A value CALLBACK `(value) => node` (arity 1)
    // opts into the narrowed-accessor model below.
    const usesValue = props.children.length >= 1;

    let buildShown: () => MountNode | MountNode[];
    let readTruthy: () => boolean;

    if (usesValue)
    {
        // Both readers must see the same condition instance, even when it constructs a component.
        const when = createSetupMemo(() => resolveReactive(props.when) as W);
        let observe: ((value: W) => void) | undefined;
        readTruthy = createMemo(() =>
        {
            const value = when();
            observe?.(value);
            return Boolean(value);
        });
        buildShown = () => renderBranchValue(when, (read, remember) =>
        {
            observe = remember;
            onRootDispose(() =>
            {
                if (observe === remember)
                {
                    observe = undefined;
                }
            });
            return props.children(read);
        });
    }
    else
    {
        const when = (): NonNullable<W> => resolveReactive(props.when) as NonNullable<W>;
        buildShown = () => props.children(when);
        readTruthy = () => Boolean(when());
    }

    const buildActive = (isTruthy: boolean): Child => untrack(() =>
        resolveReactive(isTruthy ? buildShown() : props.fallback)) as Child;

    createHydrationEffect(hydrateFirstRun, () =>
    {
        const isTruthy = readTruthy();

        const adopting = firstRun;
        firstRun = false;
        withBranchRoots(openRoot =>
        {
            if (isTruthy || props.fallback !== undefined)
            {
                openRoot(dispose =>
                {
                    branchDispose = dispose;
                    const child = buildActive(isTruthy);
                    if (adopting)
                    {
                        hydrateChild(child, hydrationCursor as HydrationCursorType);
                    }
                    else
                    {
                        appendToCo(target, materializeChild(child));
                    }
                });
            }
            if (adopting)
            {
                hydrationCursor?.assertExhausted('<Show> content');
            }
        });

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
