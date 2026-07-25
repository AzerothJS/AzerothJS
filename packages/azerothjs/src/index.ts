/**
 * MODULE: azerothjs - the framework's entry package
 *
 * Re-exports the framework's public packages behind one install:
 *   - @azerothjs/reactivity - signals, memos, effects, resources, roots, error handling, render mode;
 *   - @azerothjs/renderer   - h(), render/hydrate, control flow (Show/For/Switch/Match/Dynamic/
 *                             Suspense/Transition/Portal), refs, css/class/style bindings;
 *   - @azerothjs/component  - ErrorBoundary, destroyComponent;
 *   - @azerothjs/store      - createStore;
 *   - @azerothjs/form       - createForm + validators + phone/countries;
 *   - @azerothjs/router     - createRouter, Link/Routes/Outlet, the use* composables, history adapters;
 *   - @azerothjs/server     - SSR: renderToString / renderToStaticMarkup / renderToDocument.
 *
 * INSTALL ONE, GET THE WHOLE FRAMEWORK:
 *
 *   import {
 *       createSignal, createEffect, h, Show, For,
 *       createRouter, Link, Routes,
 *       createForm, createStore, renderToString
 *   } from 'azerothjs';
 *
 * Or import individual packages directly for the same exports with a smaller dependency surface:
 *
 *   import { createSignal } from '@azerothjs/reactivity';
 *   import { createRouter } from '@azerothjs/router';
 *
 * Tree-shaking drops unused exports either way, so the choice is one of EXPLICITNESS, not bundle size.
 *
 * Generated `.azeroth` output imports its runtime helpers from the `azerothjs/internal`
 * subpath (see ./internal.ts - the compiled-output runtime contract), NOT from this
 * public entry - so the application API here can evolve without breaking compiled code.
 *
 * @see {@link createSignal}
 * @see {@link h}
 * @see {@link renderToString}
 */

// Reactivity

export {
    createSignal,
    createEffect,
    createMemo,
    batch,
    untrack,
    on,
    onCleanup,
    onMount,
    onRootDispose,
    createRoot,
    getOwner,
    runWithOwner,
    createContext,
    provideContext,
    useContext,
    createDeferred,
    createSelector,
    createResource,
    createStream,
    catchError,
    onUncaughtError,
    getRenderMode,
    isStringMode,
    isHydrating,
    runInMode,
    getStoreScope,
    runInStoreScope
} from '@azerothjs/reactivity';

export type {
    CleanupFn,
    Getter,
    Setter,
    Signal,
    Subscriber,
    EffectFn,
    DisposeFn,
    Owner,
    Context,
    EqualsFn,
    SignalOptions,
    EffectOptions,
    UncaughtErrorContext,
    Resource,
    Stream,
    StreamOptions,
    StreamParseMode,
    RenderMode,
    SSRNode
} from '@azerothjs/reactivity';

// Renderer

export {
    h,
    render,
    hydrate,
    hydrateIslands,
    Show,
    For,
    Switch,
    Match,
    Portal,
    destroyPortal,
    Dynamic,
    Suspense,
    Transition,
    TransitionGroup,
    VirtualList,
    createVirtualizer,
    createRef,
    classList,
    styleMap,
    css,
    collectStyleSheet,
    resetStyleSheet
} from '@azerothjs/renderer';

export type {
    Props,
    Child,
    MountNode,
    ShowProps,
    ForProps,
    MatchCase,
    MatchProps,
    SwitchProps,
    PortalProps,
    DynamicProps,
    SuspenseProps,
    TransitionProps,
    TransitionGroupProps,
    VirtualListProps,
    VirtualizerOptions,
    Virtualizer,
    VirtualRange,
    Ref,
    ClassObject,
    StyleObject,
    ScopedClasses
} from '@azerothjs/renderer';

// Component

export { destroyComponent, ErrorBoundary } from '@azerothjs/component';
export type { ErrorBoundaryProps } from '@azerothjs/component';

// Store

export { createStore } from '@azerothjs/store';

// Form

export {
    createForm,
    createFieldArray,
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
    AsyncFieldValidator,
    RegisteredFieldProps,
    FieldArrayConfig,
    FieldArrayApi,
    FieldArrayRow,
    PhoneOptions,
    CountryInfo
} from '@azerothjs/form';

// Router

export {
    createRouter,
    createBrowserHistory,
    createMemoryHistory,
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
    RouteTransitionContext,
    NavigationKind,
    OutletProps,
    NavigateApi
} from '@azerothjs/router';

// Server (SSR)

export {
    renderToString,
    renderToStaticMarkup,
    renderToDocument
} from '@azerothjs/server';

export type { RenderToDocumentOptions } from '@azerothjs/server';
