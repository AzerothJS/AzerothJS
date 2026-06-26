/**
 * MODULE: renderer/switch
 *
 * <Switch> renders the first matching <Match> case - a switch/case for reactive UI where
 * exactly one branch is mounted at a time. The hand-rolled alternative, an if/else-if
 * chain inside a reactive hole, works but hides that the branches are mutually exclusive,
 * rebuilds on every re-evaluation, and gives no branch a disposal scope. Switch makes
 * exclusivity explicit, mounts only the winning case in its own root, and short-circuits
 * at the first match so a lower case's condition is only tracked while no higher case wins.
 */

import type { DisposeFn, HydrationCursor as HydrationCursorType } from '@azerothjs/reactivity';
import { createEffect, createRoot, isStringMode, isHydrating, untrack, serializeChild, wrapContentsAnchored, hydrationNode } from '@azerothjs/reactivity';
import { type CoTarget, createCoMarkers, appendToCo, clearCo, adoptCoRange } from '@azerothjs/component';
import { hydrateChild, materializeChild, resolveReactive } from './h.ts';

/**
 * A single normalized case inside a {@link Switch}, produced by {@link Match}: a reactive
 * `when` predicate plus a `render` thunk.
 */
export interface MatchCase
{
    /** Reactive condition - true when this case should render. */
    when: () => boolean;

    /** Render function building this case's element. */
    render: () => HTMLElement;
}

/**
 * Props for {@link Match}.
 */
export interface MatchProps
{
    /** Condition: a value or a getter (thunk/signal). The compiler emits a getter-object prop; Match re-wraps it via resolveReactive into the case thunk Switch calls. */
    when: boolean | (() => boolean);

    /** Thunk building this case's content (a prop, matching the compiled `<Match when={...}>...</Match>` form). */
    children: () => HTMLElement;
}

/**
 * Match
 *
 * PURPOSE:
 * Wraps a `{ when, children }` pair into a normalized {@link MatchCase} for use inside
 * {@link Switch}.
 *
 * WHY IT EXISTS:
 * Switch needs each case as a uniform `{ when: () => boolean, render }` it can evaluate in
 * priority order. Match normalizes the authoring shape (where `when` may be a value,
 * thunk, or signal, and content is a prop) into that internal form, keeping `when` lazy so
 * it stays reactive.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, renderer. `<Match>` inside `<Switch>` lowers to entries the Switch consumes;
 * Match itself just builds the case descriptor (it does not render).
 *
 * INPUT CONTRACT:
 * - props.when: value or getter; re-read lazily through resolveReactive so it tracks.
 * - props.children: thunk building the case element.
 *
 * OUTPUT CONTRACT:
 * - Returns a {@link MatchCase}. It does NOT render on its own; only Switch mounts it.
 *
 * EDGE CASES:
 * - Using Match outside a Switch has no effect (nothing consumes the returned case).
 *
 * @param props - {@link MatchProps}: `when`, `children`.
 * @returns A {@link MatchCase} for {@link Switch}.
 * @see {@link Switch}
 * @example
 * Match({ when: () => status() === 'loading', children: () => h('div', {}, 'Loading...') });
 */
export function Match(props: MatchProps): MatchCase
{
    return {
        // props.when may be a value (getter-object prop) or a function; resolveReactive
        // unwraps it. Re-read lazily so the case stays reactive when Switch calls it.
        when: () => resolveReactive(props.when) as boolean,
        render: props.children
    };
}

/**
 * Props for {@link Switch}.
 */
export interface SwitchProps
{
    /** Cases in priority order (first match wins). An array (manual API) or a thunk returning one/many - the latter is what compiled `<Switch><Match/>...</Switch>` produces. */
    children: MatchCase[] | (() => MatchCase[] | MatchCase);

    /** Optional content when no case matches; nothing renders if omitted or the thunk returns nullish. */
    fallback?: () => HTMLElement | null | undefined;
}

/**
 * Switch
 *
 * PURPOSE:
 * Renders the first {@link MatchCase} whose `when` is true (else the optional fallback),
 * swapping reactively when conditions change. Only one case is mounted at a time.
 *
 * WHY IT EXISTS:
 * An if/else-if chain in a reactive hole rebuilds all branches on re-run, makes
 * exclusivity implicit in statement order, and leaks branch effects. Switch evaluates
 * cases in order, mounts only the winner in its own root, and ties each case's reactivity
 * to whether a higher-priority case already won.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, renderer; a control-flow component. `<Switch>` lowers to a
 * `component` binding at a `slot` co-range; nested `<Match>` become its cases.
 * Mode-dispatched: DOM swap on the client, single-case serialization for SSR, adoption on
 * hydration.
 *
 * INPUT CONTRACT:
 * - props.children: a MatchCase[] or a thunk returning one/many cases. Cases are
 *   normalized once at construction (building cases reads no signals; only their `when`
 *   getters do, inside the effect).
 * - props.fallback: optional thunk rendered when no case matches.
 *
 * OUTPUT CONTRACT:
 * - Returns an HTMLElement-typed handle: a comment-marker co-range on the client, a
 *   serialized contents-anchor in SSR, or a hydration descriptor while hydrating.
 *
 * WHY THIS DESIGN:
 * The selection loop stops at the first match, so a lower case's `when` is read (and thus
 * subscribed) only when no higher case wins - changes to it cannot trigger a pointless
 * re-render while a higher case is active. The winning case mounts in createRoot (disposed
 * as a unit on swap), and the factory is read under untrack so a signal inside a case's
 * render does not rebuild the branch.
 *
 * WHEN TO USE:
 * For more than two mutually exclusive branches keyed off conditions (status machines,
 * route-like dispatch).
 *
 * WHEN NOT TO USE:
 * For a single two-way condition (use {@link Show}); for a runtime-selected component
 * (use {@link Dynamic}).
 *
 * EDGE CASES:
 * - No case matches and no fallback: renders nothing.
 * - SSR emits the first true case (or fallback) once; hydration adopts on the first effect run.
 *
 * PERFORMANCE NOTES:
 * Only the winning case is built; a condition change rebuilds only when it changes which
 * case wins. First-match short-circuit limits how many `when` getters are tracked.
 *
 * DEVELOPER WARNING:
 * Cases are normalized once - returning a DIFFERENT set of cases from a `children` thunk
 * on later runs is not observed (the case list is fixed at construction). Keep render
 * thunks lazy.
 *
 * @param props - {@link SwitchProps}: `children` (cases), optional `fallback`.
 * @returns An HTMLElement-typed control-flow handle.
 * @see {@link Match}
 * @see {@link Show}
 * @example
 * Switch({
 *   fallback: () => h('div', {}, 'Idle'),
 *   children: [
 *     Match({ when: () => status() === 'loading', children: () => h('div', {}, 'Loading...') }),
 *     Match({ when: () => status() === 'error',   children: () => h('div', {}, 'Error!') })
 *   ]
 * });
 */
export function Switch(props: SwitchProps): HTMLElement
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
                return wrapContentsAnchored('switch', serializeChild(matchCase.render())) as unknown as HTMLElement;
            }
        }

        const fallbackInner = props.fallback ? serializeChild(props.fallback()) : '';
        return wrapContentsAnchored('switch', fallbackInner) as unknown as HTMLElement;
    }

    // Hydration: adopt the wrapper + current matching case on the first effect run; later
    // condition changes use the normal DOM swap.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            const { target, contentCursor } = adoptCoRange(cursor);
            driveSwitch(props, cases, target, true, contentCursor);
        }) as unknown as HTMLElement;
    }

    // Fresh client render: NO wrapper element - comment markers bracket the matching case
    // so it is a DIRECT child of the real parent (legal inside <table>/<select>/<ul>).
    const { fragment, target } = createCoMarkers('switch');

    driveSwitch(props, cases, target, false);

    return fragment as unknown as HTMLElement;
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
        let factory: (() => HTMLElement | null | undefined) | null = null;
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
