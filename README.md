# AzerothJS

A TypeScript UI framework built on fine-grained reactivity with no Virtual DOM:
signals drive effects that update real DOM nodes in place. Components are plain
functions that return markup; a small compiler turns `.azeroth` single-file
components into `h()` calls, and a language service gives editors full
type-aware intelligence for them.

Status: 0.4.0-beta. The API is close to stable but may still change before 1.0.

## Why AzerothJS

AzerothJS is, first, a framework to **learn from**. Every layer — signals, the
DOM renderer, the `.azeroth` compiler, the language service, the LSP server — is
written from scratch with no hidden runtime magic, so you can read it end to end
and understand exactly how a modern reactive framework works: how a signal
re-runs an effect, how markup becomes `h()` calls, how an editor gets type-aware
completion for a custom file format. The source is meant to be studied, not just
imported.

It is also a framework you can **build real things with**. The reactivity is
fine-grained and the renderer touches the DOM directly (no Virtual DOM diff), so
it stays fast in practice, and the packages below cover what a real application
needs: routing, stores, forms, server-side rendering, a Vite build plugin, and
full editor tooling. Start by reading the code to learn the ideas; reach for the
published packages when you want to ship.

## Packages

All packages are published under the `@azerothjs` scope and versioned in
lockstep.

| Package | Purpose |
| --- | --- |
| `@azerothjs/reactivity` | Signals, effects, memos, `batch`, `untrack`, resources, the SSR/hydration primitives. |
| `@azerothjs/renderer` | `h()` and the DOM renderer; `Show`, `For`, `Switch`, `Portal`, `Dynamic`, `Suspense`, `classList`, `styleMap`, `css`. |
| `@azerothjs/component` | `defineComponent`, the `AzerothComponent` class base, and lifecycle hooks. |
| `@azerothjs/store` | A minimal reactive state container with a lazy-singleton lifetime. |
| `@azerothjs/form` | Reactive form state: validation, submit lifecycle, per-field state. |
| `@azerothjs/router` | Fine-grained reactive client-side routing with nested layouts. |
| `@azerothjs/server` | Server-side rendering: `renderToString`, `renderToStaticMarkup`, `renderToDocument`. |
| `@azerothjs/compiler` | The `.azeroth` single-file-component compiler and the Vite plugin. |
| `@azerothjs/core` | Umbrella package re-exporting the runtime APIs. |
| `@azerothjs/language-service` | Compiler-aware editor intelligence for `.azeroth` (completion, hover, diagnostics, navigation). |
| `@azerothjs/typescript-plugin` | A TypeScript language-service plugin so `tsserver` resolves `.azeroth` imports with real types. |
| `@azerothjs/language-server` | A Language Server Protocol front-end, plus the `azeroth-tsc` command-line checker. |

Editor integrations live under `editors/` (a VS Code extension and a JetBrains
plugin) and are not published to npm.

## Install

```sh
npm i @azerothjs/core
```

While the project is in beta, `npm i @azerothjs/core` installs the current
beta release (the `latest` dist-tag tracks the newest release until a stable
1.0 ships). The `@azerothjs/*` packages share one version, so install the same
version across them.

## A component

A `.azeroth` file is a TypeScript module with JSX-style markup. Components are
plain functions; props are the first argument.

```tsx
import { createSignal, classList } from '@azerothjs/core';

export default function Counter(props: { start?: number })
{
    const [count, setCount] = createSignal(props.start ?? 0);

    return (
        <button
            class={classList({ btn: true, positive: () => count() > 0 })}
            onClick={() => setCount(c => c + 1)}
        >
            Count: {count()}
        </button>
    );
}
```

`{count()}` is reactive because it reads a signal; when `count` changes, only
that text node updates. `classList`/`styleMap` build reactive `class`/`style`
strings. There is no `defineComponent` wrapper for function components.

## Build integration (Vite)

The compiler ships a Vite plugin that compiles `.azeroth` files during a build:

```ts
import { azeroth } from '@azerothjs/compiler';

export default {
    plugins: [azeroth()]
};
```

## Type checking and editors

`tsc` cannot parse `.azeroth`, so the toolchain provides two complementary
pieces:

- `azeroth-tsc` (from `@azerothjs/language-server`) type-checks `.azeroth` files
  on the command line, mapping diagnostics back to original positions. Run it in
  CI alongside `tsc`:

  ```sh
  npx azeroth-tsc            # check every .azeroth file
  npx azeroth-tsc --watch    # re-check on change
  ```

  A canonical consumer build is `tsc --noEmit && azeroth-tsc && vite build`.

- `@azerothjs/typescript-plugin`, registered in `tsconfig.json`, makes the
  editor's TypeScript server resolve `.azeroth` imports from `.ts` files with
  their real exported types (no `declare module '*.azeroth'` shim needed):

  ```json
  { "compilerOptions": { "plugins": [{ "name": "@azerothjs/typescript-plugin" }] } }
  ```

The VS Code extension and JetBrains plugin under `editors/` bundle the language
server and contribute the TypeScript plugin.

## Development

This is an npm-workspaces monorepo.

```sh
npm install
npm run build        # build all packages in dependency order
npm test             # run the Vitest suite
npm run lint         # ESLint
```

Tests live under `test/`. The release flow is scripted in `scripts/release.mjs`
(`npm run release -- <version>`); see `DECISIONS.md` for the non-obvious design
decisions behind the compiler, language service, and tooling.

## License

MIT. See `LICENSE`.
