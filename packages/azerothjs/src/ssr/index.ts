/**
 * MODULE: azerothjs - public API
 *
 * Pure string-emitter SSR: no DOM shim required - components run in 'string' render mode and emit
 * HTML directly. renderToString/renderToDocument produce hydration-ready markup (carrying the
 * markers the client adopts with hydrate() from azerothjs); renderToStaticMarkup
 * produces clean non-hydrated HTML; island() marks interactivity boundaries for partial
 * hydration. The CSS-flush helpers are re-exported from the renderer so a server only needs to
 * import from azerothjs.
 *
 * @example
 * import { renderToDocument } from '../ssr/index.ts';
 * const html = renderToDocument(() => App({}), { title: 'Home' });
 */

export { renderToString, renderToStaticMarkup } from './render-to-string.ts';
export { renderToDocument } from './render-to-document.ts';
export type { RenderToDocumentOptions } from './render-to-document.ts';
export { island } from './island.ts';

export { collectStyleSheet, resetStyleSheet } from '../renderer/index.ts';

export type { SSRNode, RenderMode } from '../reactivity/index.ts';
