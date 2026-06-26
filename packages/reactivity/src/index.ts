/**
 * MODULE: @azerothjs/reactivity - public API
 *
 * The reactive core of the framework: signals (atomic state), memos (cached
 * derivations), and effects (reactions), plus the supporting primitives every other
 * package builds on - scheduling (batch), tracking control (untrack, on), lifetimes
 * (createRoot, onCleanup, onRootDispose), error handling (catchError,
 * onUncaughtError), render-mode dispatch, per-render store scope, and the SSR /
 * hydration helpers.
 *
 * This is the package's only public entry; its `exports` map exposes "." alone, so
 * every symbol re-exported here is the supported surface and is documented at its
 * definition (this file just collects them). Internal wiring shared between the
 * primitives - currentSubscriber/setCurrentSubscriber, isBatching/queueEffect, and the
 * graph link machinery - is deliberately NOT re-exported; the primitives import it
 * directly from their modules.
 */

// Core primitives: state, derivation, reaction.
export { createSignal, subscriberCount } from './create-signal.ts';
export { createEffect } from './create-effect.ts';
export { createMemo } from './create-memo.ts';

// Scheduling and tracking control.
export { batch } from './batch.ts';
export { untrack } from './untrack.ts';
export { on } from './on.ts';

// Lifetimes: ownership scopes and teardown hooks.
export { onCleanup } from './on-cleanup.ts';
export { onRootDispose } from './on-root-dispose.ts';
export { createRoot } from './create-root.ts';

// Derived helpers built on the core primitives.
export { createDeferred } from './create-deferred.ts';
export { createSelector } from './create-selector.ts';
export { createResource } from './create-resource.ts';
export { createStream } from './create-stream.ts';

// Error handling.
export { catchError, onUncaughtError } from './catch-error.ts';
export type { UncaughtErrorContext } from './catch-error.ts';

// Render-mode dispatch (dom / string / hydrate) and per-render store scope.
export { getRenderMode, isStringMode, isHydrating, runInMode } from './render-mode.ts';
export type { RenderMode } from './render-mode.ts';
export { getStoreScope, runInStoreScope } from './store-scope.ts';

// SSR string-emission helpers.
export {
    isSSRNode,
    ssr,
    setSSRMarkers,
    getSSRMarkers,
    escapeText,
    escapeAttr,
    serializeChild,
    wrapContentsAnchored
} from './ssr.ts';
export type { SSRNode } from './ssr.ts';

// Hydration: adopting server-rendered DOM.
export {
    isHydrationNode,
    hydrationNode,
    transferCarriedSymbols,
    HydrationCursor,
    HydrationMismatchError
} from './hydration.ts';
export type { HydrationNode } from './hydration.ts';

// Async/streaming resource types.
export type { Resource } from './create-resource.ts';
export type { Stream, StreamOptions, StreamParseMode } from './create-stream.ts';

// Devtools: the stable, versioned runtime-debugging hook. Consumed by @azerothjs/devtools (and any
// external agent/extension); zero-cost until a hook is attached.
export {
    DEVTOOLS_PROTOCOL_VERSION,
    setDevtoolsHook,
    snapshotReactiveGraph,
    peekNode,
    pokeNode
} from './devtools.ts';
export type {
    DevtoolsHook,
    DevtoolsNode,
    DevtoolsNodeKind,
    GraphSnapshot,
    GraphSnapshotNode,
    GraphEdge,
    PeekResult
} from './devtools.ts';

// Core reactive type contracts.
export type {
    CleanupFn,
    Getter,
    Setter,
    Signal,
    Subscriber,
    EffectFn,
    DisposeFn,
    EqualsFn,
    SignalOptions,
    EffectOptions,
    SelectorOptions
} from './types.ts';
