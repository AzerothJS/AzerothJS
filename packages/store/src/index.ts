/**
 * MODULE: @azerothjs/store - public API
 *
 * createStore(factory) returns a useStore() function: the factory runs on first use, wrapped in a
 * createRoot so its createEffect/createMemo/onRootDispose calls have somewhere to live; subsequent
 * calls return the same cached instance (per store scope), giving shared state across components
 * without prop drilling. The factory's return shape is the store's public surface - no schema, no
 * reducer protocol, no this-magic. Stores compose: one store's factory can call another's useStore().
 * Instances are scope-keyed, so the same code is a client singleton and per-request-isolated on SSR.
 */

export { createStore } from './create-store.ts';
