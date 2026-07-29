<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/http / api

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fhttp?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/http)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework. The typed contract between a server and its clients: declare an API once, get the server mount, the derived handler signatures, and a fully inferred client - no codegen, no drift.

## Install

```sh
npm install @azerothjs/http
```

## One declaration, both sides

```ts
// contract.ts - imported by browser AND server (no handler code lives here)
import { defineContract, get, post } from '@azerothjs/http/api/client';
import { object, string, number } from '@azerothjs/schema';

export const contract = defineContract({
    users: {
        get: get('/users/:id', { output: object({ id: number(), name: string() }) }),
        create: post('/users', { input: object({ name: string({ min: 2 }) }) })
    }
});
```

A route is `<method>(path, { input?, query?, output?, responses?, docs? })`. The method is
the function you call - `get`, `post`, `put`, `patch`, `del`, `query`, one per `ApiMethod` -
so a route reads as one line, and the bodyless methods have no `input` field at all:
`get('/x', { input })` does not compile.

`route({ method, path, ... })` is the primitive those six are built on, the same relationship
`app.route` has to `app.get`. Prefer the helpers; reach for `route` when the method is not a
literal, because a contract is being assembled from configuration. It narrows the same way a
helper does when the method IS a literal - `route({ method: 'GET', input })` is refused too.

The key path is the call path: `users.get` above is `client.users.get(...)` below.

```ts
// server
import { mountApi } from '@azerothjs/http/api';

mountApi(app, contract, {
    handlers: {
        users: {
            get: ({ params }) => ({ id: Number(params.id), name: 'Jaina' }), // signature DERIVED - drift fails to compile
            create: ({ input }) => ({ created: input.name })
        }
    }
}); // validation at the boundary; 422s carry the form-compatible field map
```

```ts
// browser
import { createClient } from '@azerothjs/http/api/client';

const client = createClient(contract, { baseUrl: '/api' });
const user = await client.users.get({ params: { id: '42' } }); // fully inferred
```

## Why a shared contract value (not a type-only import)

Types erase: a client built from `typeof api` alone cannot know methods and paths at
runtime, and the workarounds - a manifest fetch, a codegen step, RPC-by-tree-path - all
reintroduce a second source of truth. The contract is a plain value carrying nothing a
browser must not see, and shipping the schemas buys client-side pre-validation with the
SAME rules the browser form runs: a bad input is rejected before the request leaves.

The `@azerothjs/http/api/client` subpath contains only the contract declaration, the client, and
`ApiError` - importing it can never drag the server half into a bundle.

## The enforcement points

- **Client, pre-wire** - inputs validated locally; failures throw with the field-path map.
- **Server, inbound** - forged requests hit the same schemas; failures are 422s whose
  `details.fields` is exactly what `@azerothjs/form`'s `setError` consumes.
- **Server, outbound** - declared outputs are validated too: an off-contract return is a
  hidden 500 (`contract-violation`), and undeclared fields are STRIPPED - an accidental
  `passwordHash` in a handler's return never crosses the wire.

For tests, pass an app's `handle` as the client's `fetch`: the whole client/server round
trip runs in process with zero sockets and full types.

## Typed guards - additions flow into the handler, no cast

Mount the contract with a `guards` map. A guard built with `guard()` carries its context
additions into the TYPE of every handler it protects, and the map's keys are checked
against the contract tree - a typo is a compile error, not a silently-unguarded route:

```ts
const requireAuth = guard((context) => ({ accountId: verify(context.request) }));

mountApi(app, contract, {
    guards: { 'account.*': [requireAuth] },   // 'accont.*' -> compile error
    handlers: {
        account: {
            me: (context) => ({ id: context.accountId })   // accountId: number, no cast
        }
    }
});
```

Handlers organized in separate factory files stay cast-free by sharing the guards map:
a factory returns `HandlersWithGuards<typeof contract, typeof guards>['branch']`.

## Status codes without losing validation - `reply()`

A route declares its non-default responses per status, and a handler speaks them through
`reply()` - the body is validated against that status's schema exactly like `output`, and
each status becomes its own entry in the OpenAPI document:

```ts
create: post('/users', {
    input: CreateUser, output: User,
    responses: { 201: User, 409: Problem }
}),

// in the handler:
create: ({ input }) => exists(input.email)
    ? reply(409, { code: 'exists', message: 'Email taken' })
    : reply(201, save(input), { location: `/users/${ id }` })
```

`reply(204)` sends an empty response; an undeclared status with a body is a compile
error. A raw `Response` return remains the escape hatch for non-JSON answers (files,
redirects, streams) - the ONLY return shape that bypasses output validation.

## File routes - `multipart()`

A route declares a multipart/form-data input at the contract level; the handler receives
validated text fields plus the files, fully typed:

```ts
upload: post('/files', {
    input: multipart({ fields: object({ title: string() }), maxFileSize: 20 * 1024 * 1024 }),
    output: FileRecord
}),

// in the handler:
upload: ({ input }) => save(input.fields.title, input.files)   // files: buffered, capped
```

Field failures are the same 422 map as JSON routes; a non-multipart POST is a 415; the
OpenAPI document declares the `multipart/form-data` body with the fields schema. The
typed client does not speak multipart (a browser posts `FormData` directly - calling
such a route through the client is a loud error), and beyond-memory uploads keep using
`streamMultipart(context.request)` from `@azerothjs/http` in the handler.

## Bring your own validator

A route's `input` accepts any [Standard Schema](https://standardschema.dev) validator
(Zod, Valibot, ArkType) alongside native `@azerothjs/schema` - so a team keeps its
existing schemas. A foreign schema validates the boundary; its OpenAPI entry degrades to
the permissive shape (native schemas keep full self-description).

## The QUERY method

> **Experimental.** RFC 10008 is not yet deployed internet reality - proxies, caches,
> and tooling may not recognize QUERY. The API is stable within 1.x but flagged until
> the RFC lands broadly.

A route may use `method: 'QUERY'` (RFC 10008) - a safe, idempotent read that carries a body,
for filters too large or structured for a URL. Its `input` schema is the query body, validated
exactly as a POST's; the inferred client sends the QUERY request, and the handler MUST NOT
mutate state (that contract is what lets responses be cached and requests retried).

```ts
search: query('/products/search', { input: FilterSchema, output: ResultsSchema })
```

## OpenAPI: the contract's third exporter

The same declaration that produces the server mount and the typed client produces the
OpenAPI 3.1 document - three consumers, one truth, drift structurally impossible for
everything derived. No decorators, no YAML, no annotations on schemas: paths, params,
request bodies, response shapes, operation ids and tags (from the contract tree), and
the framework's 422/415/500 envelope responses are all read from what already exists.

```ts
import { toOpenApi, openapiPlugin } from '@azerothjs/http/api';

// Serve it (any external viewer - Scalar, Redoc, Swagger UI - reads the endpoint):
app.register(openapiPlugin({ contract, info: { title: 'Shop API', version: '1.0.0' } }));

// Or emit it for CI / SDK pipelines (deterministic: same contract, byte-identical spec):
await writeFile('openapi.json', JSON.stringify(toOpenApi(contract, { info }), null, 2));
```

A route's `docs` field adds only what a machine cannot know - summary, tags,
deprecation, extra error statuses, security requirements - and never affects runtime:

```ts
create: route({
    method: 'POST', path: '/users', input: CreateUser, output: User,
    docs: { summary: 'Create a user', errors: [{ status: 409, code: 'exists' }] }
})
```

The plugin also serves a docs page at `/docs` (disable with `docs: false`). Two
viewers, one option:

- **`viewer: 'scalar'` (default)** - a ~10-line shell; the browser loads the Scalar
  reference from a CDN. Best-in-class UI for free; needs internet while viewing.
- **`viewer: 'azeroth'`** - the house explorer: one fully self-contained page (inline
  styles and script, zero external requests, works offline) in the AzerothJS design
  language - REST-colored methods, verdict-colored statuses, schema trees, and a
  same-origin try-it panel. For locked-down networks and air-gapped environments.

External viewers can always read `/openapi.json` directly instead.

The schema-to-JSON-Schema rules degrade honestly - a `.refine()` becomes a description
note, never an invented constraint; a foreign validator maps to the permissive shape.
Known limits, stated up front: multipart uploads, WebSocket/SSE, and outbound webhooks
are not expressible; QUERY routes have no OpenAPI method and are listed under the
`x-azerothjs-query` extension instead of `paths`.

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
