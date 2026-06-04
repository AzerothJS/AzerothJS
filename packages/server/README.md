# @azerothjs/server

## Overview

Server-side rendering. It renders a component tree to an HTML string without a
DOM shim: components run in string render mode and emit HTML directly. The output
carries hydration markers so the client can adopt it with `hydrate()` from
`@azerothjs/renderer`.

```ts
import { renderToDocument } from '@azerothjs/server';

const html = renderToDocument(() => App({}), { title: 'Home' });
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

## Components

| File | Role |
| --- | --- |
| `render-to-string.ts` | `renderToString` and `renderToStaticMarkup`. |
| `render-to-document.ts` | `renderToDocument` and `RenderToDocumentOptions`. |

## Building

```sh
npm run build -w @azerothjs/server
```

## Testing

```sh
npx vitest run test/server
```

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

## Contributing

Keep rendering a pure string emission with no DOM dependency, so it stays usable
in any server runtime. Output that is meant to be hydrated must keep its markers
consistent with the renderer's hydration cursor. Add tests under `test/server`.
