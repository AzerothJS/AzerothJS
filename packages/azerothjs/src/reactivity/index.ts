/**
 * The reactive core: signals, memos and effects, plus the primitives every other package
 * builds on - scheduling, tracking control, lifetimes, error handling, render-mode
 * dispatch, per-render store scope, and the SSR and hydration helpers.
 *
 * Everything re-exported here is supported surface, documented at its definition. The
 * wiring the primitives share between themselves - the current-subscriber slot, the batch
 * queue, the graph link machinery - is deliberately absent; those modules import it
 * directly from each other.
 */

// Core primitives: state, derivation, reaction.
export { createSignal } from './create-signal.ts';
export { createEffect } from './create-effect.ts';
export { createMemo } from './create-memo.ts';

// Scheduling and tracking control.
export { batch } from './batch.ts';
export { untrack } from './untrack.ts';
export { on } from './on.ts';
export type { OnOptions } from './on.ts';

// Lifetimes: ownership scopes and teardown hooks.
export { onCleanup } from './on-cleanup.ts';
export { onMount } from './on-mount.ts';
export { onRootDispose } from './on-root-dispose.ts';
export { createRoot, componentScope, getOwner, runWithOwner, type Owner } from './create-root.ts';
export { createContext, provideContext, useContext, type Context } from './create-context.ts';

// Derived helpers built on the core primitives.
export { createDeferred } from './create-deferred.ts';
export type { DeferredOptions } from './create-deferred.ts';
export { createSelector } from './create-selector.ts';
export { createResource } from './create-resource.ts';
export type { ResourceOptions } from './create-resource.ts';
export { createStream } from './create-stream.ts';

// Error handling.
export { catchError, onUncaughtError } from './catch-error.ts';
export type { UncaughtErrorContext } from './catch-error.ts';

// Render-mode dispatch (dom / string / hydrate) and per-render store scope.
export { getRenderMode, isStringMode, isHydrating, runInMode } from './render-mode.ts';
export type { RenderMode, RunInModeOptions } from './render-mode.ts';
export { getStoreScope, runInStoreScope } from './store-scope.ts';
export { createStore } from './create-store.ts';
export type { StoreOptions } from './create-store.ts';

// SSR string emission: the raw-HTML brand and the escapes. The framework's own serializers
// live in ./internal, being plumbing rather than application API.
export { isSSRNode, ssr, escapeText, escapeAttr } from './ssr.ts';
export type { SSRNode } from './ssr.ts';

// Async/streaming resource types.
export type { Resource } from './create-resource.ts';
export type { Stream, StreamOptions, StreamParseMode } from './create-stream.ts';

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
