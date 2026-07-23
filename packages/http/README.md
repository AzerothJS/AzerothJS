<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/logo-transparent.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/http

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fhttp?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/http)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained reactive framework. This is the server half: a zero-dependency, web-standard HTTP stack for Node >= 24, written from scratch.

## Install

```sh
npm install @azerothjs/http
```

## Overview

Handlers are `(request: Request, ctx) => Response` on WHATWG types. Node's `http`/`http2`
appear only in edge adapters, which buys three things at once: the same app runs on any
fetch-shaped runtime, `app.handle(new Request(...))` is the entire integration-testing story
(no sockets, no inject shim), and "headers already sent" or double-send are unrepresentable -
a handler returns exactly one `Response`.

```ts
import { App, json, readJson, serve } from '@azerothjs/http';

const app = new App();

app.get('/users/:id', (request, ctx) => json({ id: ctx.params.id })); // ctx.params typed from the pattern

app.post('/users', async (request) =>
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

## Development

There is no build step in the dev loop. Node >= 24 runs TypeScript directly, so
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

## What is in the box

- **Radix router** - no regex, O(segments), route conflicts FAIL BOOT with a printable
  table; 405 + `Allow` distinguished from 404; params typed from the pattern string.
- **One error path** - every throw (sync or async) becomes a stable wire shape
  `{ error: { code, message, details? } }`; 4xx messages cross the wire, 5xx internals stay
  home; `ValidationError.details.fields` is the exact map `@azerothjs/form`'s `setError`
  consumes. Speak your own envelope with `new App({ serializeError })` - one place to reshape
  the body (route-miss 404s included), the same guarantees.
- **Bodies with limits on by default** - JSON, urlencoded, raw, and a from-scratch
  multipart/form-data parser (byte-exact, capped on three axes).
- **A request is a reactive root** - `createStore` state is request-isolated across
  `await` (the same isolation SSR renders have), and `onRequestCleanup` teardown ALWAYS
  runs: success, throw, or client disconnect. The disconnect `AbortSignal` rides on
  `request.signal`.
- **Typed middleware** - `app.use()` accumulates context in the type system; a `Response`
  return short-circuits (guards); ordering is lexical; no `next()`. `app.with(mw)` scopes a
  middleware to just the routes registered through it - `app.with(requireAuth).get(...)` - so
  auth/throttle live at registration, not as a repeated guard call inside every handler.
- **Server-Sent Events** - `sse()` produces exactly what the frontend `stream` keyword
  (`createStream({ parse: 'sse' })`) consumes: framed events, comment heartbeats, `[DONE]`.
- **The rest of a real server** - cookies (loud `__Host-`/SameSite validation), static
  files (traversal-safe, etags, 304s), negotiated compression (br/gzip/deflate, event
  streams exempt), typed env config that reports every problem in ONE boot error,
  structured logging as an interface, graceful shutdown, HTTP/1.1 + h2c adapters.

## Production hardening

Cross-cutting response concerns wrap the whole app as composable EDGE middleware - a
`(next) => next` decorator that returns new `Response` values, never mutating a channel.
`pipeline()` composes them into a `WebHandler` you hand straight to `serve()`:

```ts
import {
    App, serve, pipeline, requestId, securityHeaders, cors, rateLimit, handleShutdownSignals
} from '@azerothjs/http';

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
is the seam for a Redis-backed limiter across a fleet.

For a full deployment: `timeouts` also takes `requestMs` (whole-request bound for slow bodies)
and `checkIntervalMs` (how promptly a slow connection is reclaimed); `new App({ observe:
logRequests(createLogger()) })` emits one JSON log line per request with method, path, status,
duration, and the request id; expose a cheap `GET /healthz` returning 200 for orchestrator
probes; and enable HSTS via `securityHeaders({ hsts })` only when TLS terminates in front - it
is emitted only over a connection proven secure.

## The QUERY method (RFC 10008)

For a read whose parameters are too large or too structured for a URL - a complex filter, a
search document - a query string does not fit and a POST wrongly signals a state change. The
QUERY method is the answer: SAFE and IDEMPOTENT like GET, but with a request body like POST,
so responses can be cached and requests retried.

```ts
import { readJson, queryResult } from '@azerothjs/http';

app.query('/products/search', async (request) =>
{
    const filter = await readJson(request); // Content-Type is enforced; a missing one is a 415
    const results = await search(filter);    // MUST NOT mutate state - that is what makes QUERY safe
    return queryResult({ results }, { contentLocation: '/products/search/results/abc' });
});
```

The radix router treats QUERY like any method: it appears in the `Allow` header of a 405, and a
handler MUST NOT mutate state. In a typed contract it is a first-class method whose `input` is the
query body:

```ts
search: route({ method: 'QUERY', path: '/products/search', input: FilterSchema, output: ResultsSchema })
```

QUERY is new, so some intermediaries (older proxies, CDNs, browsers) may not pass it yet - verify
the path end to end for your deployment. On Node's own `fetch`/`Request` it works today, both as a
client and a server.

## Performance

Benchmarked against express, fastify, and hono on identical, correctness-verified
scenarios: decisively ahead of Express everywhere, within a few percent of Fastify on
trivial GETs, and AHEAD of Fastify on JSON echo - with the request root ON.

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
