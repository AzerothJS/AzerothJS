// Public API for @azerothjs/reactivity.
//
// Internal wiring (currentSubscriber, setCurrentSubscriber, isBatching,
// queueEffect) is intentionally not re-exported here - those are shared
// between the primitives via direct module imports.

export { createSignal, subscriberCount } from './signal.ts';
export { createEffect } from './effect.ts';
export { createMemo } from './memo.ts';
export { batch } from './batch.ts';
export { untrack } from './untrack.ts';
export { on } from './on.ts';
export { onCleanup } from './on-cleanup.ts';
export { onRootDispose } from './on-root-dispose.ts';
export { createRoot } from './create-root.ts';
export { createDeferred } from './create-deferred.ts';
export { createSelector } from './create-selector.ts';
export { createResource } from './create-resource.ts';
export { createStream } from './create-stream.ts';
export { catchError, onUncaughtError } from './catch-error.ts';
export type { UncaughtErrorContext } from './catch-error.ts';
export { setDevtoolsHook } from './devtools-hook.ts';
export type { DevtoolsHook, DevtoolsNode } from './devtools-hook.ts';

export { getRenderMode, isStringMode, isHydrating, runInMode } from './render-mode.ts';
export type { RenderMode } from './render-mode.ts';

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

export {
    isHydrationNode,
    hydrationNode,
    transferCarriedSymbols,
    HydrationCursor,
    HydrationMismatchError
} from './hydration.ts';
export type { HydrationNode } from './hydration.ts';

export type { Resource } from './create-resource.ts';
export type { Stream, StreamOptions, StreamParseMode } from './create-stream.ts';

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
    EffectOptions
} from './types.ts';
