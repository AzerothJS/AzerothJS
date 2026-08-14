<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="140" />

# AzerothJS

### The fine-grained, fullstack TypeScript framework

<p>
  <a href="https://www.npmjs.com/package/azerothjs"><img src="https://img.shields.io/npm/v/azerothjs?color=2ea44f&label=azerothjs" alt="npm" /></a>
  <a href="https://github.com/AzerothJS/AzerothJS/actions/workflows/ci.yml"><img src="https://github.com/AzerothJS/AzerothJS/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node >= 22" /></a>
</p>

<p>
  <b><a href="#quick-start">Quick start</a></b> |
  <b><a href="#why-azerothjs">Why</a></b> |
  <b><a href="#architecture">Architecture</a></b> |
  <b><a href="#packages">Packages</a></b> |
  <b><a href="#editor-support">Editors</a></b>
</p>

</div>

---

AzerothJS compiles components to code that updates the DOM directly. There is no virtual DOM and
no diffing: a signal write re-runs exactly the effects that read it, and each effect owns the
specific nodes it wrote.

Components live in `.azeroth` files as `component` blocks. The compiler lowers each one to a
single mode-aware artifact through one intermediate representation, so the same component clones
DOM on the client, serializes HTML on the server, and adopts that HTML on hydration.

```azeroth
export default component Counter(props: { start?: number })
{
    state count = props.start ?? 0;
    derived parity = count % 2 === 0 ? 'even' : 'odd';

    <button class="btn" class:positive={ count > 0 } onClick={ () => count++ }>
        Count: { count } ({ parity })
    </button>
}
```

`{ count }` updates only its own text node. Nothing re-renders, nothing is diffed, and `count++`
is a plain write the compiler wires into the reactive graph.

---

<a id="quick-start"></a>

## Quick start

```sh
npm create azeroth@latest my-app
cd my-app && npm install && npm run dev
```

The scaffolder asks for a shape - frontend, backend, or fullstack - and wires the whole toolchain,
so `npm run dev` and `azeroth check` work immediately.

<details>
<summary><b>... or wire an existing Vite project by hand</b></summary>

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

The Vite plugin compiles `.azeroth` files with build-time lint, semantic diagnostics, and real
TypeScript type checking. `azerothjs` is the only runtime import an application needs.

</details>

---

<a id="why-azerothjs"></a>

## Why AzerothJS

- **Fine-grained by construction.** A signal write re-runs the effects that read it and nothing
  else. There is no component re-render to optimize around and no dependency array to maintain.
- **A language, not a convention.** `state`, `derived`, `effect`, `form`, `store`, `resource`,
  `stream`, `selector` and `deferred` are keywords in `.azeroth` files. Reads and writes stay
  ordinary TypeScript; the compiler supplies the reactivity.
- **One file, three languages, no dialects.** A `style { }` section holds plain CSS, and the
  compiler rewrites its `.card` and the markup's `class="card"` to the same scoped name. HTML
  stays HTML, CSS stays CSS, TypeScript stays TypeScript; the file only composes them.
- **One artifact, three modes.** Client render, server serialization and hydration come from one
  emitter over one IR, so the hydration markers line up by construction rather than by review.
- **Editor tooling at framework grade.** A compiler-powered language server drives both editor
  integrations: completion, hover documentation for every keyword, definition and references
  across the `.ts` and `.azeroth` boundary, cross-file rename, and semantic highlighting that
  colours reactive names distinctly.
- **No hidden runtime.** The signal graph, the renderer, the compiler and the server stack are
  written from scratch with no third-party dependencies, and are small enough to read when you
  need to know exactly what runs.

---

<a id="architecture"></a>

## Architecture

The compiler runs five stages, each a separate module: **parse** the `.azeroth` source into a
module AST, **analyze** each component for the reactive sources every scope reads, **lower** the
markup and that analysis into a Render Plan IR, **optimize** the IR, and **emit** JavaScript from
it.

Because the IR is target-independent, the three render modes are three readings of one plan rather
than three code paths that must be kept in step. The runtime half mirrors that discipline: every
reactive node has an owner, so disposal is exact, and on the server every request runs inside a
reactive root, which keeps stores isolated per request across `await`.

---

<a id="packages"></a>

## Packages

Every package ships from this repository and is versioned in lockstep under the contract in
[VERSIONING.md](VERSIONING.md). `azerothjs` is the only package a frontend installs.

**Runtime**

| Package | Purpose |
| --- | --- |
| [`azerothjs`](packages/azerothjs) | The framework: signals, memos and effects with an owner tree, `h()` and the control-flow components, stores, forms, the router, and SSR. |

**Compiler and editor tooling**

| Package | Purpose |
| --- | --- |
| [`@azerothjs/compiler`](packages/compiler) | The `.azeroth` compiler and the `azeroth()` Vite plugin. A dev dependency. |
| [`@azerothjs/language-server`](packages/language-server) | LSP server plus the `azeroth-tsc` command-line type checker. |
| [`@azerothjs/typescript-plugin`](packages/typescript-plugin) | tsserver plugin, so `.ts` files see real `.azeroth` types. |
| [`@azerothjs/eslint-plugin`](packages/eslint-plugin) | Reactivity lint rules and a processor that makes `.azeroth` a lint target. |
| [`@azerothjs/devtools`](packages/devtools) | Dev-only in-page panel: reactive tree, dependency graph, timeline. |

**Server and fullstack**

| Package | Purpose |
| --- | --- |
| [`@azerothjs/http`](packages/http) | Web-standard HTTP kernel where every request is a reactive root. Typed API contracts with an inferred client live at `@azerothjs/http/api`. |
| [`@azerothjs/kit`](packages/kit) | Per-route SSR, static prerendering and hydration over the router's route table. |
| [`@azerothjs/schema`](packages/schema) | Validation combinators whose TypeScript types are inferred from the declaration. |
| [`@azerothjs/ws`](packages/ws) | WebSocket server implementing RFC 6455 from scratch. |
| [`@azerothjs/cron`](packages/cron) | Cron scheduler with explicit timezone, DST and overlap semantics. |
| [`@azerothjs/logger`](packages/logger) | Two-face logger: readable on a dev TTY, NDJSON elsewhere. |

**Developer tooling**

| Package | Purpose |
| --- | --- |
| [`@azerothjs/cli`](packages/cli) | The `azeroth` command: `dev`, `check`, `build`, `test`, `upgrade`, `doctor`, `info`. It detects the project shape, with no config file. |
| [`create-azeroth`](packages/create-azeroth) | `npm create azeroth` - frontend, backend and fullstack templates. |
| [`@azerothjs/testing`](packages/testing) | `renderTest`, `cleanup`, `leakGuard` and `fire` for application tests. |

---

<a id="editor-support"></a>

## Editor support

| Editor | What you get |
| --- | --- |
| [**VS Code**](editors/vscode) | Bundled language server needing no local Node, tsserver plugin wired automatically, semantic highlighting, cross-file navigation and rename, inlay hints, formatting. |
| [**JetBrains**](editors/jetbrains) | Native `.azeroth` language support plus the same language server over LSP, and usage-aware inspections that understand a `.ts` export used only from `.azeroth`. |

---

## Status

AzerothJS is in beta. The published version is `2.1.0-beta.1`: the API surface is settled and the
full suite runs green on every commit, but the release contract in [VERSIONING.md](VERSIONING.md)
does not freeze until 2.1.0 proper.

Until the documentation site is published, each package README is the reference for that package.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers the workspace layout, the gates a change has to pass,
and how releases are cut. See also [SECURITY.md](SECURITY.md) for reporting a vulnerability,
[SUPPORT.md](SUPPORT.md) for getting help, [GOVERNANCE.md](GOVERNANCE.md) for how decisions are
made, and [CHANGELOG.md](CHANGELOG.md) for what has changed.

## License

[MIT](LICENSE).
