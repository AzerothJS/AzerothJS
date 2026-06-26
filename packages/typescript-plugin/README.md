# @azerothjs/typescript-plugin

## Overview

A TypeScript language-service plugin that teaches `tsserver` (the engine behind
VS Code's built-in TypeScript support, and any editor that uses it) to resolve
`.azeroth` imports from `.ts` files with their REAL exported types -
default, named, and type exports. It is the AzerothJS counterpart to
`@vue/typescript-plugin`.

With the plugin installed a consuming app can delete its hand-written
`declare module '*.azeroth'` shims: a barrel like

```ts
export { default as Breadcrumb } from './breadcrumb.component.azeroth';
export type { BreadcrumbCrumb } from './breadcrumb.component.azeroth';
```

type-checks against the component's actual signature instead of `any`.

## Install

```sh
npm i -D @azerothjs/typescript-plugin
```

Register it in the consuming project's `tsconfig.json`:

```json
{
    "compilerOptions": {
        "plugins": [{ "name": "@azerothjs/typescript-plugin" }]
    }
}
```

In VS Code, also select **"Use Workspace Version"** of TypeScript (or rely on
the AzerothJS VS Code extension, which contributes the plugin automatically), so
the editor's TypeScript server loads the plugin.

## How it works

The plugin reuses the same virtual-code pipeline as the editor language server
(`@azerothjs/language-service`): a `.azeroth` file is compiled to a virtual
TypeScript module whose markup is rewritten to `h()` calls and whose surrounding
code - every `export` included - is preserved verbatim. The plugin decorates the
host so that:

- an `import './x.azeroth'` specifier resolves to a synthetic `x.azeroth.ts`;
- loading that synthetic file returns the compiled virtual module.

Because the virtual module carries the file's real exported declarations,
TypeScript infers real types across the `.ts` -> `.azeroth` boundary.

## Scope: editors, not `tsc`

TypeScript language-service plugins run **only inside `tsserver`** (editors), not
inside the command-line `tsc`. This is a TypeScript limitation, not a choice
here - it is also why `vue-tsc` exists. So:

- In the editor, this plugin gives real `.azeroth` types with no shim.
- For a command-line type-check gate, use `azeroth-tsc` (from
  `@azerothjs/language-server`) — the combined `.ts` + `.azeroth` checker (the
  `vue-tsc` equivalent): it type-checks `.ts` files with `.azeroth` imports
  resolved to real types, and `.azeroth` files themselves.

## Building

```sh
npm run build -w @azerothjs/typescript-plugin
```

`tsserver` loads plugins with `require()`, so the entry must be CommonJS; the
AzerothJS packages it reuses are ESM. `esbuild` bundles `src/index.ts` and those
ESM dependencies into a single self-contained `dist/index.js` (with `typescript`
left external - `tsserver` passes its own copy to the plugin factory).

## Testing

```sh
npx vitest run test/typescript-plugin
```

The test drives the plugin's host decoration through a constructed
`ts.LanguageService` (what `tsserver` builds) over a fixture with no `.azeroth`
shim, asserting default/named/type imports resolve and that a genuine type error
still surfaces.
