/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The compiled-output runtime contract, and the framework plumbing that rides with it.
 *
 * Every import in generated `.azeroth` output resolves HERE, and only here - the
 * compiler's RUNTIME_MODULE points at this subpath. That makes this file the single
 * compatibility surface between a compiled application and the runtime it runs on:
 * the public "." entry can rename or reshape freely without breaking already-compiled
 * code, and this contract is versioned deliberately (RUNTIME_CONTRACT_VERSION below)
 * rather than implicitly by whatever the public API happens to export.
 *
 * It also carries the cross-package plumbing the framework's OTHER packages consume
 * (http's store-scope seam, testing's subscriber probe, the SSR serializers) - all
 * exempt from semver; the "." entry alone is the supported surface.
 *
 * The export set is guarded by the compiler's runtime-contract drift test: an emitted
 * name this module does not export fails the suite.
 */

/**
 * The runtime-contract version this runtime speaks. The compiler stamps every compiled
 * module with the version it emitted against (`assertRuntimeContract(N)` right after the
 * imports); the two move together in lockstep releases, and this handshake exists for
 * the case lockstep cannot cover - PREBUILT compiled output (a published `.azeroth`
 * library's dist, a stale app bundle) loaded against a runtime from a different train.
 * Bump ONLY with an incompatible emit-vocabulary or helper-semantics change, together
 * with the compiler's EMITTED_CONTRACT_VERSION (the drift spec welds them).
 */
export const RUNTIME_CONTRACT_VERSION = 3;

/**
 * The load-time handshake every compiled module runs. A mismatch is a clear, actionable
 * error at startup - not undefined behavior three components deep.
 */
export function assertRuntimeContract(compiledWith: number, moduleUrl?: string): void
{
    if (compiledWith !== RUNTIME_CONTRACT_VERSION)
    {
        // Which side is behind decides what the reader has to DO, and they are opposite actions:
        // stale COMPILED output is rebuilt, a stale RUNTIME is upgraded. A single direction-blind
        // sentence sent half of all readers to the wrong remedy. The module URL is what turns
        // "something in this app" into a file - decisive when the stale artifact is one prebuilt
        // dependency inside an otherwise current install.
        const remedy = compiledWith < RUNTIME_CONTRACT_VERSION
            ? 'This module is the stale side: rebuild it with the matching compiler, or update the '
                + 'prebuilt library that shipped it.'
            : 'The installed runtime is the stale side: upgrade azerothjs to the release that '
                + 'matches the compiler this module was built with.';
        throw new Error(
            `This module was compiled for azerothjs runtime contract v${ compiledWith }, but the installed `
            + `azerothjs speaks v${ RUNTIME_CONTRACT_VERSION }. Compiled output and runtime must come from `
            + `the same release train. ${ remedy }`
            + (moduleUrl === undefined ? '' : ` (module: ${ moduleUrl })`)
        );
    }
}

//

// Keyword lowerings + wrapper blocks + mode dispatch.
export {
    createSignal,
    createMemo,
    createEffect,
    createDeferred,
    createResource,
    createStream,
    createSelector,
    createStore,
    on,
    batch,
    untrack,
    onCleanup,
    onRootDispose,
    onMount,
    isStringMode,
    isHydrating
} from './reactivity/index.ts';

// Markup runtime: the hyperscript core and the template-clone bindings.
export { componentScope } from './reactivity/create-root.ts';
export { h } from './renderer/index.ts';
// A `style { }` section compiles to this call, over the section's RAW text, so the section and
// a hand-written css`` share one scoping algorithm and one registry.
export { registerStyle, discardStyleFrame } from './renderer/css.ts';
// The head runtime's host seam: the kit drains beside collectStyleSheet; resetHead is for tests.
export { collectHead, discardHeadFrame, resetHead, type CollectedHead } from './renderer/head.ts';
export { inertJson } from './reactivity/ssr.ts';
export { bindHole, bindContent, bindEvent, bindSlot, bindProps, setProp, hydrateChild } from './renderer/h.ts';
export { tmpl } from './renderer/template.ts';

// Builtin components (usable in markup with no import).
export {
    Show,
    For,
    Switch,
    Match,
    Dynamic,
    Suspense,
    Portal,
    Transition
} from './renderer/index.ts';
export { ErrorBoundary } from './component/index.ts';
export { Outlet } from './router/index.ts';

// Keyword lowerings living outside reactivity.
export { createForm, createFieldArray } from './form/index.ts';

//

// THE thunk-chain unwrap every 'call while it is a function' site shares.
export { resolveThunks } from './reactivity/resolve-thunks.ts';

// SSR serialization shared by every control-flow serializer.
export { serializeChild, wrapContentsAnchored } from './reactivity/ssr.ts';

// The hydration adoption protocol (descriptor nodes, the cursor, the mismatch error).
export {
    isHydrationNode,
    hydrationNode,
    transferCarriedSymbols,
    HydrationCursor,
    HydrationMismatchError
} from './reactivity/hydration.ts';
export type { HydrationNode } from './reactivity/hydration.ts';

// Adapter seam: async-context-backed store scoping (@azerothjs/http's request root).
export { setStoreScopeResolver } from './reactivity/store-scope.ts';

// Test probe: live subscriber count for leak assertions (@azerothjs/testing's leakGuard).
export { subscriberCount } from './reactivity/create-signal.ts';

// The devtools bridge: the stable, versioned runtime-debugging hook @azerothjs/devtools attaches
// to. Framework infrastructure, not application API - which is why it lives on THIS entry and not
// the root: `pokeNode` writes arbitrary values into any registered signal, and none of these five
// belong in application autocomplete. Zero-cost until a hook is attached.
export {
    DEVTOOLS_PROTOCOL_VERSION,
    setDevtoolsHook,
    snapshotReactiveGraph,
    peekNode,
    pokeNode
} from './reactivity/devtools.ts';
export type {
    DevtoolsHook,
    DevtoolsNode,
    DevtoolsNodeKind,
    DevtoolsPrimitive,
    GraphSnapshot,
    GraphSnapshotNode,
    GraphEdge,
    PeekResult
} from './reactivity/devtools.ts';
