<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />

# @azerothjs/http

**AzerothJS server kernel - web-standard Request/Response HTTP stack (no third-party dependencies) where every request is a reactive root**

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fhttp?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/http)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

</div>

---

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework. This is the server half: a web-standard HTTP stack for Node >= 22, written from scratch with no third-party dependencies (it builds only on sibling `@azerothjs/*` packages - the reactive request root, schema validation, and the logger).

---

## 📦 Install

> [!NOTE]
> ESM-only, Node >= 22. `azerothjs` is a REQUIRED peer: the kernel wires per-request
> reactive-root isolation into the `azerothjs` runtime, and both halves must share one copy of
> it, so it is installed alongside rather than bundled.

```sh
npm install @azerothjs/http azerothjs
```

---

## 📖 Overview

Handlers are `(context) => Response` on WHATWG types - one context carries the request, params, URL, and middleware additions. Node's `http`/`http2`
appear only in edge adapters, which buys three things at once: the same app serves on any
fetch-shaped runtime through [`toFetchHandler`](#-other-runtimes---bun-deno-workers-vercel-edge),
`app.handle(new Request(...))` is the entire integration-testing story
(no sockets, no inject shim), and "headers already sent" or double-send are unrepresentable -
a handler returns exactly one `Response`.

> `app.handle` itself returns the kernel's fast internal response, not a host-constructed
> `Response`. It is the right thing to call in a test; a non-Node runtime needs
> `toFetchHandler(app)`, which is one line. See the runtimes section below.

```ts
import { App, json, readJson } from '@azerothjs/http';
import { serve } from '@azerothjs/http/node';

const app = new App();

// One `context` per handler: the request, the params (typed from the pattern), the
// URL, and whatever middleware added. Return a Response - never mutate an argument.
app.get('/users/:id', (context) => json({ id: context.params.id }));

app.post('/users', async ({ request }) =>
{
    const body = await readJson<{ name: string }>(request); // limits ON; bad input -> 400/413/415
    return json({ created: body.name }, { status: 201 });
});

const served = await serve(app, { port: 3000 });
// served.shutdown(): graceful - drain in-flight responses, then close.
```

Scaffold a complete runnable server like this - a custom error envelope, a scoped `with`
guard, and graceful shutdown, in one file with no build step - with
`npm create azeroth@latest` (the backend template).

---

## 🛠️ Development

There is no build step in the dev loop. Node >= 22 runs TypeScript directly, so
the whole story is one command:

```sh
node --watch src/main.ts   # runs the server, restarts on any change it imports
```

Wire it as your `dev` script and that is the entire setup - no bundler, no
`tsc -w` in a second terminal. The dev *run* pulls in nothing; the only dev
dependencies are the two the type-check gate needs (`typescript` for `tsc`, and
`@types/node` so `tsc` can resolve the `node:http` types this package's adapters
reference):

```jsonc
// package.json
{
    "type": "module",
    "scripts": {
        "dev": "node --watch src/main.ts",
        "start": "node src/main.ts",
        "typecheck": "tsc --noEmit"
    },
    "devDependencies": {
        "typescript": "^5.7.0",
        "@types/node": "^24.0.0"
    }
}
```

Node's native TypeScript is *strip-only*: it erases types and runs, it does not
check them. So type errors never block `node --watch` (you keep moving), and
`tsc --noEmit` stays a separate gate you run in CI or on save. A minimal
`tsconfig.json` for that gate, matching the `.ts` import extensions Node wants -
`types: ["node"]` is what silences the `Cannot find name 'node:http'` errors from
the adapter typings:

```jsonc
{
    "compilerOptions": {
        "module": "nodenext",
        "moduleResolution": "nodenext",
        "allowImportingTsExtensions": true,
        "noEmit": true,
        "strict": true,
        "types": ["node"]
    }
}
```

Relative imports carry the `.ts` extension (`import { x } from './x.ts'`) - that
is what Node resolves at runtime, and the tsconfig above lets `tsc` accept it too.

**When you do need a build step:** only if something in your stack relies on
`emitDecoratorMetadata` - a decorator-driven ORM (TypeORM, etc.) reads type
metadata that strip-only execution does not emit. Then compile with `tsc` and run
`node --watch dist/main.js`. A plain `@azerothjs/http` app needs none of that.

---

## 🧩 The typed API layer - `@azerothjs/http/api`

The typed API system lives in this package as the `./api` subpath: declare each
feature once with `feature()` - routes, schemas, guards, handlers, docs, colocated,
with `routes.form`/`routes.raw`/`routes.stream` making uploads, webhooks and SSE first-class -
`register` it (boundary validation, the typed reply channel), export OpenAPI from
the same declaration, and consume it in the browser through the fully inferred
client at `@azerothjs/http/api/shared` (`typeof` the server's features plus a
two-fields-per-route manifest; client-safe: it never drags server code into a
bundle). The full guide: [docs/api.md](./docs/api.md).

---

## 🧰 What is in the box

- **Radix router** - no regex, O(segments), route conflicts FAIL BOOT with a printable
  table; 405 + `Allow` distinguished from 404; params typed from the pattern string.
- **One error path** - every throw (sync or async) becomes a stable wire shape
  `{ error: { code, message, details? } }`; 4xx messages cross the wire, 5xx internals stay
  home; `ValidationError.details.fields` is the exact map `azerothjs`'s form `setError`
  consumes. Speak your own envelope with `new App({ serializeError })` - one place to reshape
  the body (route-miss 404s included), the same guarantees.
- **Bodies with limits on by default** - JSON, urlencoded, raw, and a from-scratch
  multipart/form-data parser (byte-exact, capped on three axes). Uploads beyond memory
  use the pull-based twin: `streamMultipart(request)` iterates parts as they arrive,
  each file payload a ReadableStream piped straight to its sink (disk, object storage).
- **A request is a reactive root** - `createStore` state is request-isolated across
  `await` (the same isolation SSR renders have), and `onRequestCleanup` teardown ALWAYS
  runs: success, throw, or client disconnect. The disconnect `AbortSignal` rides on
  `request.signal`.
- **Typed middleware** - a middleware takes the same `context` and RETURNS its additions
  (an object merged flat onto the context downstream), a `Response` to short-circuit
  (guards), or nothing; ordering is lexical; no `next()`. `app.use()` accumulates the
  additions in the type system; `app.with(mw)` scopes a middleware to just the routes
  registered through it - `app.with(requireAuth).get(...)` - so auth/throttle live at
  registration, not as a repeated guard call inside every handler.
- **Server-Sent Events** - `sse()` produces exactly what the frontend `stream` keyword
  (`createStream({ parse: 'sse' })`) consumes: framed events, comment heartbeats, `[DONE]`.
- **The rest of a real server** - cookies (loud `__Host-`/SameSite validation), static
  files (traversal-safe, etags, 304s, single-range `Range`/`If-Range` 206s for media
  seeking and download resume), negotiated compression (br/gzip/deflate, event streams
  and partial responses exempt), typed env config that reports every problem in ONE boot error,
  structured logging as an interface, graceful shutdown, HTTP/1.1 + h2c adapters.

---

## 🌐 Other runtimes - Bun, Deno, Workers, Vercel Edge

The `.` entry is a pure fetch-standard kernel (one sanctioned `node:` import, the
AsyncLocalStorage request-root seam, which Bun, Deno and workerd all implement). To serve on a
runtime other than Node, hand its own primitive a `toFetchHandler`:

```ts
import { App, json, toFetchHandler } from '@azerothjs/http';

const app = new App();
app.get('/healthz', () => json({ ok: true }));

Bun.serve({ fetch: toFetchHandler(app) });
Deno.serve(toFetchHandler(app));
export default { fetch: toFetchHandler(app) };   // Cloudflare Workers, Vercel Edge
```

`toFetchHandler` is required, not decoration. `app.handle` returns the kernel's
`PayloadResponse` - a measured optimisation that satisfies `instanceof Response` but is not
built by the host realm's constructor, which `Bun.serve` and `Deno.serve` both reject. The
adapter materialises kernel responses at that one boundary and forwards an already-native
response (a stream, an `sse()` body) untouched. Node's `serve()` never calls it.

One caveat worth knowing before you deploy: `rateLimit` keys on the client IP, and only the
Node adapter can expose a socket address. On any other runtime it refuses loudly rather than
silently sharing one global bucket, so give it the key that runtime does provide:

```ts
Bun.serve({ fetch: (request, server) => toFetchHandler(
    pipeline(app, rateLimit({ limit: 100, windowMs: 60_000, key: () => server.requestIP(request)?.address ?? 'unknown' }))
)(request) });
```

Verified by `runtime-compat.spec.ts`, which boots real Bun and Deno servers over real sockets.

---

## 🛡️ Production hardening

Cross-cutting response concerns wrap the whole app as composable EDGE middleware - a
`(next) => next` decorator that returns new `Response` values, never mutating a channel.
`pipeline()` composes them into a `WebHandler` you hand straight to `serve()`:

```ts
import { App, pipeline, requestId, securityHeaders, cors, rateLimit } from '@azerothjs/http';
import { serve, handleShutdownSignals } from '@azerothjs/http/node';

const app = new App();
// ... routes ...

const handler = pipeline(
    app,
    requestId(),                                          // honor/mint X-Request-Id; rides into the logger
    securityHeaders(),                                    // nosniff, frame-options, referrer-policy, ... (opt-in HSTS/CSP)
    cors({ origin: ['https://app.example'], credentials: true }),
    rateLimit({ limit: 100, windowMs: 60_000 })          // 429 + Retry-After + RateLimit-* headers
);

const served = await serve(handler, {
    port: 3000,
    timeouts: { headersMs: 15_000, keepAliveMs: 5_000 }  // slowloris + idle bounds, all overridable
});
handleShutdownSignals(served);                            // SIGTERM/SIGINT -> drain in-flight, then exit
```

Every piece is opt-in and tested through `app.handle(new Request(...))` - no socket required.
`clientIp(request, { trustProxy })` resolves the real address through an explicit trusted-proxy
boundary (the `X-Forwarded-For` spoofing footgun, closed), and `rateLimit`'s `RateStore` interface
is the seam for a Redis-backed limiter across a fleet. The same boundary covers the URL:
`serve(app, { trustProxy: true })` (or `{ proto: true }` / `{ host: true }` granularly) believes
`X-Forwarded-Proto`/`-Host` from a declared terminating proxy, so `context.url` carries the
client's real scheme and host - redirects, absolute links, and secure-cookie decisions stop
seeing the internal hop. Off by default: without a proxy those headers are caller-forgeable.

One rule matters more than the rest when you write a policy check by hand: decide on
`context.path`, not `context.url.pathname`. The router matches decoded, slash-collapsed segments,
so `/%61dmin`, `//admin` and `/admin//` are all the route `/admin`, while `url.pathname` keeps the
client's spelling. `context.path` is the path the router actually matched, which is what an auth
prefix check, a CSRF exemption list, a rate-limit bucket, and an audit line all need in order to
agree with the route that ran. Behind a proxy also declare `trustProxy`/`trustedHops` on
`rateLimit`, or its default key is the proxy's address and every client on earth shares one
bucket; on a fetch-hosted runtime there is no socket at all, so give the limiter an explicit
`key`.

For a full deployment: `timeouts` also takes `requestMs` (whole-request bound for slow bodies)
and `checkIntervalMs` (how promptly a slow connection is reclaimed); `new App({ observe:
logRequests(createLogger()) })` - the logger is `@azerothjs/logger`'s - emits one JSON log line
per request with method, path, status,
duration, and the request id; expose a cheap `GET /healthz` returning 200 for orchestrator
probes; and enable HSTS via `securityHeaders({ hsts })` only when TLS terminates in front - it
is emitted only over a connection proven secure.

---

## 🎬 Server actions

A server action is a POST-only, param-free route kind whose typed client surface is a
directly-callable function. The wire behavior is exactly a JSON route - input validated
into the 422 field map, output checked against the contract, guards composing through the
ordinary chain - but the call site reads like the function it is:

```ts
// server
export const api = {
    posts: feature('/posts', (routes) => ({
        create: routes.with(csrfProtect(csrf)).action('/create',
            { input: postInput, output: post },
            ({ input }) => db.posts.create(input))
    }))
};

// client - typed end to end from `typeof api`, zero server code in the bundle
const created = await client.posts.create({ title: 'hello' });
```

A declared `Date` arrives client-side as its ISO string, and the call's return type says
so (`Wire<T>`). Validation failures land on a form with one call:

```ts
catch (error)
{
    if (!applyFieldErrors(form, error))
    {
        form.setError('title', 'Could not reach the server - try again.');
    }
}
```

## 🔐 CSRF

Browser-facing mutations pair `csrfCookie` (edge middleware minting a READABLE token
cookie - readability is the point of double submit) with `csrfProtect` (a guard checking
Sec-Fetch-Site/Origin plus the mirrored `x-azeroth-csrf` header). The typed client mirrors
the cookie automatically on action calls. Non-browser callers hold no ambient cookies, so
they mint their own pair or use token auth without the guard:

```ts
const csrf: CsrfOptions = {};                       // { secure: false } for plain-http dev
const handler = pipeline(app, requestId(), securityHeaders(), csrfCookie(csrf));
// then guard any mutating route: feature('/x', [csrfProtect(csrf)], ...) or routes.with(...)
```

The decision rules, spelled out because "checks the Origin" leaves the interesting cases open:

| Request | Outcome |
| --- | --- |
| `Sec-Fetch-Site: same-origin` or `none`, token matches | allowed |
| `Sec-Fetch-Site: cross-site` or `same-site` | refused - `same-site` is a SIBLING subdomain, not this origin |
| `Origin` present and not this origin | refused, however the token looks |
| `Origin` absent, `Sec-Fetch-Site` absent, token matches | allowed - the non-browser lane |
| token missing, empty, short, or off by one character | refused |
| cookie present, header absent (or the reverse) | refused |

Safe methods (GET/HEAD/OPTIONS) skip the guard entirely, so a mutation must never live behind
one. `allowedOrigins` re-admits a named cross-origin caller; nothing else does.

## 🌊 Streaming and response-wrapping middleware

Edge middleware can turn a streaming response into a buffered one, and **nothing on the wire
says so**. A wrapper that reads the body and rebuilds still answers `transfer-encoding: chunked`
with no `content-length`, and `response.body` is still a `ReadableStream` - so neither the
client nor the application can tell. Only time-to-first-byte moves, measured here on a route
whose last chunk is 400 ms late:

| middleware shape | TTFB | streaming? |
|---|---|---|
| no middleware | 22 ms | yes |
| headers only (`requestId`, `securityHeaders`, `csrfCookie`) | 2 ms | yes |
| `response.clone()`, clone unread | 4 ms | yes |
| `response.clone()`, clone fully read | 2 ms | yes |
| `compressResponse` | 2 ms to first DECODABLE content | yes, but see below |
| `await response.text()` then rebuild | **407 ms** | **no** |
| `await response.arrayBuffer()` then rebuild | **404 ms** | **no** |

The rule is simply: **reading the body buffers it; everything else does not.** `text()`,
`arrayBuffer()`, `json()` and `blob()` must have the whole body before they resolve, so every
byte then waits for the slowest chunk - a ~200x TTFB regression on the measurement above.

**Compression is measured at the decoder, not the socket.** `compressResponse` pipes rather than
collects, so raw bytes leave early - but the compressor holds them in its window, and what
matters is when the client can DECODE the shell. Measured against a route holding its last chunk
for 300 ms, with no per-chunk flush: brotli produced no decodable content before the hold at any
size from 3 KB to 256 KB, and gzip only when the shell was both large and incompressible. The
shell reached the socket in 2 ms and painted at 300 ms, and no header said so. `compressResponse`
therefore flushes per chunk on a streamed response (one with no `content-length`), which puts
first decodable content at 1-14 ms across every size and both encodings. The flush costs about
9-20% of encoded size on real page HTML - roughly 80-110 bytes a page - and buffered responses
keep the tighter encoding, since they have nothing to gain.

`clone()` is the useful surprise: it tees, so an audit or logging sink can read a complete copy
without costing the client its first byte. Prefer it whenever you need to observe a body.

To transform streamed HTML, transform it INSIDE the render rather than around the response, or
skip the routes that stream. `@azerothjs/kit` marks a `render: 'stream'` response with
`x-accel-buffering: no` (its purpose is telling nginx not to buffer, and it doubles as the
signal that reading this body would defeat the point):

```ts
const brand = (next) => ({
    handle: async (request) =>
    {
        const response = await next.handle(request);
        // A streamed page is exactly the one you must not read here.
        if (response.headers.get('x-accel-buffering') === 'no')
        {
            return response;
        }
        return new Response((await response.text()).replace('%TITLE%', title), response);
    }
});
```

The behaviour is pinned in `tests/streaming-middleware-contract.spec.ts`, including the case
proving a buffered response is indistinguishable by inspection.

## 🔎 The QUERY method (RFC 10008)

> [!IMPORTANT]
> **Experimental.** RFC 10008 is not yet deployed internet reality - proxies, caches,
> and tooling may not recognize QUERY. The API is stable within 1.x but flagged until
> the RFC lands broadly.

For a read whose parameters are too large or too structured for a URL - a complex filter, a
search document - a query string does not fit and a POST wrongly signals a state change. The
QUERY method is the answer: SAFE and IDEMPOTENT like GET, but with a request body like POST,
so responses can be cached and requests retried.

```ts
import { readJson, json } from '@azerothjs/http';

app.query('/products/search', async ({ request }) =>
{
    const filter = await readJson(request); // Content-Type is enforced; a missing one is a 415
    const results = await search(filter);    // MUST NOT mutate state - that is what makes QUERY safe
    return json({ results }, { headers: { 'content-location': '/products/search/results/abc' } });
});
```

The radix router treats QUERY like any method: it appears in the `Allow` header of a 405, and a
handler MUST NOT mutate state. In a typed contract it is a first-class method whose `input` is the
query body:

```ts
search: query('/products/search', { input: FilterSchema, output: ResultsSchema })
```

QUERY is new, so some intermediaries (older proxies, CDNs, browsers) may not pass it yet - verify
the path end to end for your deployment. On Node's own `fetch`/`Request` it works today, both as a
client and a server.

---

## ⚡ Performance

The hot path is built to stay allocation-light: the request and response are lazy shims over
the Node objects, so headers and body are read on demand rather than eagerly copied, and the
per-request reactive root is a scope entry, not a fresh runtime. That isolation is ON in the
serving path - it is a property of the architecture, not a mode you trade away for speed.

---

## 🔗 Related

The server half of the [AzerothJS](../../README.md) monorepo. Related packages:
[`azerothjs`](../azerothjs) (the reactive runtime this kernel shares as a peer),
[`@azerothjs/ws`](../ws) (WebSockets), [`@azerothjs/cron`](../cron) (scheduling), and
[`@azerothjs/logger`](../logger) (logging).

---

<div align="center">
<sub>Part of <a href="../../README.md">AzerothJS</a> · <a href="https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE">MIT License</a></sub>
</div>
