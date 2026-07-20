<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/logo-transparent.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/api

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fapi?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/api)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained reactive framework. The typed contract between a server and its clients: declare an API once, get the server mount, the derived handler signatures, and a fully inferred client - no codegen, no drift.

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

## The QUERY method

A route may use `method: 'QUERY'` (RFC 10008) - a safe, idempotent read that carries a body,
for filters too large or structured for a URL. Its `input` schema is the query body, validated
exactly as a POST's; the inferred client sends the QUERY request, and the handler MUST NOT
mutate state (that contract is what lets responses be cached and requests retried).

```ts
search: route({ method: 'QUERY', path: '/products/search', input: FilterSchema, output: ResultsSchema })
```

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
