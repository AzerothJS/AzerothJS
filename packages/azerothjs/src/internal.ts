/**
 * MODULE: azerothjs/internal - the compiled-output runtime contract
 *
 * Every import in generated `.azeroth` output resolves HERE, and only here - the
 * compiler's RUNTIME_MODULE points at this subpath. That makes this file the single
 * compatibility surface between a compiled application and the runtime it runs on:
 * the public "." entry can rename or reshape freely without breaking already-compiled
 * code, and this contract is versioned deliberately (see the compiled-output
 * handshake) rather than implicitly by whatever the public API happens to export.
 *
 * NOT application API: application code imports from 'azerothjs'. Symbols here may
 * change in any release; compiled output and runtime always ship from the same
 * version train.
 *
 * The export set = everything the compiler can emit:
 *   - keyword lowerings (state -> createSignal, derived -> createMemo, ...)
 *   - wrapper blocks (batch/untrack/cleanup/dispose)
 *   - markup runtime (h, tmpl, bind*)
 *   - mode dispatch (isStringMode/isHydrating)
 *   - the builtin components usable in markup without an import
 * Guarded by the compiler's runtime-contract drift test: an emitted name this module
 * does not export fails the suite.
 */

// Keyword lowerings + wrapper blocks + mode dispatch.
export {
    createSignal,
    createMemo,
    createEffect,
    createDeferred,
    createResource,
    createStream,
    createSelector,
    on,
    batch,
    untrack,
    onCleanup,
    onRootDispose,
    isStringMode,
    isHydrating
} from '@azerothjs/reactivity';

// Markup runtime: the hyperscript core and the template-clone bindings.
export {
    h,
    tmpl,
    bindHole,
    bindContent,
    bindEvent,
    bindSlot,
    bindProps,
    setProp,
    hydrateChild
} from '@azerothjs/renderer';

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
} from '@azerothjs/renderer';
export { ErrorBoundary } from '@azerothjs/component';
export { Outlet } from '@azerothjs/router';

// Keyword lowerings living outside reactivity.
export { createStore } from '@azerothjs/store';
export { createForm, createFieldArray } from '@azerothjs/form';
