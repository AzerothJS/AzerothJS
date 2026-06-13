// @azerothjs/server: pure string-emitter SSR. No DOM shim required - components
// run in 'string' render mode and emit HTML directly.
//
//   import { renderToDocument } from '@azerothjs/server';
//   const html = renderToDocument(() => App({}), { title: 'Home' });
//
// The markup produced by renderToString/renderToDocument carries hydration
// markers so the client can adopt it with hydrate() from @azerothjs/renderer.

export { renderToString, renderToStaticMarkup } from './render-to-string.ts';
export { renderToDocument } from './render-to-document.ts';
export type { RenderToDocumentOptions } from './render-to-document.ts';
export { island } from './island.ts';

// Re-export the CSS flush helpers (defined in the renderer) for convenience,
// so a server only needs to import from @azerothjs/server.
export { collectStyleSheet, resetStyleSheet } from '@azerothjs/renderer';

export type { SSRNode, RenderMode } from '@azerothjs/reactivity';
