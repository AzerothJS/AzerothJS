/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The bridge between a Router and the DOM: the PER-SEGMENT route tree.
 *
 * The shape:
 *
 * Construction is TOP-DOWN. Each matched level renders in its own root, and a layout's
 * `children` prop is a SLOT HANDLE - a branded, non-callable object the layout places
 * (normally through `<Outlet>`), at which point the slot's marker range and driving effect
 * are created. A navigation rebuilds only the segments whose IDENTITY changed - the route
 * object at that level, or the params its own pattern binds - and RETAINS every ancestor:
 * same DOM, same state, no body re-execution. Transitions and focus play at the OUTERMOST
 * REBUILT segment.
 *
 * The rendering source is one Routes-level signal, `committed`: the guarded match, HELD at
 * its previous value while the chain awaits a lazy chunk, with a PENDING state for a cold
 * start (renders NOTHING - never the fallback). `committed` alone reads `chainReady()`;
 * slot identity memos derive from it and nothing else.
 *
 * Hydration adopts the whole chain in one synchronous top-down walk under the pass: slots
 * adopt their `azc:outlet` ranges INLINE at placement (an effect's first run cannot be
 * trusted to run inside the pass - it queues when created inside a drain), and every slot
 * effect is created with its first run consumed. A per-instance `adopting` signal freezes
 * slot identity until the instance's adoption completes.
 */

import type { DisposeFn } from '../reactivity/index.ts';
import type { HydrationCursor as HydrationCursorType } from '../reactivity/internal.ts';
import { createEffect, createMemo, createRoot, createSignal, isStringMode, isHydrating, onRootDispose, runInMode, untrack } from '../reactivity/index.ts';
import { serializeChild, wrapContentsAnchored, hydrationNode, deferHydration, runInPass } from '../reactivity/internal.ts';
import type { HydrationPass } from '../reactivity/internal.ts';
import { createSlotHandle, claimSlotPlacement, releaseSlotPlacement, type SlotHandle } from '../reactivity/slot-handle.ts';
import { type CoTarget, type MountNode, createCoMarkers, appendToCo, clearCo, adoptCoRange, resolveMountNode, destroyComponent } from '../component/index.ts';
import { playTransitionClasses } from '../renderer/transition-classes.ts';
import { adoptStyleSheet } from '../renderer/adopt-style.ts';
import { hydrateChild } from '../renderer/h.ts';
import type { Params, RouteMatch } from './types.ts';
import type { NavigationKind, Router } from './router.ts';
import { componentOf } from './router.ts';
import { paramNamesOf } from './path-pattern.ts';
import { withRouteLevel, resolveRouter } from './provider.ts';

/** What a `transition` FUNCTION receives to pick (or veto) a name per swap. */
export interface RouteTransitionContext
{
    /** The match being left, or null when the fallback was showing. */
    from: RouteMatch | null;

    /** The match being entered, or null when swapping to the fallback. */
    to: RouteMatch | null;

    /** What caused the change - 'push' | 'replace' | 'pop'; the directional-drift hook. */
    navigation: NavigationKind;

    /** Pop distance (-1 back, +1 forward, 0 otherwise) - the finer directional hook. */
    delta: number;

    /** The target entry's stamp. */
    key: string;
}

/**
 * Props for the `<Routes>` component.
 */
export interface RoutesProps
{
    /** The router whose `match()` drives this dispatcher; omit inside a <RouterProvider>. */
    router?: Router;

    /**
     * Optional fallback component, rendered when no route matches. Use it for
     * 404 / catch-all UI. If absent, nothing is rendered for unmatched URLs.
     */
    fallback?: (() => MountNode) | undefined;

    /**
     * Animate route swaps with `<Transition>`'s 6-class family, at the OUTERMOST segment
     * a navigation actually REBUILDS: the outgoing content of that one slot plays
     * `{name}-leave-*` (removal deferred until it completes) while the incoming plays
     * `{name}-enter-*` - both mounted simultaneously inside the slot, so a cross-fade or
     * a directional drift is pure CSS, scoped to what changed. Retained ancestors do not
     * animate. A FUNCTION receives {@link RouteTransitionContext} (from, to, and what
     * caused the change) and returns the name per swap - or null for an instant swap.
     *
     * Requires the REBUILT segment to render a SINGLE ELEMENT root; a fragment root swaps
     * instantly (classes need one element to land on). The first render never animates.
     */
    transition?: string | ((context: RouteTransitionContext) => string | null) | undefined;

    /** Fallback timeout (ms) for the transition waits; default 1000. */
    transitionDuration?: number | undefined;
}

/** The cold-start hold: nothing has ever been accepted and the chain is not ready. */
const PENDING: unique symbol = Symbol('azeroth.routes.pending');

/** A committed rendering source value. */
type Committed = RouteMatch | null | typeof PENDING;

/** The NEVER sentinel a fresh slot's in-body value guard starts from. */
const NEVER: unique symbol = Symbol('azeroth.routes.never');

/** One segment's identity: the route object at its level plus its OWN bound params. */
interface SegmentIdentity
{
    route: RouteMatch['matched'][number];
    params: Params;
}

/** Everything the per-segment machinery shares within one `<Routes>` instance. */
interface RoutesShared
{
    router: Router;
    props: RoutesProps;

    /** The rendering source: the guarded match, held while unready, PENDING cold. */
    committed: () => Committed;

    /** Per-instance adoption freeze. */
    adopting: () => boolean;

    /** The previous/current committed chain, for the transition context's from/to. */
    previousMatch: RouteMatch | null;
    currentMatch: RouteMatch | null;

    /** Focus fires only on real navigations, never the initial mount. */
    mounted: boolean;
}

/**
 * Renders the router's currently matched route chain as a per-segment tree: retained
 * segments keep their DOM and state across navigations; only the segments whose identity
 * changed rebuild.
 *
 * A layout route MUST place its `children` (normally through an {@link Outlet}) or the
 * deeper levels are never constructed. Params reach components through useParams, never
 * as props.
 *
 * @param props - See {@link RoutesProps}. `fallback` renders when nothing matches.
 * @returns A handle holding the rendered chain.
 * @example
 * Routes({ router, fallback: () => h('h1', {}, '404') });
 *
 * @see {@link createRouter}
 * @see {@link Outlet}
 */
export function Routes(props: RoutesProps): MountNode
{
    const router = resolveRouter(props.router, 'Routes');

    // Server-side rendering: evaluate the match ONCE (no live effects anywhere - pinned)
    // and emit the chain eagerly, top-down, with one nested `azc:outlet` range per placed
    // slot. Slot handles serialize themselves through serializeChild's branded dispatch.
    if (isStringMode())
    {
        const matchResult = untrack(() => router.match());
        const inner = matchResult !== null
            ? serializeChild(buildSegmentValue(router, matchResult, 0))
            : (props.fallback ? serializeChild(props.fallback()) : '');
        return wrapContentsAnchored('routes', inner) as unknown as MountNode;
    }

    // Hydration: adopt the server-rendered range and the current chain on the first
    // driver run; later navigations use the normal per-segment swap.
    if (isHydrating())
    {
        return hydrationNode((cursor: HydrationCursorType): void =>
        {
            const { target, contentCursor } = adoptCoRange(cursor);
            driveRoutes(props, router, target, true, contentCursor);
        }) as unknown as MountNode;
    }

    // Fresh client render: comment markers bracket the active tree.
    const { fragment, target } = createCoMarkers('routes');
    driveRoutes(props, router, target, false);
    return fragment;
}

/**
 * Wires the Routes-level driver onto `target`: builds `committed` and the shared state,
 * then drives the fallback <-> chain <-> pending transitions. Ordinary navigations never
 * re-run the driver - they re-run exactly the outermost rebuilt segment's slot effect.
 *
 * @internal
 */
function driveRoutes(props: RoutesProps, router: Router, target: CoTarget, hydrateFirstRun: boolean, hydrationCursor?: HydrationCursorType): void
{
    // --- committed: the one tracked reader of chainReady() -----------------------------
    // A closure-latched compute (the memo `equals` option cannot implement the hold: the
    // first value bypasses equals, and an equals-time chainReady read runs outside the
    // memo's tracking frame). A deliberate, framework-internal exception to compute purity.
    let latched: RouteMatch | null = null;
    let everReady = false;
    const committed = createMemo<Committed>(() =>
    {
        const m = router.match();
        const ready = router.chainReady();
        if (m === null)
        {
            everReady = true;
            latched = null;
            return null;
        }
        if (ready)
        {
            everReady = true;
            latched = m;
            return m;
        }
        return everReady ? latched : PENDING;
    });

    // The kind DISCRIMINATOR: the driver's only tracked read. chain -> chain navigations
    // keep the value 'chain', so the driver's effect never re-runs for them.
    const kindOf = (c: Committed): 'pending' | 'null' | 'chain' =>
        (c === PENDING ? 'pending' : c === null ? 'null' : 'chain');
    const kind = createMemo(() => kindOf(committed()));

    const [adopting, setAdopting] = createSignal(false);

    const shared: RoutesShared = {
        router,
        props,
        committed,
        adopting,
        previousMatch: null,
        currentMatch: null,
        mounted: false
    };

    // Navigation bookkeeping for the transition context's from/to. Created BEFORE any
    // slot machinery so it runs earlier in every wave (creation-order queueing).
    createEffect(() =>
    {
        const c = committed();
        if (c !== PENDING)
        {
            shared.previousMatch = shared.currentMatch;
            shared.currentMatch = c;
        }
    });

    // Deferred-hydration ticket, one per instance: taken when the first run cannot
    // adopt yet (an unresolved lazy chunk), released the moment adoption completes.
    let deferred: { pass: HydrationPass; release: () => void } | null = null;
    let firstRun = hydrateFirstRun;

    // The chain (level 0) placement currently driven by this instance.
    let chainDispose: DisposeFn | null = null;
    let fallbackDispose: DisposeFn | null = null;
    let lastKind: 'pending' | 'null' | 'chain' | typeof NEVER = NEVER;

    const teardown = (): void =>
    {
        // A <Routes> disposed during the lazy hydration hold must not leave the pass's
        // pending count elevated; release is idempotent.
        deferred?.release();
        deferred = null;
        chainDispose?.();
        chainDispose = null;
        if (fallbackDispose !== null)
        {
            fallbackDispose();
            fallbackDispose = null;
        }
        clearCo(target);
    };

    /** Mounts the chain from level 0 into the routes range. */
    const mountChain = (present = false): void =>
    {
        createRoot((dispose) =>
        {
            chainDispose = dispose;
            mountSegmentSlot(shared, 0, target, null, present);
        });
    };

    /** Mounts the fallback into the routes range. */
    const mountFallback = (present = false): void =>
    {
        const fallback = props.fallback;
        if (!fallback)
        {
            return;
        }
        createRoot((dispose) =>
        {
            fallbackDispose = dispose;
            const built = resolveMountNode(untrack(fallback)) ?? null;
            appendToCo(target, built);
            // The match -> fallback swap is a real navigation: focus the fallback
            // content - the driver-level swap presents too.
            if (present && router.focusManagement && built instanceof HTMLElement)
            {
                focusRouteContent(built);
            }
        });
    };

    createEffect(() =>
    {
        const k = kind();

        // In-body value guard: a deferred re-trigger re-runs the body WITHOUT
        // dependency validation, so the scheduler's version gate alone is insufficient.
        if (k === lastKind)
        {
            return;
        }

        if (firstRun)
        {
            // Hydration first run: adopt the chain in place. The chainReady hold applies
            // here too: while the chain awaits a chunk, keep the pass open and wait.
            if (k === 'pending' || (k === 'chain' && !untrack(() => router.chainReady())))
            {
                if (deferred === null)
                {
                    deferred = deferHydration();
                }
                return;
            }
            firstRun = false;
            lastKind = k;
            shared.mounted = true;

            const adopt = (): void =>
            {
                if (k === 'chain')
                {
                    setAdopting(true);
                    try
                    {
                        const adoptedMatch = untrack(committed) as RouteMatch;
                        let adoptedDispose: DisposeFn | null = null;
                        createRoot((dispose) =>
                        {
                            adoptedDispose = dispose;
                            const value = buildSegmentValue(router, adoptedMatch, 0, shared);
                            hydrateChild(value as never, hydrationCursor as HydrationCursorType);
                        });
                        // Level 0's slot machinery, in adopted mode: without it there is
                        // no identity effect at the chain root, and the first
                        // post-adoption navigation would have nothing to re-run.
                        createRoot((dispose) =>
                        {
                            chainDispose = dispose;
                            driveSegmentSlot(shared, 0, target, null, adoptedMatch, adoptedDispose);
                        });
                    }
                    finally
                    {
                        setAdopting(false);
                    }
                }
                else if (props.fallback)
                {
                    const fallback = props.fallback;
                    createRoot((dispose) =>
                    {
                        fallbackDispose = dispose;
                        hydrateChild(untrack(fallback), hydrationCursor as HydrationCursorType);
                    });
                }
                hydrationCursor?.assertExhausted('<Routes> content');
            };

            const resume = deferred;
            try
            {
                if (resume !== null)
                {
                    runInPass(resume.pass, adopt);
                }
                else
                {
                    adopt();
                }
            }
            finally
            {
                resume?.release();
                deferred = null;
            }
            return;
        }

        // Non-first runs build in explicit dom mode: a re-run can land inside a still-open
        // runInPass window (a redirect-on-mount unwinding inside hydrate()'s window) and
        // must not build descriptors against live DOM.
        const fromKind = lastKind;
        lastKind = k;
        runInMode('dom', () =>
        {
            teardown();
            // Driver-level (fallback <-> chain) swaps present as real navigations: segment
            // 0 / the fallback content receives focus. The PENDING ->
            // first-commit fill does NOT, hence the fromKind gates. These swaps
            // are INSTANT by design - the transition prop animates chain-internal swaps.
            if (k === 'chain')
            {
                mountChain(shared.mounted && fromKind === 'null');
            }
            else if (k === 'null')
            {
                mountFallback(shared.mounted && fromKind === 'chain');
            }
            // 'pending' renders nothing - the cold-start hold (never the fallback).
        });
        shared.mounted = true;
    });

    onRootDispose(teardown);
}

/**
 * The value a segment build produces for `mode`:
 *   - 'dom'     the component's built output (a Node / co-range fragment / handle);
 *   - 'string'  the component's SSRNode tree (serializeChild consumes it);
 *   - 'hydrate' the component's descriptor tree (hydrateChild consumes it).
 *
 * The build itself is identical in all three: `componentOf(route)({ children: handle })`
 * under `withRouteLevel`, untracked. The child handle is created per build; its behavior
 * per mode lives in the SlotDriver below.
 *
 * @internal
 */
function buildSegmentValue(router: Router, match: RouteMatch, level: number, shared?: RoutesShared): unknown
{
    const route = match.matched[level];
    if (route === undefined)
    {
        return null;
    }
    // Every segment receives a slot handle - a leaf simply renders it empty, so an
    // index-child <-> param-child swap under a retained layout fills the same position.
    const handle = createChildHandle(router, match, level + 1, shared);
    return untrack(() => withRouteLevel(router, level, () => componentOf(route)({ children: handle as unknown as MountNode })));
}

/**
 * Creates the SLOT HANDLE segment `level` receives as its `children` prop. Placement
 * creates the slot's machinery; a leaf's slot renders empty markers, so a chain that
 * swaps an index child for a param child under a retained layout fills the same position.
 *
 * @internal
 */
function createChildHandle(router: Router, buildMatch: RouteMatch, level: number, shared?: RoutesShared): SlotHandle
{
    const handle: SlotHandle = createSlotHandle({
        place(parent: Node, before: ChildNode | null): void
        {
            // Guard BEFORE claim: a claim with no machinery would leave the handle
            // stuck live with nothing registered to release it.
            if (shared === undefined)
            {
                return;
            }
            if (!claimSlotPlacement(handle))
            {
                return;
            }
            // Marker pair at the placement position; the slot effect drives the content.
            const start = document.createComment('outlet');
            const end = document.createComment('/outlet');
            parent.insertBefore(start, before);
            parent.insertBefore(end, before);
            const slotTarget: CoTarget = { parent: (): Node => end.parentNode as Node, start, end };
            driveSegmentSlot(shared, level, slotTarget, handle, null, null);
        },

        serialize(): string
        {
            // String mode: eager, no effects. The slot's content is the next level's
            // serialized tree (empty at the leaf), wrapped in the outlet range.
            const inner = buildMatch.matched[level] !== undefined
                ? serializeChild(buildSegmentValue(router, buildMatch, level))
                : '';
            return (wrapContentsAnchored('outlet', inner) as unknown as { html: string }).html;
        },

        adopt(rawCursor: unknown): void
        {
            const cursor = rawCursor as HydrationCursorType;
            if (shared === undefined)
            {
                return;
            }
            if (!claimSlotPlacement(handle))
            {
                return;
            }
            // Inline adoption: claim the labeled range ON THIS STACK - a slot
            // effect's first run queues past the pass inside a deferred resume, so the
            // walk cannot ride effects. The nested segment constructs and hydrates here,
            // recursively; the slot effect is then created with its first run consumed.
            const { target: slotTarget, contentCursor } = adoptCoRange(cursor, 'outlet');
            let adoptedDispose: DisposeFn | null = null;
            const adoptedMatch = untrack(shared.committed);
            if (adoptedMatch !== PENDING && adoptedMatch !== null && adoptedMatch.matched[level] !== undefined)
            {
                createRoot((dispose) =>
                {
                    adoptedDispose = dispose;
                    const value = buildSegmentValue(router, adoptedMatch, level, shared);
                    hydrateChild(value as never, contentCursor);
                });
            }
            contentCursor.assertExhausted(`route slot (level ${ level })`);
            driveSegmentSlot(shared, level, slotTarget, handle, adoptedMatch === PENDING ? null : adoptedMatch, adoptedDispose);
        }
    });
    return handle;
}

/** Mounts level `level` directly into `target` (the Routes-level chain mount). */
function mountSegmentSlot(shared: RoutesShared, level: number, target: CoTarget, adopted: RouteMatch | null, presentFirstBuild = false): void
{
    driveSegmentSlot(shared, level, target, null, adopted, null, presentFirstBuild);
}

/**
 * The per-segment slot machinery: one identity memo, one effect with the consumed-first-
 * run and in-body value guards, per-slot leaving set, enter-cancel storage, and the
 * bottom-up teardown hand-off. `handle` is null for the Routes-level chain mount (level 0
 * has no handle - the driver owns it).
 *
 * @internal
 */
function driveSegmentSlot(shared: RoutesShared, level: number, target: CoTarget, handle: SlotHandle | null, adoptedMatch: RouteMatch | null, adoptedDispose: DisposeFn | null, presentFirstBuild = false): void
{
    const { router, props } = shared;

    // --- identity ---------------------------------------------------------------------
    // Frozen to the adopted identity while this instance is adopting; otherwise derived
    // from committed: the route object at this level plus its OWN bound params.
    const identityFor = (match: RouteMatch): SegmentIdentity | null =>
    {
        const route = match.matched[level];
        if (route === undefined)
        {
            return null;
        }
        const params: Params = {};
        for (const name of paramNamesOf(route.path))
        {
            const value = match.params[name];
            if (value !== undefined)
            {
                params[name] = value;
            }
        }
        return { route, params };
    };

    const identityEquals = (a: SegmentIdentity | null, b: SegmentIdentity | null): boolean =>
    {
        if (a === b)
        {
            return true;
        }
        if (a === null || b === null)
        {
            return false;
        }
        if (a.route !== b.route)
        {
            return false;
        }
        const aKeys = Object.keys(a.params);
        const bKeys = Object.keys(b.params);
        if (aKeys.length !== bKeys.length)
        {
            return false;
        }
        for (const key of aKeys)
        {
            if (a.params[key] !== b.params[key])
            {
                return false;
            }
        }
        return true;
    };

    const frozenIdentity: SegmentIdentity | null = adoptedMatch !== null ? identityFor(adoptedMatch) : null;
    let lastComputed: SegmentIdentity | null = frozenIdentity;
    const identity = createMemo<SegmentIdentity | null>(() =>
    {
        if (shared.adopting())
        {
            return frozenIdentity;
        }
        const c = shared.committed();
        if (c === PENDING || c === null)
        {
            // The driver is about to tear this slot down (or hold); keep the last
            // identity so no spurious slot work happens first.
            return lastComputed;
        }
        lastComputed = identityFor(c);
        return lastComputed;
    }, { equals: identityEquals });

    // --- swap state -------------------------------------------------------------------
    let lastRendered: SegmentIdentity | null | typeof NEVER = NEVER;
    let consumeFirstRun = false;
    let branchDispose: DisposeFn | null = adoptedDispose;
    let currentEl: HTMLElement | null = null;
    let enterCancel: (() => void) | null = null;
    const leaving = new Map<HTMLElement, { dispose: DisposeFn; cancel: () => void }>();

    if (adoptedMatch !== null || adoptedDispose !== null)
    {
        // Adopted placement: the consumed first run records the adopted identity so the
        // value guard alone is correct on every later path.
        consumeFirstRun = true;
        lastRendered = frozenIdentity;
        // Record the adopted content's root when the range holds EXACTLY one node and it
        // is an element - buildInto's currentEl for the adoption path. Without this the
        // FIRST navigation away from a hydrated screen swapped instantly while every
        // later one animated (adoption never runs buildInto, the only recorder). The
        // strict one-node rule keeps teardownBranch's single-element fast path honest:
        // a multi-node range stays on the clearCo path.
        const node = target.start.nextSibling;
        if (node !== null && node !== target.end && node.nextSibling === target.end && node instanceof HTMLElement)
        {
            currentEl = node;
        }
    }

    const flushLeaving = (): void =>
    {
        for (const [el, entry] of [...leaving])
        {
            entry.cancel();
            leaving.delete(el);
            el.parentNode?.removeChild(el);
            destroyComponent(el);
            entry.dispose();
        }
    };

    const transitionName = (): string | null =>
    {
        const transition = props.transition;
        if (transition === undefined)
        {
            return null;
        }
        if (typeof transition === 'string')
        {
            return transition;
        }
        const l = router.location();
        return transition({ from: shared.previousMatch, to: shared.currentMatch, navigation: l.navigationKind, delta: l.delta, key: l.key });
    };

    const teardownBranch = (): void =>
    {
        // The armed ENTER play dies with the branch (on demotion OR
        // teardown) - a detached element must not keep a live transitionend wait or
        // fallback timer mutating its classes after destroyComponent.
        enterCancel?.();
        enterCancel = null;
        if (branchDispose)
        {
            branchDispose();
            branchDispose = null;
        }
        if (currentEl !== null)
        {
            currentEl.parentNode?.removeChild(currentEl);
            // Destroy hooks run for single-element rebuilt branches too (release-noted;
            // the old fast path skipped destroyComponent).
            destroyComponent(currentEl);
            currentEl = null;
            return;
        }
        clearCo(target);
    };

    const buildInto = (animatedName: string | null, moveFocus: boolean): void =>
    {
        const c = untrack(shared.committed);
        if (c === PENDING || c === null)
        {
            return;
        }
        createRoot((dispose) =>
        {
            branchDispose = dispose;
            const built = resolveMountNode(buildSegmentValue(router, c, level, shared)) ?? null;
            appendToCo(target, built);
            currentEl = built instanceof HTMLElement ? built : null;
            if (animatedName !== null && currentEl !== null)
            {
                enterCancel = playTransitionClasses(currentEl, animatedName, 'enter', props.transitionDuration, () => undefined);
            }
            if (moveFocus && currentEl !== null)
            {
                focusRouteContent(currentEl);
            }
        });
    };

    // --- the slot effect ---------------------------------------------------------------
    createEffect(() =>
    {
        const id = identity();

        // Consumption check FIRST, then the value guard.
        if (consumeFirstRun)
        {
            consumeFirstRun = false;
            lastRendered = id;
            return;
        }
        if (lastRendered !== NEVER && identityEquals(lastRendered, id))
        {
            return;
        }
        const isFirstBuild = lastRendered === NEVER;
        lastRendered = id;

        runInMode('dom', () =>
        {
            // A navigation arriving mid-animation finishes this slot's exits NOW.
            flushLeaving();

            // This RE-RUN is by construction the outermost rebuilt segment for the
            // navigation (ancestors did not re-run; deeper slots are recreated fresh
            // inside this build), so presentation happens here.
            const name = !isFirstBuild && shared.mounted ? untrack(transitionName) : null;
            const animated = name !== null && currentEl !== null;
            // presentFirstBuild: the Routes-level chain mount of a fallback -> chain
            // swap - a real navigation whose FIRST slot build is the arriving screen.
            const moveFocus = router.focusManagement
                && ((!isFirstBuild && shared.mounted) || (isFirstBuild && presentFirstBuild));

            if (animated)
            {
                const el = currentEl as HTMLElement;
                // The enter play's cancel is invoked on demotion:
                // a still-armed enter would re-apply classes onto the LIVE element
                // mid-leave and let either play's transitionend finish the other's.
                enterCancel?.();
                enterCancel = null;
                const dispose = branchDispose;
                branchDispose = null;
                currentEl = null;
                const entry = {
                    dispose: dispose ?? ((): void => undefined),
                    cancel: (): void => undefined
                };
                leaving.set(el, entry);
                entry.cancel = playTransitionClasses(el, name, 'leave', props.transitionDuration, () =>
                {
                    leaving.delete(el);
                    el.parentNode?.removeChild(el);
                    destroyComponent(el);
                    entry.dispose();
                });
            }
            else
            {
                teardownBranch();
            }

            if (id !== null)
            {
                buildInto(animated ? name : null, moveFocus);
            }
        });
    });

    // Bottom-up teardown: each slot's disposal path flushes its OWN leaving
    // set, disposes the child root (whose drain reaches deeper slots' teardowns), clears
    // its range, removes its markers when it owns them, and re-arms the handle.
    onRootDispose(() =>
    {
        flushLeaving();
        teardownBranch();
        if (handle !== null)
        {
            const start = target.start;
            const end = target.end;
            start.parentNode?.removeChild(start);
            end.parentNode?.removeChild(end);
            releaseSlotPlacement(handle);
        }
    });
}

/**
 * Moves focus into freshly swapped route content (an element marked
 * `data-route-focus` wins; the content root otherwise), so keyboard and
 * screen-reader users land where the navigation took them. A transient
 * `tabindex="-1"` makes a non-focusable root focusable for exactly this
 * programmatic move and cleans itself up on blur; `preventScroll` keeps the
 * router's own scroll management authoritative.
 *
 * When focusing the FALLBACK region (the app did not mark a `[data-route-focus]`
 * target), the region is tagged with `data-azeroth-route-focus-fallback` for the
 * duration of the programmatic focus and a single, overridable stylesheet hides the
 * default focus ring for that attribute: this is a focus-for-assistive-tech on a whole
 * page region, not a user-driven control focus, so a visible outline around it reads as a
 * stray page/window border. The framework never mutates the element's inline styles -
 * presentation stays declarative and app-overridable - and an app that opts in with
 * `[data-route-focus]` keeps its outline fully stylable.
 *
 * @internal
 */
function focusRouteContent(root: HTMLElement): void
{
    const marked = root.querySelector<HTMLElement>('[data-route-focus]');
    const target = marked ?? root;
    if (!target.hasAttribute('tabindex'))
    {
        target.setAttribute('tabindex', '-1');
        // Only the router's own fallback region is tagged; a marked target is the app's to style.
        const tagged = marked === null;
        if (tagged)
        {
            ensureRouteFocusStyle();
            target.setAttribute(ROUTE_FOCUS_FALLBACK_ATTR, '');
        }
        target.addEventListener('blur', () =>
        {
            target.removeAttribute('tabindex');
            target.removeAttribute(ROUTE_FOCUS_FALLBACK_ATTR);
        }, { once: true });
    }
    target.focus({ preventScroll: true });
}

const ROUTE_FOCUS_FALLBACK_ATTR = 'data-azeroth-route-focus-fallback';

/**
 * Injects, once per document, the single overridable rule that hides the default focus ring on
 * the router's transient programmatic route-focus region. Author-level (no `!important`) so an
 * app can override it; scoped to the framework-owned attribute so it touches nothing else.
 *
 * @internal
 */
function ensureRouteFocusStyle(): void
{
    adoptStyleSheet(
        ROUTE_FOCUS_FALLBACK_ATTR,
        `[${ ROUTE_FOCUS_FALLBACK_ATTR }]{outline:none}`,
        ROUTE_FOCUS_FALLBACK_ATTR
    );
}
