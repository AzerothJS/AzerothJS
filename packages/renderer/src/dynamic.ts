/**
 * MODULE: renderer/dynamic
 *
 * <Dynamic> renders a component chosen by a reactive getter; the component itself can
 * change at runtime (tab panels, role-based views, plugin slots, wizard steps, nullable
 * modals). The hand-rolled alternative - a reactive child that re-selects and re-invokes
 * the component - rebuilds the whole subtree (losing its state) whenever ANY signal it
 * reads changes, because the selection and the props share one tracking scope. Dynamic
 * tracks only the `component` getter and reads `props` untracked, so a prop change does
 * not tear down and rebuild the component tree (components subscribe to their own props
 * for fine-grained updates).
 */

import type { DisposeFn, HydrationCursor as HydrationCursorType } from '@azerothjs/reactivity';
import { createEffect, createRoot, untrack, isStringMode, isHydrating, serializeChild, wrapContentsAnchored, hydrationNode } from '@azerothjs/reactivity';
import { type CoTarget, createCoMarkers, appendToCo, clearCo, adoptCoRange } from '@azerothjs/component';
import { hydrateChild, materializeChild } from './h.ts';

/**
 * Props for {@link Dynamic}.
 */
export interface DynamicProps
{
    /**
     * Reactive getter returning the component to render. When it changes, the old
     * component is removed and the new one rendered in its place. Return null to render
     * nothing.
     */
    component: () => ((props: Record<string, unknown>) => HTMLElement) | null;

    /** Optional getter returning props for the component; read (untracked) when the component changes. */
    props?: () => Record<string, unknown>;
}

/**
 * Dynamic
 *
 * PURPOSE:
 * Renders the component returned by `component()`, swapping it whenever that getter
 * returns a different component (or null to render nothing). Props from `props()` are
 * passed through.
 *
 * WHY IT EXISTS:
 * Choosing a component by hand inside a reactive hole (`() => view()(props())`) couples
 * the selection and the props into one tracking scope: any prop change rebuilds the whole
 * subtree, discarding its state. Dynamic isolates the swap to the `component` signal and
 * leaves prop reactivity to the component, so only an actual component change rebuilds.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, renderer; a control-flow component. `<Dynamic>` lowers to a
 * `component` binding at a `slot` co-range; the chosen component is resolved at runtime.
 * Mode-dispatched: DOM swap on the client, single-resolution serialization for SSR,
 * adoption during hydration.
 *
 * INPUT CONTRACT:
 * - props.component: getter returning a component function or null; read reactively (the
 *   sole swap trigger).
 * - props.props: optional getter for the component's props; read untracked.
 *
 * OUTPUT CONTRACT:
 * - Returns an HTMLElement-typed handle: a comment-marker co-range on the client, a
 *   serialized contents-anchor in SSR, or a hydration descriptor while hydrating.
 *
 * WHY THIS DESIGN:
 * Tracking only `component()` (props read under untrack) is what prevents prop churn from
 * rebuilding the tree. Each component renders in its own createRoot so a swap disposes the
 * previous one as a unit. Comment markers keep the component a direct child of the parent.
 *
 * WHEN TO USE:
 * When the component to render is data-driven and changes at runtime: tabs, role/plugin
 * dispatch, steppers, nullable modals.
 *
 * WHEN NOT TO USE:
 * For a fixed two-way condition (use {@link Show}) or a fixed set of cases
 * ({@link Switch}). For passing props that should update in place, let the component read
 * them reactively rather than forcing a swap.
 *
 * EDGE CASES:
 * - component() returning null renders nothing (empty co-range).
 * - Storing a component IN a signal needs the wrap-in-arrow idiom (setView(() => Cmp)),
 *   since a setter treats a bare function argument as an updater.
 * - SSR resolves the component + props once; hydration adopts on the first effect run.
 *
 * PERFORMANCE NOTES:
 * A prop change does NOT rebuild (untracked); only a component change disposes the old
 * tree and builds the new one once.
 *
 * DEVELOPER WARNING:
 * Reading a signal inside the component's synchronous setup does not re-subscribe Dynamic
 * (props are untracked) - so do not rely on Dynamic to re-run the component on prop
 * changes; the component must track its own props. Remember the wrap-in-arrow rule when
 * putting a component in a signal.
 *
 * @param dynamicProps - {@link DynamicProps}: `component`, optional `props`.
 * @returns An HTMLElement-typed control-flow handle.
 * @see {@link Show}
 * @see {@link Switch}
 * @example
 * const [view, setView] = createSignal(Home);
 * Dynamic({ component: view, props: () => ({ title: 'Tab' }) });
 * setView(() => About); // wrap in arrow: a setter treats a bare function as an updater
 */
export function Dynamic(dynamicProps: DynamicProps): HTMLElement
{
    // SSR: resolve component + props ONCE and emit its output in a contents anchor.
    if (isStringMode())
    {
        const Component = untrack(() => dynamicProps.component());
        if (!Component)
        {
            return wrapContentsAnchored('dynamic', '') as unknown as HTMLElement;
        }

        const resolvedProps = dynamicProps.props ? untrack(() => dynamicProps.props!()) : {};
        return wrapContentsAnchored('dynamic', serializeChild(Component(resolvedProps))) as unknown as HTMLElement;
    }

    // Hydration: adopt the wrapper + current component on the first effect run; a later
    // component swap uses the normal DOM swap.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            const { target, contentCursor } = adoptCoRange(cursor);
            driveDynamic(dynamicProps, target, true, contentCursor);
        }) as unknown as HTMLElement;
    }

    // Fresh client render: NO wrapper element - comment markers bracket the active
    // component so it is a DIRECT child of the real parent (legal inside <table>/<select>/<ul>).
    const { fragment, target } = createCoMarkers('dynamic');

    driveDynamic(dynamicProps, target, false);

    return fragment as unknown as HTMLElement;
}

/**
 * Wires the component-swap effect onto `target`. Shared by the DOM path (a marker range)
 * and hydration (the adopted server span).
 *
 * @internal
 * @param dynamicProps - The Dynamic props.
 * @param target - Where to render the component: a marker range or the server span.
 * @param hydrateFirstRun - When true, the first run adopts existing server children.
 * @param hydrationCursor - The cursor over the server range (hydration path only).
 */
function driveDynamic(dynamicProps: DynamicProps, target: CoTarget, hydrateFirstRun: boolean, hydrationCursor?: HydrationCursorType): void
{
    let branchDispose: DisposeFn | null = null;
    let firstRun = hydrateFirstRun;

    // Track ONLY the component getter; a prop change must not rebuild the tree. Components
    // subscribe to their own props internally for fine-grained updates.
    createEffect(() =>
    {
        // Reading component() subscribes this effect, so a swap re-runs it; props do not.
        const Component = dynamicProps.component();

        if (Component)
        {
            // Read props WITHOUT subscribing (initial value only).
            const props = dynamicProps.props ? untrack(() => dynamicProps.props!()) : {};

            if (firstRun)
            {
                firstRun = false;
                createRoot((d) =>
                {
                    branchDispose = d;
                    hydrateChild(untrack(() => Component(props)), hydrationCursor as HydrationCursorType);
                });
                // The adopted component must claim every server node in the range.
                hydrationCursor?.assertExhausted('<Dynamic> content');
                return teardownBranch;
            }

            createRoot((d) =>
            {
                branchDispose = d;
                // untrack: only the `component` signal drives this effect; a signal read in
                // the component's setup must not subscribe it (that would rebuild the tree).
                appendToCo(target, materializeChild(untrack(() => Component(props))));
            });
        }
        else if (firstRun)
        {
            firstRun = false;
            // No component: the server range must be empty too.
            hydrationCursor?.assertExhausted('<Dynamic> content');
        }

        // Single teardown path - runs before every re-render (swap) and on dispose.
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
