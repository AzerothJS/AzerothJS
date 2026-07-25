/**
 * MODULE: azerothjs/internal - framework plumbing, NOT application API
 *
 * The machinery the framework's own packages (renderer, component, router, server,
 * http, testing) share across package boundaries: SSR child serialization, the
 * hydration adoption protocol, the store-scope adapter seam, and the test-only
 * subscriber probe. These symbols may change in ANY release without a major bump -
 * the semver contract covers the "." entry alone. If application code needs something
 * here, that is a missing public API: open an issue instead of importing this path.
 */

// THE thunk-chain unwrap every 'call while it is a function' site shares.
export { resolveThunks } from './resolve-thunks.ts';

// SSR serialization shared by every control-flow serializer.
export { serializeChild, wrapContentsAnchored } from './ssr.ts';

// The hydration adoption protocol (descriptor nodes, the cursor, the mismatch error).
export {
    isHydrationNode,
    hydrationNode,
    transferCarriedSymbols,
    HydrationCursor,
    HydrationMismatchError
} from './hydration.ts';
export type { HydrationNode } from './hydration.ts';

// Adapter seam: async-context-backed store scoping (@azerothjs/http's request root).
export { setStoreScopeResolver } from './store-scope.ts';

// Test probe: live subscriber count for leak assertions (@azerothjs/testing's leakGuard).
export { subscriberCount } from './create-signal.ts';
