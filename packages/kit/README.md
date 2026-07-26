<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/kit

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fkit?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/kit)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework. This is the assembled car: per-route SSR, static prerendering, and hydration wired over the pieces you already have - the router's route table, the renderer, and `@azerothjs/http`. The kit invents nothing: no new routing system, no new data layer, no config format. It replaces the ~10 lines of hand-wiring every fullstack app used to repeat.

## Install

```sh
npm install @azerothjs/kit
```

## The whole idea

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

## The three calls

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

## Prerendering

```sh
vite build && vite build --ssr src/entry.server.ts --outDir dist-server
azeroth-kit-prerender --entry dist-server/entry.server.js --client dist
```

The bin renders every `render: 'static'` page through your real loaders and writes it into the client dist, preserving the untouched shell as `shell.html` for client pages. A static page that redirects (a guard fired) or carries parameters is a loud build error, not a silent wrong page. The pass is also available programmatically as `prerender()` from `@azerothjs/kit/prerender`.

## What it deliberately is not

- **Not a router.** The table above is `azerothjs`'s own router table - guards, loaders, `lazy:`, typed `defineRoute` handles all work unchanged.
- **Not a data layer.** Route loaders ARE the data story; the kit just carries their results across the wire as the hydration handoff.
- **Not a bundler.** Vite builds both halves; the kit consumes the output.

`npm create azeroth@latest` scaffolds the fullstack template with all of this wired.
