/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Mutually exclusive branches: exactly one Match case is mounted at a time. An if/else-if
 * chain inside a reactive hole does the same job but hides the exclusivity, rebuilds on
 * every re-evaluation and gives no branch a disposal scope.
 *
 * Evaluation short-circuits at the first match, so a lower case's condition is tracked only
 * while no higher case wins.
 */

import { createBranchMount, createSelectionMemo, FailedSelection, ownBranchWork } from './branch-selection.ts';
import { renderBranchValue } from './branch-value.ts';
import { createHydrationEffect } from '../reactivity/create-effect.ts';
import type { HydrationCursor as HydrationCursorType } from '../reactivity/internal.ts';
import { createMemo, isStringMode, isHydrating, onRootDispose, untrack } from '../reactivity/index.ts';
import { serializeChild, wrapContentsAnchored, hydrationNode } from '../reactivity/internal.ts';
import { type CoTarget, type MountNode, createCoMarkers, adoptCoRange } from '../component/index.ts';
import type { Child } from './types.ts';
import { resolveReactive } from './h.ts';

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

type BranchNodes = MountNode | MountNode[];

/** Immutable information about a value Match. A reused descriptor never holds a mounted binding. */
interface ValueCase
{
    sample: () => unknown;
    children: (read: () => unknown) => BranchNodes;
}

const valueCases = new WeakMap<MatchCase['when'] | MatchCase['render'], ValueCase>();

interface CaseKey
{
    index: number;
    render: MatchCase['render'];
}

interface Winner extends CaseKey
{
    match: MatchCase;
    binding: ValueCase | undefined;
    value: unknown;
}

function sameCase(a: CaseKey, b: CaseKey): boolean
{
    return a.index === b.index && a.render === b.render;
}

function firstMatch(cases: MatchCase[]): Winner | undefined
{
    for (const [index, match] of cases.entries())
    {
        const predicate = match.when;
        const condition = valueCases.get(predicate);
        const value = condition ? condition.sample() : predicate.call(match);
        if (value)
        {
            // Only read a render method once its predicate wins. Structural cases may
            // replace or reuse either public method independently.
            const render = match.render;
            const binding = valueCases.get(render);
            return { index, match, render, binding, value: binding && binding !== condition ? binding.sample() : value };
        }
    }
    return undefined;
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
     * what `<Match when={...} let={x}>` compiles to. Once the showing closes,
     * that accessor keeps the last truthy value observed for that showing.
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
    const sample = (): W => resolveReactive(props.when) as W;
    const when = (): boolean => Boolean(sample());
    if (props.children.length === 0)
    {
        return { when, render: props.children as () => BranchNodes };
    }

    // Direct Match.render() keeps its own scoped reader. Switch supplies the winning
    // sample to the same children without constructing a second condition value.
    const render = (): BranchNodes => renderBranchValue(sample, read => props.children(read));
    const binding: ValueCase = { sample, children: read => props.children(read as () => NonNullable<W>) };
    valueCases.set(when, binding);
    valueCases.set(render, binding);
    return { when, render };
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
        const winner = untrack(() => firstMatch(cases));
        if (winner)
        {
            const content = winner.binding
                ? winner.binding.children(() => winner.value)
                : winner.render.call(winner.match);
            return wrapContentsAnchored('switch', serializeChild(content)) as unknown as MountNode;
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
            ownBranchWork(() => driveSwitch(props, cases, target, true, contentCursor));
        }) as unknown as MountNode;
    }

    // Fresh client render: NO wrapper element - comment markers bracket the matching case
    // so it is a DIRECT child of the real parent (legal inside <table>/<select>/<ul>).
    const { fragment, target } = createCoMarkers('switch');

    ownBranchWork(() => driveSwitch(props, cases, target, false));

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
    const branch = createBranchMount(target, hydrationCursor, '<Switch> content');

    let active: { key: CaseKey; remember: (value: unknown) => void } | undefined;
    const selected = createSelectionMemo(() => firstMatch(cases), branch.mounted);
    const selectionKey = createMemo(() =>
    {
        const winner = selected();
        if (active && winner && !(winner instanceof FailedSelection) && sameCase(active.key, winner))
        {
            active.remember(winner.value);
        }
        return winner && !(winner instanceof FailedSelection) ? { index: winner.index, render: winner.render } : winner;
    }, {
        equals: (a, b) => branch.mounted() && (a === b || (a !== undefined && b !== undefined
            && !(a instanceof FailedSelection) && !(b instanceof FailedSelection) && sameCase(a, b)))
    });

    createHydrationEffect(hydrateFirstRun, () => branch.mount(() =>
    {
        // The key is the only dependency of replacement. Individual bindings pull
        // the winning record directly, including inside a batch before the next swap.
        selectionKey();
        const winner = untrack(selected);
        if (winner instanceof FailedSelection)
        {
            return winner;
        }
        const factory = winner ? buildWinner(winner) : untrack(() => props.fallback);
        return factory ? adopting => untrack(() => adopting ? factory() : resolveReactive(factory)) as Child : undefined;
    }));

    function buildWinner(winner: Winner): MatchCase['render']
    {
        const { index, render, binding } = winner;
        if (!binding)
        {
            return winner.render;
        }
        const key = { index, render };
        const readWinner = (): unknown =>
        {
            const current = selected();
            return current && !(current instanceof FailedSelection) && sameCase(current, key) ? current.value : undefined;
        };
        return () => renderBranchValue(readWinner, (read, remember) =>
        {
            active = { key, remember };
            onRootDispose(() =>
            {
                if (active?.remember === remember)
                {
                    active = undefined;
                }
            });
            return binding.children(read);
        });
    }
}
