// ============================================================================
// AZEROTHJS — @azerothjs/core (Umbrella Package)
// ============================================================================
//
// Re-exports everything from the framework's public packages:
//   @azerothjs/reactivity, @azerothjs/renderer, @azerothjs/component,
//   @azerothjs/store, @azerothjs/form, @azerothjs/router.
//
// Install one package, get the whole framework:
//
//   import {
//       createSignal, h, defineComponent,
//       createRouter, Link, Routes,
//       createForm, createStore
//   } from '@azerothjs/core';
//
// Or import individual packages directly — same exports, smaller
// dependency surface for apps that only use a slice:
//
//   import { createSignal } from '@azerothjs/reactivity';
//   import { createRouter } from '@azerothjs/router';
//
// Tree-shaking handles the unused exports either way; the choice
// is one of explicitness, not bundle size.
//
// ============================================================================

// ── Reactivity ───────────────────────────────────────────────────────────────

export {
    createSignal,
    createEffect,
    createMemo,
    batch,
    untrack,
    on,
    onCleanup,
    onRootDispose,
    createRoot,
    createDeferred,
    createSelector,
    createResource,
    createStream,
    catchError
} from '@azerothjs/reactivity';

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
    Resource,
    Stream,
    StreamOptions,
    StreamParseMode
} from '@azerothjs/reactivity';

// ── Renderer ─────────────────────────────────────────────────────────────────

export {
    h,
    render,
    Show,
    For,
    Switch,
    Match,
    Portal,
    destroyPortal,
    Dynamic,
    Suspense,
    Transition,
    createRef,
    classList,
    styleMap
} from '@azerothjs/renderer';

export type {
    Props,
    Child,
    ShowProps,
    ForProps,
    MatchCase,
    PortalProps,
    DynamicProps,
    SuspenseProps,
    TransitionProps,
    Ref,
    ClassObject,
    StyleObject
} from '@azerothjs/renderer';

// ── Component ───────────────────────────────────────────────────────────────

export {
    defineComponent,
    destroyComponent,
    onMount,
    onDestroy,
    AzerothComponent,
    ErrorBoundary
} from '@azerothjs/component';

export type {
    Component,
    ComponentSetup,
    LifecycleHook,
    ReactiveState,
    ErrorBoundaryProps
} from '@azerothjs/component';

// ── Store ───────────────────────────────────────────────────────────────────

export { createStore } from '@azerothjs/store';

// ── Form ────────────────────────────────────────────────────────────────────

export {
    createForm,
    required,
    minLength,
    maxLength,
    min,
    max,
    pattern,
    email,
    url,
    oneOf,
    combine,
    phone,
    countries,
    getCountry
} from '@azerothjs/form';

export type {
    FormConfig,
    FormApi,
    FieldValidator,
    RegisteredFieldProps,
    PhoneOptions,
    CountryInfo
} from '@azerothjs/form';

// ── Router ──────────────────────────────────────────────────────────────────

export {
    createRouter,
    createBrowserHistory,
    compilePath,
    parseQuery,
    stringifyQuery,
    targetToFullPath,
    Link,
    Routes,
    Outlet,
    useRoute,
    useMatch,
    useParams,
    useQuery,
    useNavigate,
    useLoader
} from '@azerothjs/router';

export type {
    Router,
    Route,
    RouteLocation,
    RouteComponent,
    RouteMatch,
    Params,
    Query,
    NavigateTarget,
    NavigateOptions,
    RouterMode,
    RouterConfig,
    HistoryAdapter,
    PathMatcher,
    LinkProps,
    RoutesProps,
    OutletProps,
    NavigateApi
} from '@azerothjs/router';
