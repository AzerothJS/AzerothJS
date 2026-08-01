<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />

# @azerothjs/kit

**Per-route SSR, static prerendering, hydration, and one-command production builds over the AzerothJS router, renderer, and HTTP server.**

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fkit?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/kit)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

</div>

---

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework. This is the assembled car: per-route SSR, static prerendering, and hydration wired over the pieces you already have - the router's route table, the renderer, and `@azerothjs/http`. The kit invents nothing: no new routing system, no new data layer, no config format. It replaces the ~10 lines of hand-wiring every fullstack app otherwise repeats.

- **Per-route rendering modes** - `server` (SSR per request), `static` (prerendered at build), or `client` (SPA shell), chosen with one field on the route you already declared.
- **Server-correct guards and loaders** - a redirecting guard becomes a real 302, a vetoed route serves the shell with the guard's status, and parallel loaders stream into the hydration handoff.
- **One-command production** - `mountPages` registers pages plus asset fallback on an `@azerothjs/http` app, `azeroth-kit-prerender` writes the static pages, and `bootClient` hydrates or renders in the browser.

---

## 📦 Install

> [!NOTE]
> ESM-only, Node >= 22. `azerothjs` is a required peer:

```sh
npm install @azerothjs/kit azerothjs
```

---

## 💡 The whole idea

Your router's route table is the manifest. Add one optional field per route and the kit does the rest:

```ts
import { defineRoute } from 'azerothjs';
import type { PageRoute } from '@azerothjs/kit';

export const routes: PageRoute[] = [
    { path: '/', component: Home, render: 'static' },       // prerendered at build
    { path: '/guestbook', component: Guestbook },            // SSR per request (the default)
    { path: '/settings', component: Settings, render: 'client' } // SPA shell; browser renders
];
```

- `render: 'server'` - SSR per request. Loader guards become real HTTP 302s, parallel loaders stream into the hydration handoff, the client picks up without refetching. The default when a renderer is provided.
- `render: 'static'` - rendered once at build by `azeroth-kit-prerender`, served as a file.
- `render: 'client'` - the pristine SPA shell; the browser renders. The default with no renderer.

Modes inherit down `children`; a parameterized path (`/users/:id`) can never be a single file, so it SSRs per request.

---

## 🧩 The three calls

**Server entry** (`entry.server.ts`, built with `vite build --ssr`):

```ts
import { createPageRenderer } from '@azerothjs/kit/ssr';
import { App } from './App.azeroth';
import { routes } from './routes.ts';

export { routes };
export const renderPage = createPageRenderer(App, routes);
```

**Client entry** (`main.ts`):

```ts
import { bootClient } from '@azerothjs/kit/client';
import { App } from './App.azeroth';

bootClient(App); // hydrates SSR/static pages, renders client pages - it checks the root
```

**HTTP server**:

```ts
import { App } from '@azerothjs/http';
import { mountPages } from '@azerothjs/kit';
import { renderPage, routes } from '../application/dist-server/entry.server.js';

const app = new App();
// ...your API routes first; they keep priority...
mountPages(app, { routes, clientDir: 'application/dist', renderer: renderPage });
```

That is the entire integration. `mountPages` registers each page in its mode plus asset fallback; register it last.

---

## ⚙️ Prerendering

```sh
vite build && vite build --ssr src/entry.server.ts --outDir dist-server
azeroth-kit-prerender --entry dist-server/entry.server.js --client dist
```

The bin renders every `render: 'static'` page through your real loaders and writes it into the client dist, preserving the untouched shell as `shell.html` for client pages. A static page that redirects (a guard fired) or carries parameters is a loud build error, not a silent wrong page. The pass is also available programmatically as `prerender()` from `@azerothjs/kit/prerender`.

---

## 🚫 What it deliberately is not

- **Not a router.** The table above is `azerothjs`'s own router table - guards, loaders, `lazy:`, typed `defineRoute` handles all work unchanged.
- **Not a data layer.** Route loaders ARE the data story; the kit just carries their results across the wire as the hydration handoff.
- **Not a bundler.** Vite builds both halves; the kit consumes the output.

`npm create azeroth@latest` scaffolds the fullstack template with all of this wired.

---

## 🔗 Related

- [AzerothJS](../../README.md) - the monorepo overview and the full package list.
- [`azerothjs`](../azerothjs) - the framework runtime, router, and renderer (required peer).
- [`@azerothjs/http`](../http) - the web-standard HTTP server `mountPages` registers onto.
- [`@azerothjs/compiler`](../compiler) - the `.azeroth` compiler and Vite plugin that build both halves.

---

<div align="center">
<sub>Part of <a href="../../README.md">AzerothJS</a> · <a href="https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE">MIT License</a></sub>
</div>
