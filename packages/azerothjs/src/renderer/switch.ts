/**
 * Mutually exclusive branches: exactly one Match case is mounted at a time. An if/else-if
 * chain inside a reactive hole does the same job but hides the exclusivity, rebuilds on
 * every re-evaluation and gives no branch a disposal scope.
 *
 * Evaluation short-circuits at the first match, so a lower case's condition is tracked only
 * while no higher case wins.
 */

import type { DisposeFn } from '../reactivity/index.ts';
import type { HydrationCursor as HydrationCursorType } from '../reactivity/internal.ts';
import { createEffect, createMemo, createRoot, isStringMode, isHydrating, untrack } from '../reactivity/index.ts';
import { serializeChild, wrapContentsAnchored, hydrationNode } from '../reactivity/internal.ts';
import { type CoTarget, type MountNode, createCoMarkers, appendToCo, clearCo, adoptCoRange } from '../component/index.ts';
import { hydrateChild, materializeChild, resolveReactive } from './h.ts';

/**
 * A single normalized case inside a {@link Switch}, produced by {@link Match}: a reactive
 * `when` predicate plus a `render` thunk.
 */
export interface MatchCase
{
    /** Reactive condition - true when this case should render. */
    when: () => boolean;

    /** Render function building this case's element (or several - siblings render in order). */
    render: () => MountNode | MountNode[];
}

/** Props for {@link Match}. */
export interface MatchProps<W = boolean>
{
    /**
     * The condition: a value or a getter. Any type is accepted and the case matches while
     * the value is TRUTHY, so `phase() === 'connected' && activeConfig()` works without an
     * explicit boolean coercion.
     */
    when: W | (() => W);

    /**
     * Content builder, in the same two forms as {@link ShowProps.children}: a plain thunk,
     * or a callback receiving an accessor to the narrowed non-nullish `when` value, which is
     * what `<Match when={...} let={x}>` compiles to.
     */
    children: (value: () => NonNullable<W>) => MountNode | MountNode[];
}

/**
 * Normalizes a `{ when, children }` pair into the uniform case shape {@link Switch}
 * evaluates in priority order. `when` stays lazy, so the case remains reactive.
 *
 * Match renders nothing itself. Used outside a Switch it has no effect at all, because
 * nothing consumes the case it returns.
 *
 * @param props - See {@link MatchProps}.
 * @returns A case for {@link Switch} to evaluate.
 * @example
 * Match({ when: () => status() === 'loading', children: () => h('div', {}, 'Loading...') });
 */
export function Match<W = boolean>(props: MatchProps<W>): MatchCase
{
    // A value callback - arity >= 1, the compiled `let=` form - receives an accessor to the
    // narrowed `when` value under the same contract as Show's: PULL-derived, so a read
    // recomputes from the same `when` state the match decision observed rather than through a
    // racing side channel (driveShow explains why a pushing effect cannot provide this). The
    // memo is built inside the case, which Switch runs inside the branch's root, so it is
    // disposed with the branch on every swap.
    const render = props.children.length >= 1
        ? (): MountNode | MountNode[] =>
        {
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

            return props.children(narrowed as () => NonNullable<W>);
        }
        // A zero-arity children never reads an accessor, so none is manufactured for it.
        : (props.children as unknown as () => MountNode | MountNode[]);

    return {
        // Re-read lazily, so the case stays reactive when Switch calls it.
        when: () => Boolean(resolveReactive(props.when)),
        render
    };
}

/**
 * Props for {@link Switch}.
 */
export interface SwitchProps
{
    /**
     * Cases in priority order, first match winning. An array for the manual API, or a thunk
     * returning one or many, which is what compiled markup produces.
     */
    children: MatchCase | MatchCase[] | (() => MatchCase[] | MatchCase);

    /** Rendered when no case matches. Nothing renders if omitted or if the thunk returns nullish. */
    fallback?: () => MountNode | null | undefined;
}

/**
 * Renders the first case whose `when` is truthy, otherwise the fallback, swapping as
 * conditions change. Exactly one case is mounted at a time.
 *
 * The selection loop stops at the first match, so a lower case's `when` is only read - and
 * therefore only subscribed - while no higher case wins. A change to it cannot trigger a
 * pointless re-render behind an active higher case.
 *
 * The winning case mounts in its own root and is disposed as a unit on swap, and the case's
 * render is read under untrack, so a signal read inside it does not rebuild the branch.
 *
 * The case LIST is fixed at construction. Returning a different set of cases from a
 * `children` thunk on a later run is not observed.
 *
 * @param props - See {@link SwitchProps}.
 * @returns A control-flow handle, typed as a node.
 * @see {@link Match} to build a case.
 * @see {@link Show} for a single two-way condition, and {@link Dynamic} for a
 *      runtime-selected component.
 * @example
 * Switch({
 *   fallback: () => h('div', {}, 'Idle'),
 *   children: [
 *     Match({ when: () => status() === 'loading', children: () => h('div', {}, 'Loading...') }),
 *     Match({ when: () => status() === 'error',   children: () => h('div', {}, 'Error!') })
 *   ]
 * });
 */
export function Switch(props: SwitchProps): MountNode
{
    // Normalize once: evaluate a thunk to its cases and wrap a lone case into an array.
    // Building cases reads no signals (only their `when` getters do, in the effect), so
    // this is safe outside the reactive scope.
    const raw = typeof props.children === 'function' ? props.children() : props.children;
    const cases: MatchCase[] = Array.isArray(raw) ? raw : [raw];

    // SSR: emit the first case whose `when` is true (read once), else the fallback.
    if (isStringMode())
    {
        for (const matchCase of cases)
        {
            if (untrack(() => matchCase.when()))
            {
                return wrapContentsAnchored('switch', serializeChild(matchCase.render())) as unknown as MountNode;
            }
        }

        const fallbackInner = props.fallback ? serializeChild(props.fallback()) : '';
        return wrapContentsAnchored('switch', fallbackInner) as unknown as MountNode;
    }

    // Hydration: adopt the wrapper + current matching case on the first effect run; later
    // condition changes use the normal DOM swap.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            const { target, contentCursor } = adoptCoRange(cursor);
            driveSwitch(props, cases, target, true, contentCursor);
        }) as unknown as MountNode;
    }

    // Fresh client render: NO wrapper element - comment markers bracket the matching case
    // so it is a DIRECT child of the real parent (legal inside <table>/<select>/<ul>).
    const { fragment, target } = createCoMarkers('switch');

    driveSwitch(props, cases, target, false);

    return fragment;
}

/**
 * Wires the case-selection effect onto `target`. Shared by the DOM path (a marker range)
 * and hydration (the adopted server span).
 *
 * @internal
 * @param props - The Switch props.
 * @param cases - The normalized Match cases.
 * @param target - Where to render the case: a marker range or the server span.
 * @param hydrateFirstRun - When true, the first run adopts existing server children.
 * @param hydrationCursor - The cursor over the server range (hydration path only).
 */
function driveSwitch(props: SwitchProps, cases: MatchCase[], target: CoTarget, hydrateFirstRun: boolean, hydrationCursor?: HydrationCursorType): void
{
    let branchDispose: DisposeFn | null = null;
    let firstRun = hydrateFirstRun;

    createEffect(() =>
    {
        // First matching case wins; stopping at the first match means a lower case's
        // condition is tracked (and can trigger a re-render) only when no higher case wins.
        let factory: (() => MountNode | MountNode[] | null | undefined) | null = null;
        for (const matchCase of cases)
        {
            if (matchCase.when())
            {
                factory = matchCase.render;
                break;
            }
        }

        if (!factory && props.fallback)
        {
            factory = props.fallback;
        }

        if (firstRun)
        {
            firstRun = false;
            if (factory)
            {
                const build = factory;
                createRoot((d) =>
                {
                    branchDispose = d;
                    hydrateChild(untrack(build), hydrationCursor as HydrationCursorType);
                });
            }

            // Every server node in the range must be claimed; a leftover means SSR/CSR
            // diverged, which hydrate() recovers from.
            hydrationCursor?.assertExhausted('<Switch> content');
            return teardownBranch;
        }

        if (factory)
        {
            const build = factory;
            createRoot((d) =>
            {
                branchDispose = d;
                // untrack: only the `when` conditions drive this effect; a signal read in a
                // case's render must not subscribe the selection effect (it would rebuild
                // the branch on every change of that signal). resolveReactive unwraps a nested
                // thunk (a markup value used as a case compiles to `() => (() => ...)`);
                // materializeChild coerces the resolved value (string/array/node) to a node.
                appendToCo(target, materializeChild(untrack(() => resolveReactive(build))));
            });
        }

        // Single teardown path - runs before every re-render AND on dispose, disposing the
        // losing branch's effects before its DOM is discarded.
        return teardownBranch;
    });

    function teardownBranch(): void
    {
        if (branchDispose)
        {
            branchDispose();
            branchDispose = null;
        }

        clearCo(target);
    }
}
