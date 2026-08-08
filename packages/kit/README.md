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
- `render: 'stream'` - streaming SSR: the shell flushes immediately and each `<Suspense>` boundary follows as it settles.
- `render: 'client'` - the pristine SPA shell; the browser renders. The default with no renderer.

Modes inherit down `children`. A parameterized path (`/users/:id`) needs `staticParams` to be
`'static'` - that enumerates which param sets get prerendered, and any value it does not list
falls through to a live render. Without `staticParams` a parameterized static route is a build
error, because one pattern cannot become one file.

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

The bin renders every `render: 'static'` page through your real loaders and writes it into the client dist, preserving the untouched shell as `shell.html` for client pages. A static page that redirects (a guard fired) is a loud build error, not a silent wrong page, and so is a parameterized static route with no `staticParams` to enumerate - one pattern cannot become one file. A failed build rolls back every file it had already written, so a partial site is never published. The pass is also available programmatically as `prerender()` from `@azerothjs/kit/prerender`.

---

## 🧮 Enumerated static routes - `staticParams`

A parameterized route prerenders by enumerating its param sets; anything the enumeration
did not list falls through to live SSR at request time:

```ts
{
    path: '/blog/:slug', component: Post, render: 'static',
    staticParams: () => Promise.resolve([{ slug: 'hello' }, { slug: 'world' }])
}
```

The route table ships to the browser, so keep the closure browser-safe: inline data, or a
dynamic import the client bundle never follows eagerly. Invalid param values (empty, `/`,
dot segments) fail the BUILD, never become a path.

## ♻️ ISR - `revalidate`

A static page with `revalidate` serves from a page cache: fresh within the window, past it
the stale copy answers instantly while exactly ONE background render replaces it. Build
output seeds the cache through file mtimes; every failure keeps the old copy, and an
outcome that stopped being static content (a redirect, a veto, a 404) drops the entry so
a guard is never masked.

```ts
{ path: '/', component: Home, render: 'static', revalidate: 300 }
```

Responses carry `age` and `x-azeroth-cache: hit | stale | miss`. The cache is pluggable
(`KitOptions.cache`): `MemoryPageCache` by default, `FilePageCache` to survive restarts,
or your own `PageCache`. Background failures surface through `KitOptions.onError`.

`MemoryPageCache` is **process-local**, which is the right default for one instance and the
wrong one for several: behind a load balancer each instance keeps its own copy, so a page can
be fresh on one and stale on another, and `revalidate` regenerates once per instance rather
than once per deployment. `FilePageCache` fixes that only for instances sharing a filesystem.
Across machines, supply a `PageCache` backed by whatever store they already share.

### The query string is part of the key

`/search?q=shoes` and `/search?q=hats` are different pages and get different entries. Parameter
ORDER is not: `?a=1&b=2` and `?b=2&a=1` normalise to one entry. The renderer still receives the
URL exactly as requested, so `useSearch()` reads what the visitor actually sent.

This makes cache cardinality a function of your traffic, not your route table - and campaign
tags (`?utm_source=...`) each cost a render and an entry. Both shipped caches are bounded
(`maxEntries`, default 1000; `FilePageCache` evicts oldest-first by mtime), so the ceiling is
memory- and disk-safe, but a route that must ignore tracking parameters should strip them in a
middleware before the kit sees the request. Only a request with NO query can be seeded from the
prerendered file on disk, because that file was rendered without one.

The key is built from the path **as sent**, never a percent-decoded copy of it. That matters for
any route whose parameter can carry a delimiter: `/article/a%3Fb` is a slug containing `?`, and
decoding before keying would make it collide with `/article/a?b`, a different page entirely. The
cost is that two spellings of the same page (`/tag/caf%C3%A9` and `/tag/café`) occupy two entries
rather than one. That is a duplicate, never a wrong page, and the entry cap bounds it.

### A deploy makes a shared cache go cold

Every entry is stamped with a **build identity** - the client shell's content hash - and an entry
from a different build is treated as stale, because its HTML references content-hashed assets the
new build deleted. That is the correct call for correctness, and it has an operational
consequence worth planning for: during a rolling deploy, instances on the new build reject every
entry the old build wrote, so a shared `FilePageCache` (or your own `PageCache`) goes **fully
cold** and every cached page regenerates once. Size the origin for that spike, or warm the cache
after a deploy.

The same mechanism means two applications pointed at one cache directory cannot serve each
other's HTML - their shells hash differently, so each rejects the other's entries. They will,
however, evict each other under the entry cap, so give each app its own directory.

## 🌊 Streaming SSR - `render: 'stream'`

The shell (loader handoff included) flushes before slow data resolves; each pending
`<Suspense>` boundary streams its settled children as an out-of-order chunk that swaps in
and hydrates without refetching. Redirects, guard vetoes, and HEAD stay buffered - they
resolve before any byte exists.

```ts
{ path: '/dashboard', component: Dashboard, render: 'stream' }
```

## 🔒 Under a strict Content-Security-Policy - `scriptNonce`

A page emits two kinds of inline tag: the swap-runtime scripts a streamed page needs, and the
scoped-CSS `<style>` a server-rendered page carries. Both are refused by a policy without
`'unsafe-inline'`, so pass the request's nonce and name it in **both** directives:

```ts
mountPages(app, { routes, clientDir, renderer, scriptNonce: (context) => nonceFor(context) });
```

```
default-src 'self'; script-src 'self' 'nonce-<N>'; style-src 'self' 'nonce-<N>'
```

Listing the nonce only under `script-src` is the trap: `style-src` then falls back to
`default-src`, the stylesheet is refused, and the page paints unstyled while looking correct in
the DOM. Getting the script side wrong is louder - every `<Suspense>` boundary sits on its
fallback until hydration refetches, and the streamed bytes are wasted.

`css()` on the client does not need a nonce: it adds a constructable stylesheet, which CSP does
not govern.

## 🖼️ The image endpoint - `/_image`

`KitOptions.images: true` serves `<Image optimize>`'s URLs over the client dist:
content-hash cache keys, a year of immutable caching, ETag revalidation, and the same
path containment static serving uses. The framework ships NO codec: without an adapter
the endpoint is a caching passthrough of original bytes; implement `ImageAdapter` (one
`transform` method) with whatever you trust to add resizing and AVIF/WebP negotiation.
A throwing adapter degrades to original bytes - never a blank image. One consequence
worth knowing before writing an adapter: real browsers always advertise `image/avif`, so
with an adapter present the endpoint always negotiates a format - an adapter that THROWS
on formats it cannot encode therefore falls back to the original bytes on every browser
request, resize included. Produce what you can instead and say so through `contentType`
(the adapter controls it for exactly this reason): a resized PNG answered to a webp ask
is correct, cache-keyed separately, and keeps the resize win. Replacing an image
in place keeps its URL, so browsers may cache the old bytes for up to a year; rename the
file (hashed builds do) or lower `cacheControl` when images mutate.

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
