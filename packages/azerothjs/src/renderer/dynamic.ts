/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Renders a component chosen at runtime: tab panels, role-based views, plugin slots, wizard
 * steps, nullable modals. A hand-rolled version - a reactive child that re-selects and
 * re-invokes the component - rebuilds the whole subtree whenever any signal it reads
 * changes, because the selection and the props share one tracking scope. Dynamic tracks only
 * the selection, so a prop change never tears the tree down.
 *
 * The invariants below are the public contract. A reimplementation that preserves them
 * passes every public test; everything else in this file is implementation detail, and the
 * contract matrix in the renderer tests is the executable form.
 *
 *  1. SELECTION. `component` is a callable returning a component function, an element tag
 *     string, or a falsy value; markup and the manual API present the same callable shape.
 *     It may be invoked any number of times and must therefore be side-effect free. The
 *     component function it returns is invoked at most once per mounted selection, with the
 *     resolved props as its only argument.
 *  2. EQUALITY. The rendered tree is disposed and rebuilt exactly when the selection VALUE
 *     changes under Object.is, never because a dependency re-fired to the same value, so
 *     state inside an unchanged selection survives. Forcing a remount of an unchanged
 *     selection is deliberately impossible; if it is ever wanted it arrives as an additive
 *     `key` prop folded into this equality, not by weakening it.
 *  3. TAGS. A string selection renders an element observably identical to the same element
 *     written by hand: namespace placement, attribute and DOM-property semantics, and
 *     function-valued reactive props may not differ in any detectable way. A string never
 *     names a component - there is no component registry, imports are the registry.
 *  4. FALSY AND INVALID. null, undefined and false render nothing, and a later valid
 *     selection renders normally in the same position. Any other non-function, non-string
 *     selection throws an error naming Dynamic.
 *  5. PROPS. One value-or-thunk channel whose mount-time shape picks the mode: an object is
 *     a caller-owned snapshot, while a thunk is live per property read with its key set
 *     fixed per mounted selection. Live reads route through the CURRENT `props` value and
 *     evaluate in the READER's scope, so a component child gets exactly the liveness direct
 *     markup props give. Prop changes never rebuild. Child props always ride `props`;
 *     spreads on Dynamic itself configure Dynamic, and the Solid-style spread-through was
 *     considered and declined.
 *  6. ASYNC IS NOT DYNAMIC'S CONCERN. Suspension is declared on Suspense, so a lazy or async
 *     component is a stable identity whose body reads a resource, and the selection contract
 *     never learns about promises.
 *  7. MODES. On the server, selection and props are read exactly once and the output is
 *     serialized inside 'dynamic' co-range markers. That marker format is wire contract,
 *     because a hydrating client adopts the server's DOM for the range in place and fails
 *     loudly when it does not match its own first render. In the DOM the output participates
 *     directly in its parent's flow with no wrapper element, so it works as a direct child of
 *     `<table>`, `<select>` and `<ul>`. Beyond the markers, no artifact of the mechanism is
 *     observable.
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
 * for that element, which lets data-driven `[tag, attrs][]` node lists project from
 * markup. A truthy value that is neither a function nor a tag throws a named error here,
 * where the cause is legible, rather than a bare "not a function" from inside an effect.
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
 * Renders the component the `component` getter returns, swapping only when that selection
 * actually changes.
 *
 * Only the selection is tracked; props are read untracked. That is the whole point - prop
 * churn cannot rebuild the tree, and the component is responsible for tracking its own
 * props, which it gets for free when they arrive through a thunk.
 *
 * Storing a component in a signal needs the wrap-in-arrow idiom, since a setter treats a
 * bare function argument as an updater.
 *
 * @param dynamicProps - See {@link DynamicProps}.
 * @returns A control-flow handle, typed as a node.
 * @throws {Error} If the selection resolves to something that is neither a component
 *                 function, a tag string, nor falsy.
 * @example
 * const [view, setView] = createSignal(Home);
 *
 * Dynamic({ component: view, props: () => ({ title: tab() }) });
 *
 * setView(() => About); // wrapped: a setter treats a bare function as an updater
 *
 * @see {@link Show} for a fixed two-way condition and {@link Switch} for a fixed set of cases.
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
