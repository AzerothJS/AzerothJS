/**
 * MODULE: renderer/dynamic
 *
 * <Dynamic> renders a component chosen by a reactive getter; the component itself can
 * change at runtime (tab panels, role-based views, plugin slots, wizard steps, nullable
 * modals). The hand-rolled alternative - a reactive child that re-selects and re-invokes
 * the component - rebuilds the whole subtree (losing its state) whenever ANY signal it
 * reads changes, because the selection and the props share one tracking scope. Dynamic
 * tracks only the `component` selection, so a prop change does not tear down and rebuild
 * the component tree.
 *
 * INVARIANTS - the public contract, stated as WHAT Dynamic guarantees, never how this
 * file achieves it. A from-scratch reimplementation that preserves these - with any
 * internal algorithm - passes every public test; everything else in this file is
 * implementation detail. The contract matrix in the renderer tests is their executable
 * form.
 *
 *  1. SELECTION: `component` is a callable returning a component function, an element tag
 *     string, or a falsy value. Markup `component={ expr }` and the manual API present
 *     this SAME callable shape - how markup arrives at it is the compiler's business, not
 *     part of this contract. The selection callable may be invoked ANY number of times
 *     and must therefore be side-effect free. The component function it returns is
 *     invoked AT MOST ONCE per mounted selection, with the resolved props as its only
 *     argument; nothing else may invoke it.
 *  2. EQUALITY: the rendered tree is disposed (its owned effects torn down, its DOM
 *     removed) and rebuilt exactly when the selection VALUE changes under Object.is
 *     semantics - never because a dependency of the selection re-fired to the same value.
 *     State inside an unchanged selection survives its dependencies re-firing. Forcing a
 *     remount of an unchanged selection is deliberately impossible today; if ever wanted,
 *     it arrives as an additive `key` prop folded into this equality, never by weakening
 *     it.
 *  3. TAGS: a string selection renders an element OBSERVABLY IDENTICAL to the same
 *     element written by hand in this framework: namespace placement (SVG/MathML),
 *     attribute and DOM-property semantics, and the function-valued reactive-prop
 *     behavior may not differ in any way a user can detect. A string never names a
 *     component: AzerothJS has no component registry; imports are the registry.
 *  4. FALSY / INVALID: null, undefined, and false all render nothing, and a later valid
 *     selection renders normally in the same position; any other non-function,
 *     non-string selection throws an error naming <Dynamic>.
 *  5. PROPS: one value-or-thunk channel whose MOUNT-TIME SHAPE picks the mode: an object
 *     is a caller-owned snapshot; a thunk makes the channel LIVE per property read, with
 *     the key set fixed per mounted selection. Live reads route through the CURRENT
 *     `props` value - swapping the thunk itself is as live as the values inside one -
 *     and evaluate in the READER's scope, so a component child gets exactly the liveness
 *     direct markup props give. Prop changes never rebuild; only the selection does.
 *     Child props always ride `props`: spreads on <Dynamic> itself configure Dynamic,
 *     and this stays so - the Solid-style spread-through was considered and declined
 *     (manual-API-first, no reserved-name carve-outs).
 *  6. ASYNC IS NOT DYNAMIC'S CONCERN: suspension is declared on Suspense (`on:`), so a
 *     lazy/async component is a stable component identity whose body reads a resource -
 *     the selection contract never learns about promises.
 *  7. MODES: on the server, selection and props are read exactly once and the rendered
 *     output is serialized inside the 'dynamic' co-range comment markers - that marker
 *     format is wire contract, because a hydrating client adopts the server's DOM for
 *     that range in place (no re-creation) and FAILS LOUDLY when the range does not match
 *     its own first render. In the DOM, the rendered output participates directly in its
 *     parent's flow - no wrapper element exists (it must work as a direct child of
 *     <table>, <select>, <ul>). Beyond the markers, NO artifact of the mechanism is
 *     observable - a user program that detects the internals is out of contract.
 */

import type { DisposeFn } from '../reactivity/index.ts';
import type { HydrationCursor as HydrationCursorType } from '../reactivity/internal.ts';
import { createEffect, createMemo, createRoot, untrack, isStringMode, isHydrating } from '../reactivity/index.ts';
import { serializeChild, wrapContentsAnchored, hydrationNode } from '../reactivity/internal.ts';
import { type CoTarget, type MountNode, createCoMarkers, appendToCo, clearCo, adoptCoRange } from '../component/index.ts';
import { hydrateChild, materializeChild, h } from './h.ts';

/**
 * Props for {@link Dynamic}.
 */
export interface DynamicProps
{
    /**
     * Reactive getter returning what to render: a COMPONENT function, an element TAG name
     * (`'path'`, `'div'` - built through h(), so SVG/MathML tags land in their namespace),
     * or null to render nothing. The selection is MEMOIZED under Object.is: the tree is
     * torn down and rebuilt only when the RESOLVED value actually changes, never because a
     * dependency of the expression re-fired to the same result. In markup,
     * `component={ expr }` supplies the inner value - the compiler wraps it into this
     * getter (the factory-prop contract, like `fallback`).
     */
    component: () => ((props: Record<string, unknown>) => MountNode) | string | null;

    /**
     * Props for the rendered output - a plain object or a thunk returning one. An OBJECT
     * is caller-owned: a swap-time snapshot. A THUNK is LIVE per property read (its key
     * set is fixed at swap): a component child reading a prop in its own reactive scope
     * tracks it there and updates in place - the same contract direct markup props give,
     * so the same child behaves identically on every render path. A prop change NEVER
     * rebuilds the tree; only the selection does. Tag selections apply props once at
     * build (function-valued entries are h()'s reactive-attribute path). The rendered
     * output's props always ride here; spreads on `<Dynamic>` itself target
     * {@link DynamicProps}, not the output.
     */
    props?: Record<string, unknown> | (() => Record<string, unknown>);
}

/**
 * Normalizes the selection to a renderable component: a TAG STRING becomes an h()-builder
 * for that element (which is what lets icon-style components project data-driven
 * `[tag, attrs][]` node lists from markup); a truthy value that is neither a function nor
 * a tag is an API-misuse error and fails LOUDLY - the cryptic alternative is a
 * "Component is not a function" thrown from deep inside an effect.
 *
 * @internal
 */
function resolveComponent(value: ((props: Record<string, unknown>) => MountNode) | string | null): ((props: Record<string, unknown>) => MountNode) | null
{
    if (typeof value === 'string')
    {
        return (props) => h(value, props);
    }
    if (value && typeof value !== 'function')
    {
        throw new Error(`<Dynamic> component must resolve to a component function, a tag string, or null - got ${ typeof value }.`);
    }
    return value;
}

/**
 * Reads the props under the one value-or-thunk contract. The channel's MOUNT-TIME SHAPE
 * picks the mode: a plain OBJECT is caller-owned and passed through as-is (a snapshot -
 * its values froze when the caller built it); a THUNK makes the channel LIVE. Live means
 * every property read routes through the CURRENT `props` value - never a captured
 * mount-time thunk - so swapping the thunk itself (`props={ dark() ? darkProps :
 * lightProps }`) is as live as the values inside one, and the whole chain evaluates in
 * the READER's scope: a child reading a prop in its own reactive scope subscribes there,
 * exactly like direct markup getter props. The KEY SET is fixed per mounted selection
 * from the initial shape. Eager readers - h()'s one-shot attribute pass for tag
 * selections - read inside the swap's untrack and therefore still see a swap-time
 * snapshot; function-valued entries remain h()'s reactive-attribute path. The untrack
 * wraps the initial property READ too, because a markup getter (`props={ expr }`)
 * evaluates the expression at that read.
 *
 * @internal
 */
function resolveProps(dynamicProps: DynamicProps): Record<string, unknown>
{
    const initial = untrack(() => dynamicProps.props);
    if (initial === undefined)
    {
        return {};
    }
    if (typeof initial !== 'function')
    {
        return initial;
    }
    const view: Record<string, unknown> = {};
    for (const key of Object.keys(untrack(initial)))
    {
        Object.defineProperty(view, key, {
            enumerable: true,
            get: () =>
            {
                const current = dynamicProps.props;
                const bag = typeof current === 'function' ? current() : current;
                return bag?.[key];
            }
        });
    }
    return view;
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
export function Dynamic(dynamicProps: DynamicProps): MountNode
{
    // SSR: resolve component + props ONCE and emit its output in a contents anchor.
    if (isStringMode())
    {
        const Component = resolveComponent(untrack(() => dynamicProps.component()));
        if (!Component)
        {
            return wrapContentsAnchored('dynamic', '') as unknown as MountNode;
        }

        return wrapContentsAnchored('dynamic', serializeChild(Component(resolveProps(dynamicProps)))) as unknown as MountNode;
    }

    // Hydration: adopt the wrapper + current component on the first effect run; a later
    // component swap uses the normal DOM swap.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            const { target, contentCursor } = adoptCoRange(cursor);
            driveDynamic(dynamicProps, target, true, contentCursor);
        }) as unknown as MountNode;
    }

    // Fresh client render: NO wrapper element - comment markers bracket the active
    // component so it is a DIRECT child of the real parent (legal inside <table>/<select>/<ul>).
    const { fragment, target } = createCoMarkers('dynamic');

    driveDynamic(dynamicProps, target, false);

    return fragment;
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

    // The MEMO is the teardown gate: the swap effect's cleanup destroys the branch before
    // every re-run, so the effect may only re-run when the selection actually CHANGED
    // (Object.is). Without it, any dependency of the component expression re-firing to the
    // same result - `count() > 0 ? 'ul' : 'p'` moving 1 -> 2 - would rebuild the whole
    // subtree and lose its state.
    const selected = createMemo(() => dynamicProps.component());

    // Track ONLY the selection; a prop change must not rebuild the tree. Components
    // subscribe to their own props internally for fine-grained updates.
    createEffect(() =>
    {
        // Reading selected() subscribes this effect, so a swap re-runs it; props do not.
        const Component = resolveComponent(selected());

        if (Component)
        {
            const props = resolveProps(dynamicProps);

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
