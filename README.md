<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="140" />

# AzerothJS

### The fine-grained, fullstack TypeScript framework

**Compiled components · web-standard servers · one CLI**
<br/>No Virtual DOM. No diffing. Zero dependencies.

<p>
  <a href="https://www.npmjs.com/package/azerothjs"><img src="https://img.shields.io/npm/v/azerothjs?color=2ea44f&label=azerothjs" alt="npm" /></a>
  <a href="https://github.com/AzerothJS/AzerothJS/actions/workflows/ci.yml"><img src="https://github.com/AzerothJS/AzerothJS/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node >= 22" /></a>
  <img src="https://img.shields.io/badge/types-included-3178c6?logo=typescript&logoColor=white" alt="Types included" />
  <img src="https://img.shields.io/badge/dependencies-0-2ea44f" alt="Zero dependencies" />
</p>

<p>
  <b><a href="#quick-start">Quick start</a></b> ·
  <b><a href="#why">Why</a></b> ·
  <b><a href="#language">Language</a></b> ·
  <b><a href="#server">Server</a></b> ·
  <b><a href="#packages">Packages</a></b> ·
  <b><a href="#editors">Editors</a></b>
</p>

</div>

---

Signals drive effects that update **real DOM nodes in place**. Components are written as `component`
blocks in `.azeroth` single-file components; the compiler lowers each one to a single mode-aware
artifact that **clones DOM on the client, serializes HTML on the server, and adopts that HTML on
hydration** - all from one intermediate representation.

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
> `{count}` updates **only its own text node**. There is no component re-render and no diff - the
> reactive graph *itself* is the update mechanism. Write `count++`; the compiler wires the reactivity.

---

<a id="quick-start"></a>

## ⚡ Quick start

The fastest path is the scaffolder - a frontend, backend, or fullstack app with the whole toolchain
wired in (one `npm run dev`, `azeroth check` as the gate):

```sh
npm create azeroth@latest my-app
cd my-app && npm install && npm run dev
```

Pick a shape (frontend, backend, fullstack) and its options - `--router` for pages on the
framework's own router, `--tailwind` for Tailwind v4 wired through `@tailwindcss/vite`.

<details>
<summary><b>... or wire a Vite project by hand</b></summary>

<br/>

```sh
npm install azerothjs
npm install -D @azerothjs/compiler typescript
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

</details>

---

<a id="why"></a>

## ✨ Why AzerothJS

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
  hover docs for every keyword, go-to-definition and find-references *across* the `.ts` ⇄ `.azeroth`
  boundary, safe cross-file rename, and semantic highlighting with a distinct color for reactive names.
- **No hidden runtime.** The signal graph, the renderer, and the compiler with its IR are all written
  from scratch - small, dependency-free, and readable when you need to know exactly what runs.

---

## 🧠 The primitives underneath

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

---

<a id="language"></a>

## 🧩 The `.azeroth` language

A `.azeroth` file is a TypeScript module with `component` blocks. Inside a component:

| Keyword | Meaning | Lowers to |
| --- | --- | --- |
| `state x = v` | writable reactive state (`x++` just works) | `createSignal` |
| `derived y = expr` | cached computed value | `createMemo` |
| `effect { ... }` | side effect, auto-tracked (`effect (deps)` for explicit ones) | `createEffect` |
| `form f = shape with { ... }` | fields + validation + submit lifecycle | `createForm` |
| `form rows[] = blank with { ... }` | dynamic list of repeated sub-forms | `createFieldArray` |
| `store` · `resource` · `stream` · `selector` · `deferred` | shared state, async data, streams, keyed selection, debounced values | their factories |

Markup uses components for control flow - `<Show>`, `<For>`, `<Switch>`/`<Match>`, `<Dynamic>`,
`<Suspense>`, `<Portal>`, `<ErrorBoundary>` - plus `class:`/`style:` directives and `bind:` for
pure-mirror inputs. Hover any keyword in the editor for its full documentation and `with { ... }` options.

---

## 🖥️ Rendering: CSR, SSR, hydration

```ts
import { render, hydrate, renderToString } from 'azerothjs';
import App from './app';

render(() => App(), root);                    // client: build and mount real DOM
const html = renderToString(() => App());     // server: pure string emission, no DOM shim
hydrate(() => App(), root);                   // client over server HTML: adopt, don't rebuild
```

---

<a id="server"></a>

## 🌐 The server half

The backend is the same philosophy, written from scratch: no third-party dependencies, web-standard
types, and reactivity as the spine - **every request runs inside a reactive root**, so stores are
request-isolated across `await` exactly as they are under SSR, and cleanup always runs.

```ts
import { App, serve, json, readValidated } from '@azerothjs/http';
import { createAccount } from './schema';   // an @azerothjs/schema declaration

const app = new App();
app.get('/accounts/:id', (context) => json({ id: context.params.id })); // params typed from the pattern
app.post('/accounts', async (context) =>
{
    const input = await readValidated(context.request, createAccount); // 422s carry the field map
    return json({ created: input }, { status: 201 });
});

const served = await serve(app, { port: 3000 });
```

> [!NOTE]
> There is no build step - Node >= 24 runs the TypeScript source directly (type stripping is
> unflagged from 22.18, and the backend templates pin `>=24`), and
> `app.handle(new Request(...))` is the entire integration-testing story.

One error path (shape it with `serializeError`), scoped middleware (`app.with(requireAuth)`), typed env
config, static files, SSE, graceful shutdown - and beside http: [`@azerothjs/schema`](packages/schema)
validation, typed API contracts with a fully inferred client (`@azerothjs/http/api`),
[`@azerothjs/ws`](packages/ws) WebSockets, [`@azerothjs/cron`](packages/cron) scheduling, and
[`@azerothjs/logger`](packages/logger). The same fine-grained discipline, the whole way down.

---

## 🛠️ One CLI

`azeroth` understands every project shape - frontend, backend, or fullstack - by looking at what
exists, with **no config file**:

| Command | What it does |
| --- | --- |
| `azeroth dev` | The fullstack conductor: server watch + Vite, one banner, one Ctrl+C |
| `azeroth check` | Every gate the shape demands: `azeroth-tsc`, `tsc --noEmit`, ESLint |
| `azeroth build` | Deployable artifacts in dependency order (a native backend has none, by design) |
| `azeroth test` | Each half's Vitest suite (server first) |
| `azeroth upgrade` | Move every AzerothJS pin to a target version, install, and run the doctor |
| `azeroth doctor` | Diagnose the environment against a catalog of real-world failures |
| `azeroth info` | A paste-able environment block for bug reports |

Add `--print` to any command to see the exact child invocations and exit - nothing hidden, nothing to eject.

---

<a id="packages"></a>

## 📦 Packages

Everything is versioned in lockstep under the release contract in
[VERSIONING.md](VERSIONING.md) - one version across every package and both editor
integrations, breaking changes only in milestone-driven majors, deprecations
announced a full major cycle before removal. `azerothjs` is the one package a
frontend installs; the `@azerothjs/*` scope holds the backend stack, the
compiler, and the tooling.

| Package | Purpose |
| --- | --- |
| [`azerothjs`](packages/azerothjs) | **The frontend framework - one real package.** Signals/memos/effects + owner tree, `h()` and the control-flow components, stores, forms, the router, and SSR (`renderToString`/islands). |
| [`@azerothjs/compiler`](packages/compiler) | The `.azeroth` compiler + the `azeroth()` Vite plugin (dev dependency). |
| [`@azerothjs/http`](packages/http) | Zero-dependency web-standard HTTP kernel; every request is a reactive root. Typed API contracts with a fully inferred client live at `@azerothjs/http/api`. |
| [`@azerothjs/kit`](packages/kit) | The assembled car: per-route SSR, static prerendering, and hydration over the router's route table, the renderer, and the HTTP server. |
| [`@azerothjs/schema`](packages/schema) | Validation combinators whose TypeScript types are inferred from the declaration. |
| [`@azerothjs/ws`](packages/ws) | WebSocket server implementing RFC 6455 from scratch. |
| [`@azerothjs/cron`](packages/cron) | Cron scheduler with honest timezone/DST semantics and overlap policies. |
| [`@azerothjs/logger`](packages/logger) | Two-face logger: pretty on a dev TTY, NDJSON elsewhere; plus the startup banner. |
| [`@azerothjs/cli`](packages/cli) | The `azeroth` command line: `dev`, `check`, `build`, `test`, `upgrade`, `doctor`, `info`. |
| [`create-azeroth`](packages/create-azeroth) | `npm create azeroth` - frontend / backend / fullstack templates with the canon wired in. |
| [`@azerothjs/testing`](packages/testing) | `renderTest`, `cleanup`, `leakGuard`, `fire` for app tests. |
| [`@azerothjs/devtools`](packages/devtools) | Dev-only in-page panel: reactive tree, dependency graph, timeline. |
| [`@azerothjs/eslint-plugin`](packages/eslint-plugin) | Reactivity lint rules + a processor that makes `.azeroth` a first-class lint target. |
| [`@azerothjs/language-server`](packages/language-server) | LSP frontend + the `azeroth-tsc` CLI type checker. |
| [`@azerothjs/typescript-plugin`](packages/typescript-plugin) | tsserver plugin: real `.azeroth` types inside `.ts` files. |

---

<a id="editors"></a>

## 🧭 Editor support

| Editor | What you get |
| --- | --- |
| [**VS Code**](editors/vscode) | Bundled language server (no Node required), tsserver plugin auto-wired, semantic highlighting, cross-file navigation and rename, inlay hints, formatting. |
| [**JetBrains**](editors/jetbrains) (WebStorm, IDEA Ultimate, ...) | Native `.azeroth` language + the same language server over LSP; usage-aware inspections (a `.ts` export used only from `.azeroth` is not "unused"), themeable reactive colors. |

---

## 🧪 Testing

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

---

<details>
<summary><b>🏗️ Developing this repository</b></summary>

<br/>

An npm-workspaces monorepo, Node >= 22.

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

</details>

---

<div align="center">
<sub>Released under the <a href="LICENSE">MIT License</a>.</sub>
</div>
