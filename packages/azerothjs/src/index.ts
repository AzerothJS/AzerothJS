/**
 * MODULE: azerothjs - THE frontend framework, one real package
 *
 * Everything the client half of an AzerothJS app is made of, in one install:
 *
 *   ./reactivity  - signals, memos, effects, owner tree + context, stores, resources,
 *                   streams, error handling, render-mode dispatch
 *   ./component   - ErrorBoundary, destroyComponent, the co-range contract
 *   ./renderer    - h(), render/hydrate, control flow (Show/For/Switch/Match/Dynamic/
 *                   Suspense/Transition/Portal), refs, css/class/style bindings
 *   ./ssr         - renderToString / renderToDocument, islands
 *   ./router      - createRouter, Link/Routes/Outlet, the use* composables
 *   ./form        - createForm, field arrays, validators, phone/countries
 *
 * Generated `.azeroth` output imports its runtime helpers from the `azerothjs/internal`
 * subpath (see ./internal.ts - the compiled-output runtime contract), NOT from this
 * public entry - so the application API here can evolve without breaking compiled code.
 *
 * @see {@link createSignal}
 * @see {@link h}
 * @see {@link renderToString}
 */

export * from './reactivity/index.ts';
// Named, not star: the component barrel also carries the co-range placement machinery the
// renderer builds on, which is framework infrastructure, not application API.
export { destroyComponent, ErrorBoundary } from './component/index.ts';
export type { ErrorBoundaryProps } from './component/index.ts';
// Image sits outside the component barrel: it builds markup through the renderer's h(),
// and the barrel stays renderer-free by layering.
export { DEVICE_WIDTHS, Image, ImageConfig } from './component/image.ts';
export type { ImageProps } from './component/image.ts';
export * from './renderer/index.ts';
// The render-safety gate's escape hatches. They live beside the gate itself (renderer/ssr.ts,
// which both render modes call) rather than in the renderer's own barrel, whose exports are all
// element-building API.
export { unsafeUrl, unsafeTag } from './renderer/ssr.ts';
export * from './ssr/index.ts';
export * from './router/index.ts';
export * from './form/index.ts';
