<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="160" />

# AzerothJS

**The fine-grained fullstack TypeScript framework - compiled components, web-standard servers, one CLI. No Virtual DOM. Zero dependencies.**

[![npm](https://img.shields.io/npm/v/azerothjs?color=2ea44f)](https://www.npmjs.com/package/azerothjs)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-AzerothJS-181717?logo=github)](https://github.com/AzerothJS/AzerothJS)

</div>

Signals drive effects that update real DOM nodes in place: a state write re-runs exactly the
effects that read it, and each effect owns specific nodes. There is no component re-render and no
diffing - the reactive graph itself is the update mechanism.

```azeroth
export default component Counter(props: { start?: number })
{
    state count = props.start ?? 0;
    derived parity = count % 2 === 0 ? 'even' : 'odd';

    <button class="btn" class:positive={count > 0} onClick={() => count++}>
        Count: {count} ({parity})
    </button>
}
```

`state` and `derived` are language keywords - reads and writes stay plain (`count++`), the
compiler wires the signals. `{count}` updates only its own text node.

## Install

```sh
npm install azerothjs
npm install -D @azerothjs/compiler
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { azeroth } from '@azerothjs/compiler';

export default defineConfig({ plugins: [azeroth()] });
```

```ts
// src/main.ts
import { render } from 'azerothjs';
import App from './app';   // ./app.azeroth - the extension may be omitted

render(() => App(), document.getElementById('root')!);
```

The Vite plugin compiles `.azeroth` files with build-time lint, semantic diagnostics, and real
TypeScript type checking. `azerothjs` is the one runtime import an application needs - it carries
the complete API surface:

| Area | Exports |
| --- | --- |
| Reactivity | `createSignal` `createMemo` `createEffect` `batch` `untrack` `on` `createRoot` `onCleanup` `createResource` `createStream` `createDeferred` `createSelector` `catchError` ... |
| Rendering | `render` `hydrate` `h` `Show` `For` `Switch`/`Match` `Dynamic` `Suspense` `Transition` `Portal` `ErrorBoundary` `classList` `styleMap` `css` |
| State | `createStore` (lazy singleton; per-request isolation under SSR) |
| Forms | `createForm` `createFieldArray` + validators (`required` `email` `minLength` `pattern` `combine` `phone` ...) |
| Routing | `createRouter` `Link` `Routes` `Outlet` `useParams` `useQuery` `useNavigate` `useLoader` ... |
| SSR | `renderToString` `renderToStaticMarkup` `renderToDocument` |

## The `.azeroth` language

A `.azeroth` file is a TypeScript module with `component` blocks. Inside a component, reactive
declarations are first-class keywords:

| Keyword | Meaning |
| --- | --- |
| `state x = v` | writable reactive state - `x++` just works |
| `derived y = expr` | cached computed value |
| `effect { ... }` | auto-tracked side effect (`effect (deps) { ... }` for explicit deps) |
| `form f = shape with { ... }` | fields, sync/cross-field/async validation, submit lifecycle |
| `form rows[] = blank with { ... }` | a dynamic list of repeated sub-forms |
| `store` / `resource` / `stream` / `selector` / `deferred` | shared state, async data, streams, keyed selection, debounced values |

```azeroth
form login = { email: '', password: '' } with {
    validate: { email: combine(required(), email()), password: required() },
    onSubmit: async (values) => { await signIn(values); }
};

<form onSubmit={login.handleSubmit}>
    <input type="email" bind:value={login.email} />
    <button disabled={login.submitting()}>Sign in</button>
</form>
```

Control flow is components (`<Show>`, `<For>`, `<Switch>`...), styling is `class:`/`style:`
directives, and two-way input binding is `bind:value`/`bind:checked`.

## One artifact, three modes

The same compiled component renders on the client, serializes on the server, and hydrates over
server HTML - from a single intermediate representation, so the hydration markers line up by
construction:

```ts
import { render, hydrate, renderToString } from 'azerothjs';

render(() => App(), root);                 // client
const html = renderToString(() => App()); // server - pure string emission, no DOM shim
hydrate(() => App(), root);                // adopt server HTML, don't rebuild
```

## The server side

SSR ships in `azerothjs` itself (`renderToString` above). The rest of the backend is its own
zero-dependency stack under the same scope - run it behind an AzerothJS frontend, or entirely on
its own: nothing in it requires the client packages.

```ts
import { App, json, serve, readValidated } from '@azerothjs/http';
import { object, string, number } from '@azerothjs/schema';

const createUser = object({ name: string({ min: 2 }), age: number({ int: true }) });

const app = new App();

app.get('/users/:id', (request, ctx) => json({ id: ctx.params.id })); // params typed from the pattern

app.post('/users', async (request) =>
{
    const input = await readValidated(request, createUser); // typed, normalized; failure -> 422
    return json({ created: input.name }, { status: 201 });
});

const served = await serve(app, { port: 3000 });
```

| Package | What it is |
| --- | --- |
| [`@azerothjs/http`](https://www.npmjs.com/package/@azerothjs/http) | Web-standard `Request`/`Response` HTTP kernel: radix router, typed middleware, body limits on by default, SSE, cookies, static files, graceful shutdown. |
| [`@azerothjs/schema`](https://www.npmjs.com/package/@azerothjs/schema) | Validation whose TypeScript types are inferred from the declaration - one source of rules for browser forms and server DTOs. |
| [`@azerothjs/api`](https://www.npmjs.com/package/@azerothjs/api) | Declare an API contract once: the server mount, the handler signatures, and a fully inferred client - no codegen, no drift. |
| [`@azerothjs/ws`](https://www.npmjs.com/package/@azerothjs/ws) | WebSocket server implementing RFC 6455 from scratch, attached to the same `serve()`. |
| [`@azerothjs/cron`](https://www.npmjs.com/package/@azerothjs/cron) | Job scheduler: real cron expressions with honest timezone/DST semantics and overlap policies. |

The halves are designed to meet: every request is a reactive root with the same per-request
`createStore` isolation SSR renders have, `sse()` emits exactly what the `stream` keyword
consumes, and a server validation failure's field map drops straight into a browser form's
`setError`.

## Editor support

- **VS Code** - the AzerothJS extension (built from `editors/vscode` in this repo):
  bundled language server, completion, hover docs for every keyword, cross-file navigation and
  rename across the `.ts` <-> `.azeroth` boundary, semantic highlighting.
- **JetBrains** (WebStorm, IntelliJ IDEA Ultimate, ...) - the AzerothJS plugin: native `.azeroth`
  language plus the same language server over LSP.
- **CI** - `azeroth-tsc` (from `@azerothjs/language-server`) type-checks `.ts` + `.azeroth` in one
  program, the `vue-tsc` equivalent.

## Fine-grained packages

`azerothjs` re-exports the full client framework plus SSR. Every layer is also published
individually under the `@azerothjs/*` scope - depend on one directly when you want a narrower
surface (a library that only needs `@azerothjs/reactivity`, a service that only needs
`@azerothjs/http`). Tree-shaking drops unused exports either way. The scope also carries the
tooling: `@azerothjs/testing` (leak-guarded component tests), `@azerothjs/devtools` (in-page
reactive-graph panel), and `@azerothjs/eslint-plugin` (`.azeroth` as a first-class lint target).

## Documentation

Guides, package docs, and the full language reference live in the
[GitHub repository](https://github.com/AzerothJS/AzerothJS).

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
