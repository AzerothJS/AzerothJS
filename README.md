# AzerothJS

A TypeScript UI framework built on **fine-grained reactivity** with **no Virtual DOM**: signals
drive effects that update real DOM nodes in place. Components are written as `component` blocks in
`.azeroth` single-file components; a small compiler lowers them to one mode-aware runtime artifact
that clones DOM on the client, serializes to HTML on the server, and adopts that HTML on hydration —
all from a single intermediate representation.

Status: 0.6.0-beta. The API is close to stable but may still change before 1.0.

## Why AzerothJS

AzerothJS is, first, a framework to **learn from**. Every layer — the signal graph, the DOM renderer,
the control-flow primitives, the `.azeroth` compiler and its IR — is written from scratch with no
hidden runtime magic, so you can read it end to end and understand exactly how a modern reactive
framework works: how a signal re-runs an effect, how markup becomes a clonable template plus surgical
bindings, how one compiled artifact serves client render, SSR, and hydration. The source is meant to
be studied, not just imported.

It is also a framework you can **build real things with**. The reactivity is fine-grained and the
renderer touches the DOM directly (no Virtual DOM diff), so it stays fast in practice, and the
packages below cover what a real application needs: routing, stores, forms, server-side rendering, a
Vite build plugin, and test helpers.

## Architecture

The framework is a layered stack — each layer depends only on the ones above it:

```
@azerothjs/reactivity   signals · memos · effects · roots · resources · render-mode · SSR/hydration
        │
@azerothjs/renderer     h() · render/hydrate · Show/For/Switch/Dynamic/Suspense/Portal · bindings
        │                     (control-flow ranges from @azerothjs/component)
        ├── @azerothjs/store    @azerothjs/form    @azerothjs/router    @azerothjs/server (SSR)
        │
@azerothjs/core         umbrella: re-exports everything above behind one install
@azerothjs/compiler     .azeroth → JS (the Vite plugin) — build-time, not a runtime dependency
@azerothjs/testing      renderTest / leakGuard / fire — for testing apps built on the framework
```

Data flows one way at runtime: a **signal** write notifies its **subscribers** (effects and memos);
each effect re-runs and writes the precise DOM nodes it owns. There is no component re-render and no
diff — the graph itself is the update mechanism.

## Packages

All packages are published under the `@azerothjs` scope and versioned in lockstep.

| Package | Purpose |
| --- | --- |
| `@azerothjs/reactivity` | Signals, memos, effects, `batch`, `untrack`, `createRoot`, resources, and the SSR/hydration render-mode primitives. |
| `@azerothjs/renderer` | `h()` and the DOM renderer; `Show`, `For`, `Switch`, `Match`, `Dynamic`, `Suspense`, `Transition`, `Portal`; `classList`, `styleMap`, `css`; `render`/`hydrate`. |
| `@azerothjs/component` | Component teardown and error handling: `destroyComponent`, `ErrorBoundary`, and the co-range primitives control flow is built on. |
| `@azerothjs/store` | A minimal reactive state container: an app-wide singleton on the client, isolated per request under SSR. |
| `@azerothjs/form` | Reactive form state: per-field signals, sync validators, submit lifecycle, plus `phone()` and a country dataset. |
| `@azerothjs/router` | Fine-grained reactive client-side routing with nested layouts, loaders, and a swappable history adapter. |
| `@azerothjs/server` | Server-side rendering: `renderToString`, `renderToStaticMarkup`, `renderToDocument`, island helpers. |
| `@azerothjs/compiler` | The `.azeroth` single-file-component compiler and the `azeroth()` Vite plugin. |
| `@azerothjs/core` | Umbrella package re-exporting the runtime APIs from one entry point. |
| `@azerothjs/testing` | Test helpers (`renderTest`, `cleanup`, `leakGuard`, `fire`) for apps built on AzerothJS. |

## Install

Install the runtime umbrella, and the compiler as a dev dependency for the Vite build:

```sh
npm i @azerothjs/core
npm i -D @azerothjs/compiler
```

`@azerothjs/core` re-exports every runtime API, so one import path covers signals, the renderer,
control flow, stores, forms, the router, and SSR. You can also depend on individual packages directly
for a smaller surface — tree-shaking drops unused exports either way, so the choice is one of
explicitness, not bundle size. The `@azerothjs/*` packages share one version; install the same
version across them.

## Reactivity mental model

Three primitives, the same as you'd use directly in TypeScript:

```ts
import { createSignal, createMemo, createEffect } from '@azerothjs/core';

const [count, setCount] = createSignal(0);     // a readable value + its setter
const doubled = createMemo(() => count() * 2); // lazily recomputed when count changes
createEffect(() => console.log(doubled()));    // re-runs whenever its reads change

setCount(c => c + 1); // logs 2
```

- A **signal** is a getter/setter pair. Reading it inside an effect or memo subscribes the reader.
- A **memo** is a derived signal: computed lazily, cached, and only recomputed when a dependency
  actually changes.
- An **effect** runs immediately, tracks every signal/memo it reads, and re-runs when any of them
  change. `createRoot` owns a set of effects so they can all be disposed together; `onCleanup`
  registers teardown; `batch` coalesces multiple writes into one update; `untrack` reads without
  subscribing.

Dependencies are tracked automatically at read time — there is no dependency array to maintain.

## The `.azeroth` compiler

A `.azeroth` file is a TypeScript module written with `component` blocks. Inside a component, `state`
declares reactive state, `derived` a memo, and `effect` a side effect — read and written as plain
variables:

```azeroth
export default component Counter(props: { start?: number })
{
    state count = props.start ?? 0;
    derived parity = count % 2 === 0 ? 'even' : 'odd';

    <button
        class="btn"
        class:positive={count > 0}
        onClick={() => count++}
    >
        Count: {count} ({parity})
    </button>
}
```

The compiler:

1. **parses** the module into components and pass-through (opaque) regions;
2. **analyzes** each component's reactive sources and which ones every expression reads;
3. **lowers** the markup into a target-independent **Render Plan IR** — a static template skeleton
   plus a list of surgical bindings;
4. **emits** one mode-dispatched artifact from that IR.

Reads of reactive state compile to getter calls and writes to setter calls (`count++` becomes the
signal's functional-update setter), so authored code stays plain while the output is fine-grained:
`{count}` updates only its own text node, not the component. There is one emitter and one IR — the
same plan clones a hoisted `<template>` on the client, serializes to HTML for SSR, and adopts that
HTML on hydration, so the markers line up by construction.

## Rendering: CSR, SSR, and hydration

The same component runs in three modes, selected by how you call into the runtime:

```ts
// Client: build and mount real DOM
import { render } from '@azerothjs/core';
import App from './app.component.azeroth';

render(() => App({}), document.getElementById('root')!);
```

```ts
// Server: render to an HTML string (or a full document)
import { renderToString } from '@azerothjs/core';
import App from './app.component.azeroth';

const html = renderToString(() => App({}));
```

```ts
// Client over server-rendered HTML: adopt existing nodes instead of rebuilding
import { hydrate } from '@azerothjs/core';
import App from './app.component.azeroth';

hydrate(() => App({}), document.getElementById('root')!);
```

On the server, effects do not run and signals/memos compute once to produce HTML, with comment
markers delimiting reactive holes and control-flow ranges. On the client, `hydrate` walks that HTML
and adopts the existing nodes (no rebuild), then wires up reactivity so subsequent updates are
surgical.

## Control flow

Control flow is expressed with components, not template directives, so it composes like any other
markup and works identically across CSR/SSR/hydration:

```azeroth
import { Show, For, Switch, Match } from '@azerothjs/core';

component TodoList(props: { todos: { id: number; text: string; done: boolean }[] })
{
    <Show when={props.todos.length > 0} fallback={<p>Nothing to do.</p>}>
        <ul>
            <For each={props.todos}>
                {(todo) => <li class:done={todo.done}>{todo.text}</li>}
            </For>
        </ul>
    </Show>
}
```

`Show` toggles a branch, `For` does keyed list reconciliation with minimal DOM moves, `Switch`/`Match`
pick one branch, `Dynamic` renders a component chosen at runtime, `Suspense` coordinates async
resources, `Portal` renders elsewhere in the document, and `ErrorBoundary` catches render/effect
errors.

## Forms

The canonical way to write a form is the `form` keyword. It owns the fields, validation, and submit
lifecycle (lowering to `createForm`), and a field two-way-binds straight to an input with `bind:value` /
`bind:checked` - no manual `value` + `onInput` wiring. A field is read as `f.field`; the rest of the form
API is explicit (`f.errors()`, `f.touched()`, `f.submitting()`, `f.handleSubmit`, `f.setError(...)`).

```azeroth
import { required, email as emailRule, minLength, combine } from '@azerothjs/core';

export default component SignIn
{
    form login = { email: '', password: '' } with {
        validate: {
            email: combine(required('Email is required'), emailRule('Enter a valid email')),
            password: combine(required('Password is required'), minLength(8))
        },
        onSubmit: async (values) => { await signIn(values); }
    };

    <form onSubmit={login.handleSubmit}>
        <input type="email" bind:value={login.email} />
        <Show when={login.touched().email}><span>{login.errors().email}</span></Show>
        <input type="password" bind:value={login.password} />
        <button disabled={login.submitting()}>{login.submitting() ? 'Signing in...' : 'Sign in'}</button>
    </form>
}
```

The validators (`required`/`email`/`minLength`/`pattern`/`combine`/`phone`/...) are sync and per-field;
cross-field checks (password confirmation) and server errors go in `onSubmit` via `setError`. See
`packages/compiler/examples/SignInForm.azeroth` for the full reference. For a different taste, the
`createForm` runtime primitive can also be driven by a hand-built field component - both are supported,
but the `form` keyword is the idiomatic style.

## Build integration (Vite)

The compiler ships a Vite plugin that compiles `.azeroth` files during dev and build. It also runs
markup lint and semantic diagnostics, surfacing them as build warnings:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { azeroth } from '@azerothjs/compiler';

export default defineConfig({
    plugins: [azeroth()]
});
```

With the plugin installed, imports of `.azeroth` files just work and source maps chain back to the
original markup. Component imports use the explicit `.azeroth` extension
(`import Modal from './modal.component.azeroth'`). The plugin requires Vite 6 or newer.

## Testing

`@azerothjs/testing` provides the lifecycle helpers app tests need — mount in a fresh root, assert,
and dispose without leaking effects:

```ts
import { renderTest, fire, leakGuard } from '@azerothjs/testing';
import Counter from './counter.component.azeroth';

const guard = leakGuard();
const { container, unmount } = renderTest(() => Counter({ start: 0 }));

fire(container.querySelector('button')!, 'click');
expect(container.textContent).toContain('Count: 1');

unmount();
guard(); // throws if any subscription survived teardown
```

`renderTest` mounts into a container attached to `document.body` (so delegated events fire) and
`cleanup()` auto-registers with a global `afterEach` when one exists. A DOM environment
(happy-dom/jsdom/browser) is required.

## Development

This is an npm-workspaces monorepo.

```sh
npm install
npm run build        # build all packages in dependency order
npm run dev          # tsc --watch (type-check the whole workspace)
npm run lint         # ESLint
```

Each package builds to `dist/` via `tsc` and auto-cleans its output on every build
(`scripts/clean.mjs`). The release flow is scripted in `scripts/release.mjs` (`npm run release --
<version>`).

## License

MIT. See [LICENSE](LICENSE).
