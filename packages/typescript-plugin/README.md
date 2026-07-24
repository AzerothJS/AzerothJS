<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/typescript-plugin

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Ftypescript-plugin?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/typescript-plugin)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework.

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

The plugin reuses the same projection as the editor language server
(`@azerothjs/language-service`): a `.azeroth` file is compiled to a virtual
TypeScript module whose markup is rewritten to `h()` calls and whose surrounding
code - every `export` included - is preserved verbatim. Two decorations make
that seamless inside `tsserver`:

- **Resolution + loading**: an import of `./x.azeroth` (or the extensionless
  `./x`) resolves to the REAL on-disk `.azeroth` path, whose content is served
  as the compiled virtual module - so TypeScript infers real types across the
  `.ts` -> `.azeroth` boundary.
- **Result-span remapping**: navigation results that land inside a `.azeroth`
  file (Find References, Go to Definition, Rename, highlights) are translated
  from virtual-code offsets back to SOURCE offsets through the projection's
  offset mapping - so references select the exact identifier, definitions land
  on the `component` name, and a cross-file rename edits the right ranges.

## Scope: editors, not `tsc`

TypeScript language-service plugins run **only inside `tsserver`** (editors), not
inside the command-line `tsc`. This is a TypeScript limitation, not a choice
here - it is also why `vue-tsc` exists. So:

- In the editor, this plugin gives real `.azeroth` types with no shim.
- For a command-line type-check gate, use `azeroth-tsc` (from
  `@azerothjs/language-server`) - the combined `.ts` + `.azeroth` checker (the
  `vue-tsc` equivalent): it type-checks `.ts` files with `.azeroth` imports
  resolved to real types, and `.azeroth` files themselves.

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
