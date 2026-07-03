# @azerothjs/server

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fserver?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/server)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained reactive framework. Applications usually install [`azerothjs`](https://www.npmjs.com/package/azerothjs); depend on this package directly for a narrower surface.

## Overview

Server-side rendering. It renders a component tree to an HTML string without a
DOM shim: components run in string render mode and emit HTML directly. The output
carries hydration markers so the client can adopt it with `hydrate()` from
`@azerothjs/renderer`.

```ts
import { renderToDocument } from '@azerothjs/server';

const html = renderToDocument(() => App({}), { title: 'Home' });
```

## Install

```sh
npm install @azerothjs/server
```

## Architecture

The renderer and reactivity packages share a render-mode flag. In string mode,
`h()` and the control-flow components produce string output instead of DOM nodes,
so the same component code runs on the server unchanged. There is no jsdom or
DOM emulation; rendering is a pure string emission.

Three entry points cover the common cases:

- `renderToString(component)` renders the component subtree to an HTML string
  with hydration markers.
- `renderToStaticMarkup(component)` renders without hydration markers, for output
  that will not be hydrated (emails, static pages).
- `renderToDocument(component, options)` wraps the rendered markup in a full HTML
  document, with `title`, `head`, and `lang` options.

Scoped styles created with `css` are collected during rendering; the CSS flush
helpers (`collectStyleSheet`, `resetStyleSheet`) are re-exported here so a server
only needs to import from this package.

## Supported SSR patterns

What renders on the server, and how it behaves:

- **Elements, attributes, text, fragments, nested components** - serialized to
  HTML structurally identical to what the DOM path would build, so `hydrate()`
  can adopt it node-for-node.
- **Reactive props and holes** - a function prop/child is read once (no live
  effect on the server) and resolved through while it is still a function, so
  `class={classList(...)}`, `style={styleMap(...)}`, and a `{ p.title }` hole
  whose value is itself a getter all serialize to their concrete string. With
  markers on, a reactive hole is wrapped in exactly one `<!--[-->...<!--]-->`
  anchor pair - the span the client hydrator adopts.
- **Control flow** - `Show`, `For`, `Switch`, `Match`, and `Dynamic` each have a
  string-mode path and wrap their output in a comment co-range marker
  (`<!--azc:type-->...<!--/azc-->`) the client hydrator adopts. Comments, not a
  `display:contents` wrapper, so control-flow output stays valid inside
  `<table>` / `<select>` / `<ul>`.
- **Suspense** - resources cannot settle during a synchronous render, so the
  fallback is emitted (wrapped in a hydration marker) and the client swaps in the
  resolved children after hydration. There is no streaming/async SSR.

### Escaping and XSS

Text content and attribute values are always escaped (`escapeText` /
`escapeAttr`), including the resolved output of reactive props, `classList`, and
`styleMap`, and the `renderToDocument` `title`/`lang`. Attacker-controlled signal
values therefore cannot break out of an attribute or open a tag.

The deliberate escape hatches, with the same trust model as their client
counterparts, are **not** escaped and must be sanitized by the caller: the
`innerHTML` prop (like `el.innerHTML = x`) and the raw `head` / `bodyAttrs`
options of `renderToDocument`.

### Hydration mismatch

If the server and client trees diverge structurally, `hydrate()` throws a
`HydrationMismatchError`, warns in development, and falls back to a clean client
render, so the app always boots.

## Components

| File | Role |
| --- | --- |
| `render-to-string.ts` | `renderToString` and `renderToStaticMarkup`. |
| `render-to-document.ts` | `renderToDocument` and `RenderToDocumentOptions`. |
| `island.ts` | `island`: mark an interactivity boundary for partial hydration. |


## Examples

Render a document and flush collected styles:

```ts
import { renderToDocument, collectStyleSheet, resetStyleSheet } from '@azerothjs/server';

resetStyleSheet();
const body = renderToDocument(() => App({}), {
    title: 'Home',
    head: `<style>${collectStyleSheet()}</style>`,
    lang: 'en'
});
```

On the client, mount the same component with `hydrate` to adopt this markup:

```ts
import { hydrate } from '@azerothjs/renderer';

hydrate(() => App({}), document.getElementById('app')!);
```

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
