<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/api

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fapi?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/api)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework. The typed contract between a server and its clients: declare an API once, get the server mount, the derived handler signatures, and a fully inferred client - no codegen, no drift.

## Install

```sh
npm install @azerothjs/api
```

## One declaration, both sides

```ts
// shared/contract.ts - imported by browser AND server (no handler code lives here)
import { defineContract, route } from '@azerothjs/api/client';
import { object, string, number } from '@azerothjs/schema';

export const contract = defineContract({
    users: {
        get: route({ method: 'GET', path: '/users/:id', output: object({ id: number(), name: string() }) }),
        create: route({ method: 'POST', path: '/users', input: object({ name: string({ min: 2 }) }) })
    }
});
```

```ts
// server
import { implementContract, mountApi } from '@azerothjs/api';

const api = implementContract(contract, {
    users: {
        get: ({ params }) => ({ id: Number(params.id), name: 'Jaina' }), // signature DERIVED - drift fails to compile
        create: ({ input }) => ({ created: input.name })
    }
});
mountApi(app, api); // validation at the boundary; 422s carry the form-compatible field map
```

```ts
// browser
import { createClient } from '@azerothjs/api/client';

const client = createClient(contract, { baseUrl: '/api' });
const user = await client.users.get({ params: { id: '42' } }); // fully inferred
```

## Why a shared contract value (not a type-only import)

Types erase: a client built from `typeof api` alone cannot know methods and paths at
runtime, and the workarounds - a manifest fetch, a codegen step, RPC-by-tree-path - all
reintroduce a second source of truth. The contract is a plain value carrying nothing a
browser must not see, and shipping the schemas buys client-side pre-validation with the
SAME rules the browser form runs: a bad input is rejected before the request leaves.

The `@azerothjs/api/client` subpath contains only the contract declaration, the client, and
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

## Bring your own validator

`route({ input })` accepts any [Standard Schema](https://standardschema.dev) validator
(Zod, Valibot, ArkType) alongside native `@azerothjs/schema` - so a team keeps its
existing schemas. A foreign schema validates the boundary; its OpenAPI entry degrades to
the permissive shape (native schemas keep full self-description).

## The QUERY method

A route may use `method: 'QUERY'` (RFC 10008) - a safe, idempotent read that carries a body,
for filters too large or structured for a URL. Its `input` schema is the query body, validated
exactly as a POST's; the inferred client sends the QUERY request, and the handler MUST NOT
mutate state (that contract is what lets responses be cached and requests retried).

```ts
search: route({ method: 'QUERY', path: '/products/search', input: FilterSchema, output: ResultsSchema })
```

## OpenAPI: the contract's third exporter

The same declaration that produces the server mount and the typed client produces the
OpenAPI 3.1 document - three consumers, one truth, drift structurally impossible for
everything derived. No decorators, no YAML, no annotations on schemas: paths, params,
request bodies, response shapes, operation ids and tags (from the contract tree), and
the framework's 422/415/500 envelope responses are all read from what already exists.

```ts
import { toOpenApi, openapiPlugin } from '@azerothjs/api';

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
