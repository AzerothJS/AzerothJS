<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/logo-transparent.png" alt="AzerothJS - the A with the dragon" width="160" />

# AzerothJS

**A fine-grained reactive TypeScript framework with compiled single-file components - no Virtual DOM, ever.**

[![npm](https://img.shields.io/npm/v/azerothjs?label=azerothjs&color=2ea44f)](https://www.npmjs.com/package/azerothjs)
[![CI](https://github.com/AzerothJS/AzerothJS/actions/workflows/ci.yml/badge.svg)](https://github.com/AzerothJS/AzerothJS/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](package.json)

</div>

Signals drive effects that update real DOM nodes in place. Components are written as `component`
blocks in `.azeroth` single-file components; the compiler lowers them to one mode-aware artifact
that clones DOM on the client, serializes HTML on the server, and adopts that HTML on hydration - 
all from a single intermediate representation.

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

`{count}` updates only its own text node. There is no component re-render and no diff - the
reactive graph itself is the update mechanism.

> **Status:** `0.7.0-beta`. Feature-complete and dogfooded on production applications; the API may
> still receive refinements before `1.0`.

## Quick start

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
import App from './app';          // ./app.azeroth - the extension may be omitted

render(() => App(), document.getElementById('root')!);
```

That is the whole setup: the Vite plugin compiles `.azeroth` files (with build-time lint, semantic
diagnostics, and real TypeScript type checking), and `azerothjs` is the one runtime import an
application needs.

## Why AzerothJS

- **Fine-grained by construction.** A signal write re-runs exactly the effects that read it; each
  effect owns specific DOM nodes. No VDOM, no diffing, no component re-renders.
- **A language, not a convention.** `state`, `derived`, `effect`, `form`, `store`, `resource`,
  `stream`, `selector`, and `deferred` are first-class keywords in `.azeroth` files - reads and
  writes stay plain (`count++`), the compiler wires the reactivity.
- **One artifact, three modes.** The same compiled component renders on the client, serializes on
  the server, and hydrates over server HTML - the markers line up by construction because there is
  one emitter and one IR.
- **Editor tooling at framework grade.** A compiler-powered language server drives both the
  [VS Code extension](editors/vscode) and the [JetBrains plugin](editors/jetbrains): completion,
  hover docs for every keyword, go-to-definition and find-references *across* the `.ts` <->
  `.azeroth` boundary, safe cross-file rename, semantic highlighting with a distinct color for
  reactive names, and `azeroth-tsc` for CI type checking.
- **Readable end to end.** Every layer - the signal graph, the renderer, the compiler and its IR - 
  is written from scratch with no hidden runtime magic. The source is meant to be studied as much
  as used.

## Reactivity in 20 lines

The `.azeroth` keywords compile down to three primitives you can also use directly in TypeScript:

```ts
import { createSignal, createMemo, createEffect } from 'azerothjs';

const [count, setCount] = createSignal(0);     // a readable value + its setter
const doubled = createMemo(() => count() * 2); // recomputed lazily when count changes
createEffect(() => console.log(doubled()));    // re-runs whenever its reads change

setCount(c => c + 1); // logs 2
```

Dependencies are tracked automatically at read time - there is no dependency array. `createRoot`
scopes disposal, `onCleanup` registers teardown, `batch` coalesces writes, `untrack` reads without
subscribing.

## The `.azeroth` language

A `.azeroth` file is a TypeScript module with `component` blocks. Inside a component:

| Keyword | Meaning | Lowers to |
| --- | --- | --- |
| `state x = v` | writable reactive state (`x++` just works) | `createSignal` |
| `derived y = expr` | cached computed value | `createMemo` |
| `effect { ... }` | side effect, auto-tracked (`effect (deps)` for explicit ones) | `createEffect` |
| `form f = shape with { ... }` | fields + validation + submit lifecycle ([details](packages/form)) | `createForm` |
| `form rows[] = blank with { ... }` | dynamic list of repeated sub-forms | `createFieldArray` |
| `store` / `resource` / `stream` / `selector` / `deferred` | shared state, async data, streams, keyed selection, debounced values | their factories |

Markup uses components for control flow - `<Show>`, `<For>`, `<Switch>/<Match>`, `<Dynamic>`,
`<Suspense>`, `<Portal>`, `<ErrorBoundary>` - plus `class:`/`style:` directives and `bind:` for
pure-mirror inputs. Hover any keyword in the editor for its full documentation and `with { ... }`
options.

## Rendering: CSR, SSR, hydration

```ts
import { render, hydrate, renderToString } from 'azerothjs';
import App from './app';

render(() => App(), root);                    // client: build and mount real DOM
const html = renderToString(() => App());     // server: pure string emission, no DOM shim
hydrate(() => App(), root);                   // client over server HTML: adopt, don't rebuild
```

## Packages

Everything is versioned in lockstep. `azerothjs` is the one package an application installs; the
`@azerothjs/*` scope holds the individual layers and tooling.

| Package | Purpose |
| --- | --- |
| [`azerothjs`](packages/azerothjs) | **The framework.** One install, every runtime API. |
| [`@azerothjs/compiler`](packages/compiler) | The `.azeroth` compiler + the `azeroth()` Vite plugin (dev dependency). |
| [`@azerothjs/reactivity`](packages/reactivity) | Signals, memos, effects, roots, resources, SSR/hydration primitives. |
| [`@azerothjs/renderer`](packages/renderer) | `h()`, `render`/`hydrate`, control-flow components, bindings. |
| [`@azerothjs/component`](packages/component) | Subtree teardown, `ErrorBoundary`, control-flow range infrastructure. |
| [`@azerothjs/store`](packages/store) | Lazy-singleton reactive stores; per-request isolation under SSR. |
| [`@azerothjs/form`](packages/form) | Forms: sync/cross-field/async validation, field arrays, submit lifecycle. |
| [`@azerothjs/router`](packages/router) | Reactive client-side routing with nested layouts and loaders. |
| [`@azerothjs/server`](packages/server) | `renderToString` / `renderToStaticMarkup` / `renderToDocument`. |
| [`@azerothjs/http`](packages/http) | Zero-dependency web-standard HTTP kernel; every request is a reactive root. |
| [`@azerothjs/schema`](packages/schema) | Validation combinators whose TypeScript types are inferred from the declaration. |
| [`@azerothjs/api`](packages/api) | One API contract: the server mount and a fully inferred client, no codegen. |
| [`@azerothjs/ws`](packages/ws) | WebSocket server implementing RFC 6455 from scratch. |
| [`@azerothjs/cron`](packages/cron) | Cron scheduler with honest timezone/DST semantics and overlap policies. |
| [`@azerothjs/testing`](packages/testing) | `renderTest`, `cleanup`, `leakGuard`, `fire` for app tests. |
| [`@azerothjs/devtools`](packages/devtools) | Dev-only in-page panel: reactive tree, dependency graph, timeline. |
| [`@azerothjs/eslint-plugin`](packages/eslint-plugin) | Reactivity lint rules + a processor that makes `.azeroth` a first-class lint target. |
| [`@azerothjs/language-service`](packages/language-service) | The editor intelligence (TypeScript bridge, markup model, providers). |
| [`@azerothjs/language-server`](packages/language-server) | LSP frontend + the `azeroth-tsc` CLI type checker. |
| [`@azerothjs/typescript-plugin`](packages/typescript-plugin) | tsserver plugin: real `.azeroth` types inside `.ts` files. |

## Editor support

| Editor | What you get |
| --- | --- |
| [**VS Code**](editors/vscode) | Bundled language server (no Node required), tsserver plugin auto-wired, semantic highlighting, cross-file navigation and rename, inlay hints, formatting. |
| [**JetBrains**](editors/jetbrains) (WebStorm, IDEA Ultimate, ...) | Native `.azeroth` language + the same language server over LSP; usage-aware inspections (a `.ts` export used only from `.azeroth` is not "unused"), themeable reactive colors. |

## Testing

```ts
import { renderTest, fire, leakGuard } from '@azerothjs/testing';
import Counter from './counter';

const guard = leakGuard();
const { container, unmount } = renderTest(() => Counter({ start: 0 }));

fire(container.querySelector('button')!, 'click');
expect(container.textContent).toContain('Count: 1');

unmount();
guard(); // throws if any subscription survived teardown
```

## Development (this repository)

An npm-workspaces monorepo, Node >= 24.

```sh
npm install
npm run build        # all packages, dependency order
npm test             # vitest (the full suite)
npm run lint         # ESLint (includes .azeroth via the plugin)
npm run typecheck    # tsc over the whole workspace
npm run verify       # everything above + publish contract + leak gate
```

Releases are scripted (`npm run release -- <version>`); tags trigger CI that attaches the editor
artifacts to the GitHub Release.

## License

[MIT](LICENSE)
