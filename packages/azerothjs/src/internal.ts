/**
 * MODULE: azerothjs/internal - the compiled-output runtime contract + framework plumbing
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
export const RUNTIME_CONTRACT_VERSION = 1;

/**
 * The load-time handshake every compiled module runs. A mismatch is a clear, actionable
 * error at startup - not undefined behavior three components deep.
 */
export function assertRuntimeContract(compiledWith: number): void
{
    if (compiledWith !== RUNTIME_CONTRACT_VERSION)
    {
        throw new Error(
            `This module was compiled for azerothjs runtime contract v${ compiledWith }, but the installed ` +
            `azerothjs speaks v${ RUNTIME_CONTRACT_VERSION }. Compiled output and runtime must come from the ` +
            'same release train - rebuild the app (or update the prebuilt library) with the matching compiler.'
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
export { h } from './renderer/index.ts';
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
