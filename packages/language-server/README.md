<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/language-server

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Flanguage-server?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/language-server)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework. Applications usually install [`azerothjs`](https://www.npmjs.com/package/azerothjs); depend on this package directly for a narrower surface.

## Overview

A [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)
frontend for `.azeroth` files. It is a thin adapter: it owns the LSP connection
and the document lifecycle and forwards every request to
[`@azerothjs/language-service`](https://www.npmjs.com/package/@azerothjs/language-service), which contains all the
intelligence (the TypeScript bridge, the markup model, and the providers).

Editors that speak LSP (the VS Code extension and the JetBrains plugin in this
repository, among others) launch this server and talk to it over stdio.

## Install

```sh
npm install -D @azerothjs/language-server
```

## Architecture

The server holds one `AzerothLanguageService` **per workspace root** (multi-root
aware: each document resolves against the service whose root is its longest
matching prefix - its nearest project - so files in different roots type-check
against their own `tsconfig`; roots added/removed at runtime are tracked via
`workspace/didChangeWorkspaceFolders`) and a
document manager (`vscode-languageserver`'s `TextDocuments`). Text changes are
mirrored into the service with `didOpen`/`didChange`/`didClose`, and each LSP
request handler calls the matching service method and returns the result almost
unchanged, because the service's result types already mirror the LSP shapes.

```
editor  --LSP/stdio-->  language-server  --method calls-->  language-service
                        (this package)                      (the intelligence)
```

The split keeps protocol concerns (connection, capability negotiation, document
sync, settings) separate from language concerns (the TypeScript bridge, the
markup model). The same service instance also powers the unit test suite and can
back any other host without this package.

## Components

| File | Role |
| --- | --- |
| `server.ts` | LSP wiring: connection, capabilities, document sync, settings, and one handler per request. |
| `cli.ts` | Executable entry point (`azeroth-language-server`); starts the server over stdio. |
| `tsc.ts` | `runTsc`: the batch type-checker behind the `azeroth-tsc` binary. |
| `tsc-cli.ts` | Executable entry point (`azeroth-tsc`); runs one check and sets the exit code. |
| `index.ts` | Library entry point; exports `startServer`, the settings API (`parseSettings`, `AzerothSettings`, `FeatureToggles`), and the CLI helpers (`runTsc`, `watchTsc`, `parseArgs`, `runDocgen`). |

### `azeroth-tsc` (combined command-line type checking)

`tsc` cannot parse `.azeroth`, so this package ships `azeroth-tsc`, the `vue-tsc`
equivalent. It builds ONE TypeScript program containing BOTH the project's real
`.ts` files AND every `.azeroth` file (compiled to its virtual TypeScript module
by the language service). Because both live in the same program:

- a `.ts` file importing `'./x.component.azeroth'` resolves the component's REAL
  default, named, and type exports - no `declare module '*.azeroth'` shim;
- `.azeroth` <-> `.azeroth` and `.azeroth` <-> `.ts` imports resolve both ways;
- `.azeroth` internals (including typed component tags) are checked;
- diagnostics map back to original `.ts`/`.azeroth` positions.

It is a `--noEmit` gate (the Vite plugin / compiler owns code emit) that
REPLACES `tsc`:

```sh
npx azeroth-tsc            # check the whole project (.ts + .azeroth)
npx azeroth-tsc -p tsconfig.json
npx azeroth-tsc --watch    # re-check on change (alias: -w)
```

#### Build wiring

One checker covers the whole project, so the canonical consumer build is just
the checker plus the bundler:

```jsonc
// package.json
{
    "scripts": {
        "build": "azeroth-tsc && vite build",
        "typecheck": "azeroth-tsc",
        "dev:check": "azeroth-tsc --watch"
    }
}
```

With Vite installed, the consumer needs no `declare module '*.azeroth'` shim and
no `vite-env.d.ts` / `"types": ["vite/client"]` entry: `import.meta.env`,
`*.png` / `?url` asset imports, and cross-file `.azeroth` types all resolve.
`@azerothjs/typescript-plugin` gives the editor's TypeScript server the same
`.ts` -> `.azeroth` resolution live; `azeroth-tsc` is the matching CI/pre-commit
gate.

### Settings

On initialization the server reads `initializationOptions` and, when the client
supports it, pulls live configuration with `workspace/configuration`. Settings
map onto the service's per-feature options (for example completion auto-imports,
component snippets, and inlay-hint toggles). Clients that push configuration
changes trigger a refresh and a re-publish of diagnostics.

### Diagnostics

Diagnostics are pushed (`textDocument/publishDiagnostics`) when a document opens
or changes, rather than pulled, so errors appear as the user types. Each carries
its `source` (`azeroth` for markup parse errors, `azeroth-ts` for TypeScript
errors) from the service.

## Running

Editors launch the bundled binary over stdio:

```sh
azeroth-language-server --stdio
```

Or embed it (for example in a test or a web host):

```ts
import { startServer } from '@azerothjs/language-server';
import { createConnection } from 'vscode-languageserver/node.js';

startServer(createConnection(/* your reader/writer */));
```

## Capabilities

Completion (with resolve), hover, definition, type-definition, references,
document highlights, rename, document symbols, workspace symbols, signature help,
full semantic tokens, folding ranges, selection ranges, code actions, document
and on-type formatting, inlay hints, and push diagnostics. A non-standard
`azeroth/autoInsert` request backs auto-close-tag and linked-editing behavior in
clients that wire it up.

The legend for semantic tokens is `component`, `tag`, `attribute`, `event`,
`string`, `delimiter`, with no modifiers. Editors must register the same legend
so these token types get themed.


## Configuration

Configuration is supplied by the client through `initializationOptions` and
`workspace/configuration`. TypeScript intelligence uses the nearest
`tsconfig.json` in the workspace, resolved by the language service.

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
