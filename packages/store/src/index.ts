// ============================================================================
// AZEROTHJS — Global Store Public API
// ============================================================================
//
// EXPORTED (public):
//   createStore() — Lazy-singleton wrapper around a reactive factory
//
// HOW IT FITS:
//
//   `createStore(factory)` returns a `useStore()` function. The
//   factory runs on the first call, with a `createRoot` wrapper
//   so its `createEffect` / `createMemo` / `onRootDispose` calls
//   have somewhere to live. Subsequent calls return the same
//   cached instance — true cross-component shared state without
//   prop drilling.
//
//   The factory's return shape IS the store's public surface. No
//   schema, no reducer protocol, no `this` magic. Stores compose
//   naturally: one store's factory can call other stores'
//   `useStore()` functions.
//
// ============================================================================

export { createStore } from './create-store.ts';
