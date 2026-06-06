# @azerothjs/language-server

## Overview

A [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)
frontend for `.azeroth` files. It is a thin adapter: it owns the LSP connection
and the document lifecycle and forwards every request to
[`@azerothjs/language-service`](../language-service), which contains all the
intelligence (the TypeScript bridge, the markup model, and the providers).

Editors that speak LSP (the VS Code extension and the JetBrains plugin in this
repository, among others) launch this server and talk to it over stdio.

## Architecture

The server holds one `AzerothLanguageService` for the workspace and a
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
| `index.ts` | Library entry point; exports `startServer` and `runTsc`. |

### `azeroth-tsc` (command-line type checking)

`tsc` cannot parse `.azeroth`, so this package ships `azeroth-tsc`, the `vue-tsc`
equivalent. It reuses the language service to compile each `.azeroth` file to its
virtual TypeScript module, type-check it against the project's tsconfig, and print
`tsc`-style diagnostics mapped back to the original `.azeroth` positions, exiting
non-zero on the first error. It is a `--noEmit` gate (the Vite plugin / compiler
owns code emit), meant to run in CI and pre-commit beside `tsc`:

```sh
npx azeroth-tsc            # check every .azeroth file under the cwd
npx azeroth-tsc -p tsconfig.json
```

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

## Building

```sh
npm run build -w @azerothjs/language-server
```

This runs `tsc -p tsconfig.build.json` and emits `dist/`, including the
`azeroth-language-server` binary referenced by `bin`. It depends on
`@azerothjs/language-service` being built first; the repository root
`npm run build` builds packages in dependency order.

For distribution inside an editor, the server and its dependencies are bundled
into a single file by the editor's build step (see `editors/vscode/esbuild.mjs`).

## Testing

The server is exercised indirectly through the language-service test suite, which
covers the request handling by driving the service the server forwards to:

```sh
npm test
```

## Configuration

Configuration is supplied by the client through `initializationOptions` and
`workspace/configuration`. TypeScript intelligence uses the nearest
`tsconfig.json` in the workspace, resolved by the language service.

## Contributing

A new feature usually means a new method on `AzerothLanguageService` in the
language-service package plus a new handler here that registers the capability
and forwards to it. Keep this package free of language logic; if a handler starts
making language decisions, that logic belongs in the service. See the
[language-service README](../language-service/README.md) for the full
architecture.
