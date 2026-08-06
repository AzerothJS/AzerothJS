<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/http / api

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fhttp?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/http)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework. The typed API between a server and its clients: declare each feature once - routes, schemas, guards, handlers, colocated - and three consumers read the same declaration: the server registration, a fully inferred client, and the OpenAPI document. No codegen, no drift, and the route name written exactly once.

## Install

```sh
npm install @azerothjs/http
```

## One declaration, three consumers

```ts
// server - the WHOLE feature in one place
import { feature, guard, register } from '@azerothjs/http/api';
import { object, string, number, array } from '@azerothjs/schema';

const requireAuth = guard((context) =>
{
    const account = verify(context.request);
    return account === null ? new Response(null, { status: 401 }) : { accountId: account.id };
});

export const api = {
    keys: feature('/keys', [requireAuth], (routes) => ({
        list:   routes.get('/', { output: array(keyRecord) }, (context) => listKeys(context.accountId)),
        create: routes.post('/', { input: keyInput, output: keyRecord }, (context) => mint(context.accountId, context.input)),
        revoke: routes.del('/:keyId', {}, (context) => revoke(context.params.keyId))
    }))
};

register(app, api);   // boundary validation in; 422s carry the form-compatible field map
```

A route is `routes.<verb>(path, spec, handler)` - the verb names the method, the spec carries the
schemas and docs, and the handler sits right beside what it implements. `context.input` and
`context.query` are exactly their schemas' types or the request never reaches the handler;
`context.accountId` is there, typed, because the guard chain put it there. The bodyless verbs
have no `input` field at all - `routes.get('/x', { input }, ...)` does not compile.

The builder callback is not a style choice: a plain object literal cannot infer a feature
guard's additions, because each route value would be constructed before the feature exists.
The chain is in scope when the route is declared - that is what the callback provides.

The record key is the call path: `keys.create` above is `client.keys.create(...)` below, the
OpenAPI tag, and the operation id prefix - written once.

```ts
// browser
import { createClient, readManifest, type Manifest } from '@azerothjs/http/api/shared';
import type { api } from '../server/app.ts';   // TYPE-ONLY - erased at build

// Embedded by the server when the page was rendered; the fetch is the fallback for a
// page that carries no handoff (vite dev, a prerendered file).
const manifest: Manifest = readManifest()
    ?? await fetch('/api/_manifest').then((response) => response.json()).catch(() => ({}));
const client = createClient<typeof api>(manifest, { baseUrl: '/api' });

const key = await client.keys.create({ input: { label: 'ci' } });   // fully inferred
```

### Features that close over runtime state

A feature factory is the everyday shape once handlers touch a store - and then there is no
module-level `api` value to `typeof`. Hand-write the record type from the factories and
surface what `register` returned:

```ts
export function commentsFeature(store: Store) { return feature('/comments', [viewer], (routes) => ({ ... })); }

export type Api = {
    comments: ReturnType<typeof commentsFeature>;
    pages: ReturnType<typeof pagesFeature>;
};
// inside buildApp: const api = register(app, { comments: commentsFeature(store), ... });
```

Use a `type` alias, not an `interface`: `manifestOf` and `createClient` constrain to
`Record<string, Feature>`, and an interface has no implicit index signature to satisfy it.

## The manifest: types erase, two fields per route do not

The client needs two things: the TYPE of the server's features (`typeof api` - a type-only
import, erased at build, so no handler, store, or driver can reach a browser bundle) and each
route's method + path at runtime. The second is the **manifest**: `manifestOf(api)` projects it
from the same declaration `register` installed - a plain JSON value, no schemas, no handlers, a
few hundred bytes. It is a projection of the first source of truth, never a second one, and it
reaches the browser two ways:

- **Embedded** (the fast path): a server-rendered page carries it as an inert JSON script tag -
  `mountPages(app, { ..., manifest: manifestOf(api) })` splices it into every served page, and
  the client reads it back synchronously with `readManifest()` from `@azerothjs/http/api/shared`.
  No network round trip on the hydration path. Non-kit servers can splice `manifestScript(...)`
  into their own HTML.
- **Served** (the fallback): `app.get('/api/_manifest', () => json(manifestOf(api)))` plus one
  fetch at boot - the path a plain vite dev page or a prerendered file takes:
  `readManifest() ?? await fetch('/api/_manifest')...`.

A client built over an empty or stale manifest (the server was unreachable at boot and the
fetch degraded to `{}`) fails each call at its own site with an error naming the cause - pages
still render; no call ever dies as a bare property-of-undefined TypeError.

Non-JSON routes carry a `kind` marker in the manifest: the typed client filters them from its
surface at the type level and refuses them loudly at runtime - a browser posts `FormData` or
opens an `EventSource` directly.

## Guards: the chain is at the feature, and only one word can drop it

A guard reads the context and returns an object to ADD to it (typed - the additions flow into
every handler behind it), a `Response` to short-circuit, or nothing. Any plain
`(context) => void | Response` middleware is a guard; `guard()` is only needed when the
addition has to be inferred.

```ts
feature('/account', [requireAuth], (routes) => ({
    me:      routes.get('/me', { output: profile }, (context) => load(context.accountId)),
    // routes.with ADDS to the chain: requireAuth still runs, then the throttle. Chains, too -
    // `.with(a).with(b)` runs the feature chain, then a, then b:
    rotate:  routes.with(throttle(10, 60_000)).post('/key', { input: keyInput }, rotateHandler),
    // routes.only REPLACES the chain - the ONLY way a route loses inherited protection:
    signIn:  routes.only(throttle(10, 60_000)).post('/session', { input: keyInput }, signInHandler),
    // routes.only() with no arguments is the deliberate opt-out - unguarded inside a guarded feature:
    health:  routes.only().get('/healthz', {}, () => ({ ok: true }))
}))
```

The asymmetry is the point. Adding a rate limit is the common edit and it cannot cost you an
authentication check; dropping the feature's protection is the rare one and it has its own
name, so `grep -rn 'routes.only'` is the complete inventory of every place a feature's
guarantee stops. Each declaration is stamped with its complete chain as it is written, so a
route's real guards are readable at the route and never re-derived later.

A guard whose every path attaches types its additions exactly; a guard with a conditional bare
`return` (the everyday optional-session guard) types them OPTIONAL, because on the anonymous
path nothing was assigned - the compiler makes the handler narrow, which is the runtime truth.

A guard's additions are merged the same way the kernel merges middleware additions: own keys
only, and never `request`, `params` or `url` - a guard that returns parsed request data cannot
replace the path params a handler authorises on.

## Four route kinds, all inside the system

| Kind | Builder | What it is |
| --- | --- | --- |
| JSON | `r.get` / `r.post` / `r.put` / `r.patch` / `r.del` / `r.query` / `r.method` | Validated input/query in, validated JSON out - the typed-client routes. |
| Form | `routes.form(path, { fields, limit, maxParts, maxFileSize }, handler)` | multipart/form-data: text fields validated like a JSON body (same 422 map), files buffered within declared caps; a JSON body posted to it is a 415. |
| Raw | `routes.raw(method, path, spec, handler)` | The handler owns the whole exchange and returns a `Response`: uploads beyond form scale (`streamMultipart`), webhooks verifying raw bytes, downloads, `conditional()` 304s. |
| Stream | `routes.stream(path, spec, open)` | Server-Sent Events; `open` receives the guarded context and the live connection. |

The last three exist so those routes stay INSIDE the feature: they inherit its guard chain and
appear in the manifest and the OpenAPI document, instead of degrading to hand-mounted
`app.get` calls that re-implement authorization and vanish from the spec. An unauthenticated
request to the SSE route is refused by the SAME guard the JSON routes use.

## The enforcement points

- **Input and query** validate at the boundary; a failure is the 422 whose `details.fields` is
  the flat field-path map the browser form's `setError` consumes. One schema, both sides: the
  same rules that validated the form reject the forged request, in the same shape.
- **Output** validates too, when declared - and STRIPS undeclared fields, so an accidental
  `passwordHash` dies at the boundary. A handler returning off-declaration data is a hidden
  500 (`contract-violation`), never a silently wrong payload.
- **A raw `Response`** returned from any handler passes through untouched - the visible escape
  hatch.

## Status codes without losing validation - `reply()`

```ts
create: routes.post('/', { input: thingInput, output: thing, responses: { 201: thing, 409: problem } },
    (context) => reply(201, made(context.input), { location: `/things/${ id }` }))
```

`responses` declares each status's body schema; `output` is the shorthand for its 200 entry.
`reply(status, body, headers?)` speaks a declared status with the body still validated;
`reply(204)` sends an empty response. An undeclared status with a body is a compile error.

## Bring your own validator

A route schema is any [Standard Schema v1](https://standardschema.dev) validator - Zod,
Valibot, ArkType, or the house `@azerothjs/schema`. A foreign schema validates the boundary
identically (the same 422 field map); its OpenAPI entry degrades to the permissive shape with
an honest note, because there is no metadata to walk. The native schema self-describes, so its
document entry carries the real constraints.

## The QUERY method

`routes.query(path, { input, output }, handler)` declares a QUERY route (RFC 10008): a safe,
idempotent read whose parameters ride in a validated JSON body. OpenAPI has no such method, so
these routes are excluded from `paths` and listed machine-readably under `x-azerothjs-query`.

## OpenAPI: the third consumer

```ts
const api = register(app, { keys, orgs, webhooks });
app.register(openapiPlugin({ features: api, info: { title: 'My API', version: '1.0.0' } }));
```

`toOpenApi(features, options)` derives the 3.1 document from the same declarations: paths,
parameters (path params from the pattern, query params from the query schema), request bodies,
per-status responses, the framework's derived 422/415/500 envelope entries, operation ids and
tags from the record keys. Deterministic by construction - two builds are byte-identical, so
specs diff cleanly in CI. `docs` on a route adds only what a machine cannot know (summary,
description, declared error prose, security schemes); it never affects runtime behavior.

`openapiPlugin` serves `/openapi.json` and a fully self-contained `/docs` explorer page
(`viewer: 'scalar'` opts into the CDN shell instead). Both are development surfaces: under
`NODE_ENV=production` the plugin registers nothing unless `public: true` says otherwise.

`uncontracted(app, features)` lists every registered route the record does not cover - the
honest burndown for incremental adoption, and form/raw/stream routes count as covered.

## Testing: the whole round trip in process

```ts
const client = createClient<typeof api>(manifestOf(api), {
    baseUrl: '/api',
    fetch: (request) => app.handle(request)   // no sockets, full types
});
```

## License

MIT (c) AzerothJS contributors.
