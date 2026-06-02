// Public API for the global store package.
//
// createStore(factory) returns a useStore() function. The factory runs on the
// first call, wrapped in a createRoot so its createEffect/createMemo/
// onRootDispose calls have somewhere to live; subsequent calls return the same
// cached instance, giving shared state across components without prop drilling.
//
// The factory's return shape is the store's public surface - no schema, no
// reducer protocol, no this magic. Stores compose: one store's factory can call
// another store's useStore().

export { createStore } from './create-store.ts';
