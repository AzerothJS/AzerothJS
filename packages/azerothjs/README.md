<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />

# azerothjs

**The AzerothJS frontend framework: fine-grained reactivity, compiled `.azeroth` components, control flow, SSR + islands, router, and forms - one package.**

[![npm](https://img.shields.io/npm/v/azerothjs?color=2ea44f)](https://www.npmjs.com/package/azerothjs)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

</div>

---

Signals drive effects that update real DOM nodes in place: a state write re-runs exactly the
effects that read it, and each effect owns specific nodes. There is no Virtual DOM, no diff,
and no component re-render - the reactive graph itself is the update mechanism.

Author `.azeroth` single-file components (compiled by `@azerothjs/compiler`) with
`state`/`derived`/`effect` keywords, or use the primitives (`createSignal`, `createMemo`,
`createEffect`) directly from `.ts`. One install carries the whole frontend - reactivity, the
`h()` renderer, control flow, stores, resources, router, forms, and SSR + hydration - with zero
third-party runtime dependencies. ESM-only, Node >= 22.

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

> [!TIP]
> `state` and `derived` are language keywords - reads and writes stay plain (`count++`), the
> compiler wires the signals. `{count}` updates only its own text node.

---

## 📦 Install

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

---

## 🧠 The `.azeroth` language

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

---

## 🧩 Core API

`azerothjs` is the single runtime import; tree-shaking drops what you don't use. Every symbol below
is a real export of the package.

### Reactivity

`createSignal` (state), `createMemo` (cached derivation), and `createEffect` (reaction) are the
core; `batch`, `untrack`, `createRoot`, and `onCleanup` control scheduling and lifetime.

```ts
import { createSignal, createMemo, createEffect, batch, untrack, createRoot, onCleanup } from 'azerothjs';

const [count, setCount] = createSignal(0);
const doubled = createMemo(() => count() * 2);

createEffect(() => console.log(count(), doubled())); // re-runs when count changes

batch(() => { setCount(1); setCount(2); });          // one flush, one effect run
untrack(() => count());                              // read without subscribing

const dispose = createRoot((dispose) =>
{
    createEffect(() => { /* ... */ });
    onCleanup(() => { /* teardown when the root disposes */ });
    return dispose;
});
dispose(); // tears down every effect created in the root
```

### Rendering

The same compiled component renders on the client, serializes on the server, and hydrates over
server HTML - from a single intermediate representation, so the hydration markers line up by
construction:

```ts
import { render, hydrate, renderToString } from 'azerothjs';

render(() => App(), root);                 // client: build and mount real DOM
const html = renderToString(() => App()); // server: pure string emission, no DOM shim
hydrate(() => App(), root);                // client over server HTML: adopt, don't rebuild
```

### Control flow

Conditional, list, async, relocated, and error rendering are components, used inside `.azeroth`
markup: `Show`, `For`, `Switch`/`Match`, `Dynamic`, `Suspense`, `Portal`, and `ErrorBoundary`.

```azeroth
<Show when={user()} fallback={<a href="/login">Sign in</a>}>
    <p>Welcome, {user()!.name}</p>
</Show>

<For each={items()} key={(item) => item.id}>
    {(item, index) => <li>{index() + 1}. {item.label}</li>}
</For>

<Switch fallback={<NotFound />}>
    <Match when={tab() === 'home'}><Home /></Match>
    <Match when={tab() === 'about'}><About /></Match>
</Switch>

<ErrorBoundary fallback={(error, reset) => <button onClick={reset}>Retry ({String(error)})</button>}>
    <Profile />
</ErrorBoundary>
```

`Dynamic` renders a component chosen at runtime, `Suspense` shows a fallback while the resources in
its `on` list load, and `Portal` renders its children into a target elsewhere in the document
(default `document.body`).

### Stores & resources

`createStore` is a lazily-built singleton with per-request isolation under SSR; `createResource`
wraps async data with `data`/`loading`/`error` getters and `refetch`; `createStream` consumes a
streaming source.

```ts
import { createStore, createResource, createSignal } from 'azerothjs';

const useCart = createStore(() =>
{
    const [items, setItems] = createSignal<string[]>([]);
    return { items, add: (id: string) => setItems([...items(), id]) };
});

const user = createResource(() => fetch(`/api/users/${id()}`).then((r) => r.json()));
user.loading(); // true while a fetch is in flight
user.data();    // the resolved value, or undefined
```

### Forms

`createForm` builds a reactive form from an `initial` shape, per-field `validate` rules (or one
whole-form `schema`), and an `onSubmit`; `createFieldArray` manages a dynamic list of repeated
sub-forms. The single-argument validators (`required`, `email`, `minLength`, `pattern`, `phone`,
...) and `combine` are re-exported from `@azerothjs/schema`.

```ts
import { createForm, combine, required, email } from 'azerothjs';

const form = createForm({
    initial: { email: '', password: '' },
    validate: { email: combine(required(), email()), password: required() },
    onSubmit: async (values) => { await signIn(values); }
});

form.values();     // reactive values snapshot
form.submitting(); // true while onSubmit is pending
// <form onSubmit={form.handleSubmit}> ... <input {...form.register('email')} /> ... </form>
```

### Router

`createRouter` takes a route table (routes are data, not `<Route>` elements); `RouterProvider`
publishes it, `<Routes>` renders the matched component, `<Link>` navigates, and
`useParams`/`useQuery`/`useNavigate` read location state.

```ts
import { createRouter } from 'azerothjs';

const router = createRouter({
    routes: [
        { path: '/', component: Home },
        { path: '/users/:id', component: UserProfile }
    ]
});
```

```azeroth
<RouterProvider router={router}>
    <nav><Link to="/users/42">Profile</Link></nav>
    <Routes />
</RouterProvider>
```

---

## 🌐 The server side

SSR ships in `azerothjs` itself (`renderToString` above). The rest of the backend is its own
zero-dependency stack under the same scope - run it behind an AzerothJS frontend, or entirely on
its own: nothing in it requires the client packages.

| Package | What it is |
| --- | --- |
| [`@azerothjs/http`](https://www.npmjs.com/package/@azerothjs/http) | Web-standard `Request`/`Response` HTTP kernel: radix router, typed middleware, body limits on by default, SSE, cookies, static files, graceful shutdown. |
| [`@azerothjs/schema`](https://www.npmjs.com/package/@azerothjs/schema) | Validation whose TypeScript types are inferred from the declaration - one source of rules for browser forms and server DTOs. |
| `@azerothjs/http/api` (part of [`@azerothjs/http`](https://www.npmjs.com/package/@azerothjs/http)) | Declare an API contract once: the server mount, the handler signatures, and a fully inferred client - no codegen, no drift. |
| [`@azerothjs/ws`](https://www.npmjs.com/package/@azerothjs/ws) | WebSocket server implementing RFC 6455 from scratch, attached to the same `serve()`. |
| [`@azerothjs/cron`](https://www.npmjs.com/package/@azerothjs/cron) | Job scheduler: real cron expressions with honest timezone/DST semantics and overlap policies. |

The halves are designed to meet: every request is a reactive root with the same per-request
`createStore` isolation SSR renders have, `sse()` emits exactly what the `stream` keyword
consumes, and a server validation failure's field map drops straight into a browser form's
`setError`.

---

## 🧭 Editor support

- **VS Code** - the AzerothJS extension (built from `editors/vscode` in this repo):
  bundled language server, completion, hover docs for every keyword, cross-file navigation and
  rename across the `.ts` <-> `.azeroth` boundary, semantic highlighting.
- **JetBrains** (WebStorm, IntelliJ IDEA Ultimate, ...) - the AzerothJS plugin: native `.azeroth`
  language plus the same language server over LSP.
- **CI** - `azeroth-tsc` (from `@azerothjs/language-server`) type-checks `.ts` + `.azeroth` in one
  program, the `vue-tsc` equivalent.

---

## 📥 Which package do I import from?

The canon is one rule per side of the wire:

| You are writing... | Import from |
| --- | --- |
| Anything client-side or SSR - components, signals, control flow, the router, forms, `renderToString` | `azerothjs` (this package - the whole frontend is ONE real package) |
| Schemas / validation shared by both halves | `@azerothjs/schema` |
| The server - routes, middleware, contracts | `@azerothjs/http` (contracts at `@azerothjs/http/api`) (+ `@azerothjs/ws`, `@azerothjs/cron`, `@azerothjs/logger`) |
| The browser half of a typed API contract | `@azerothjs/http/api/client` (client-safe; never drags server code into a bundle) |
| Tests / dev tooling | `@azerothjs/testing`, `@azerothjs/devtools`; dev-deps: `@azerothjs/compiler`, `@azerothjs/cli`, the editor tooling |

Two things are deliberately NOT application API: `azerothjs/internal` (the compiled-output
runtime contract - generated `.azeroth` code imports it, you never do), and anything a
package documents as internal. Tree-shaking drops unused exports, so importing from the
one `azerothjs` package costs a bundle nothing over the old per-layer packages - which is
why the frontend layers are no longer published separately.

---

## 📚 Documentation

Guides, package docs, and the full language reference live in the
[GitHub repository](https://github.com/AzerothJS/AzerothJS); start from the
[monorepo README](../../README.md). Related packages:
[`@azerothjs/schema`](https://www.npmjs.com/package/@azerothjs/schema),
[`@azerothjs/http`](https://www.npmjs.com/package/@azerothjs/http),
[`@azerothjs/compiler`](https://www.npmjs.com/package/@azerothjs/compiler).

---

<div align="center">
<sub>Part of <a href="../../README.md">AzerothJS</a> · <a href="https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE">MIT License</a></sub>
</div>
