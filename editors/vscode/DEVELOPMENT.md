# Developing the VS Code extension

This file is for contributors; the shipped `README.md` is the Marketplace listing.

## Architecture

The extension is a thin LSP client; all analysis lives in the server.

```
VS Code  --LSP/stdio-->  language server  -->  language service (compiler-aware)
   |
   contributes: language registration, language-configuration.json,
                source.azeroth TextMate grammar, semantic-token legend, settings
```

Three pieces work together:

- **`package.json`** - registers the `azeroth` language for `.azeroth`, the
  `source.azeroth` TextMate grammar, the semantic-token legend, and the
  configuration schema with defaults.
- **`language-configuration.json`** - brackets, comments, auto-closing pairs,
  indentation rules, and on-enter rules.
- **`src/extension.ts`** - starts the server over stdio via `vscode-languageclient`
  and wires the non-standard `azeroth/autoInsert` request to the editor's
  auto-insert hook for tag auto-close.

The extension itself contains no language logic. The only custom protocol is
`azeroth/autoInsert`, which the extension calls on type to get a closing tag from
the service.

## Source layout

| Path | Role |
| --- | --- |
| `package.json` | Language, grammar, semantic-token legend, settings schema, and defaults. |
| `language-configuration.json` | Brackets, comments, auto-closing pairs, indentation, on-enter rules. |
| `syntaxes/azeroth.tmLanguage.json` | Native `source.azeroth` TextMate grammar. |
| `src/extension.ts` | Language client startup and the auto-insert wiring. |
| `esbuild.mjs` | Bundles the extension and the server into self-contained `dist/*.js`. |
| `package.mjs` | Builds and optionally installs a self-contained `.vsix`. |

## Development loop

Open `editors/vscode` in VS Code and press **F5** (Run Extension). The
development host loads the server from the workspace, so changes to the server or
service are picked up on reload without re-packaging.

```sh
# Type-check the extension sources (from the monorepo root)
npm run typecheck -w azerothjs-vscode
```

## Building

Run all commands from the **monorepo root** unless noted otherwise.

```sh
npm run bundle -w azerothjs-vscode             # esbuild -> self-contained dist/*.js
npm run package -w azerothjs-vscode            # -> dist/azerothjs-vscode-<version>.vsix
npm run install-extension -w azerothjs-vscode  # package + install into VS Code
```

**Why a staging step?** `vsce` cannot resolve a hoisted `typescript` dependency
from inside an npm workspace, so `package.mjs` stages a standalone copy of the
extension outside the monorepo before running `vsce`.

**Same-version reinstalls silently keep old files.** When iterating on an
unchanged version: uninstall, remove the stale
`~/.vscode/extensions/azerothjs.azerothjs-vscode-*` directory, then install.

**Releases** are cut from the monorepo root with `npm run release -- <version>`
(see `scripts/release.mjs`). The extension is versioned in lockstep with the
`@azerothjs/*` packages it depends on.

## Testing

Language features are covered by the `@azerothjs/language-service` test suite at
the repository root (`npm test`). The extension layer itself is thin; verify it by
running the development host (F5) against a `.azeroth` file.

## Contributing

Keep this package a thin client. Editor-visible behaviour that depends on language
analysis belongs in `@azerothjs/language-service`; the extension should only
register contributions and route requests. When the server gains a new capability,
the LSP client picks it up through capability negotiation - no extension change is
needed. Changes here are limited to settings, grammar tweaks, and editing hooks.

See [CONTRIBUTING.md](https://github.com/AzerothJS/AzerothJS/blob/main/CONTRIBUTING.md)
for the full workflow.
