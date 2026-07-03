# AzerothJS for VS Code

Full language support for `.azeroth` single-file components - powered by the
AzerothJS compiler, not heuristics.

## Requirements

| Requirement | Minimum |
| --- | --- |
| VS Code | 1.84 |
| Node.js | not required (the language server is bundled) |

## Installation

**From the VS Code Marketplace** (recommended): search for **AzerothJS** in the
Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`) and click Install, or visit the
[extension page](https://marketplace.visualstudio.com/items?itemName=azerothjs.azerothjs-vscode).

**From a `.vsix` file**: open the Extensions view, click the `...` menu, choose
*Install from VSIX...*, and select the file. Alternatively:

```sh
code --install-extension azerothjs-vscode-<version>.vsix
```

## Features

Intelligence is provided by the bundled AzerothJS language server, which reuses
the framework's own compiler for accurate, compiler-aware analysis:

| Feature | Details |
| --- | --- |
| **Completion** | HTML tags and user/built-in components in tag position; attributes and DOM events in attribute position; CSS in inline `style` values; full type-aware TypeScript completion inside `{ ... }` expression holes. |
| **Hover** | Types, signatures, and JSDoc - including the runtime's built-in components (`Show`, `For`, `Switch`, `Dynamic`, `Suspense`, `Portal`, `ErrorBoundary`). |
| **Diagnostics** | Markup parse errors from the compiler, plus TypeScript type errors inside expressions and script. Errors describe what is wrong, why, and how to fix it. |
| **Go to definition / type definition** | Works across `.azeroth` and `.ts` files. |
| **Find references & rename** | Cross-file, across `.azeroth` and `.ts`. |
| **Go to Implementation** | Navigates from an interface to its concrete implementations. |
| **Symbols** | Document symbols (outline) and workspace-wide symbol search. |
| **Semantic highlighting** | Distinguishes components, host tags, reactive state, event attributes, and expression holes by token type. |
| **Inlay hints** | Parameter names and inferred types at call sites. |
| **Signature help** | Shows the active parameter as you type function arguments. |
| **Folding ranges** | Collapses component blocks, markup subtrees, and script regions. |
| **Quick fixes** | Compiler-driven code actions for common diagnostics. |
| **Formatting** | Full document and range (Format Selection) formatting. |
| **Editing aids** | Tag auto-close on `>` and `/>`, linked editing of matching opening/closing tags. |

### Third-party tooling - zero config

The extension pre-wires common companion tools so a project needs **no
`.vscode/settings.json`**:

- **ESLint** (`dbaeumer.vscode-eslint`): `eslint.validate` includes `azeroth`, so
  ESLint runs `@azerothjs/eslint-plugin` on `.azeroth` files (script is linted;
  markup is masked from ESLint rules). `.js`/`.ts` validation is unaffected.
- **Tailwind CSS** (`bradlc.vscode-tailwindcss`): `tailwindCSS.includeLanguages`
  maps `azeroth` to `html` (its own language - not jsx/tsx), plus `classRegex`
  entries so `class="..."`, `class={...}`, and `classList({ '...': ... })` all complete.

These are *defaults* - a user setting of the same key overrides them. The
companion extensions are recommended, not bundled; nothing breaks if they are
absent.

## Configuration

Settings live under the `azeroth.*` namespace and are accessible through
*Settings -> Extensions -> AzerothJS*. They cover per-feature toggles such as
completion auto-imports, component snippets, and inlay hints. TypeScript
intelligence uses the nearest `tsconfig.json` in the workspace.

## Quick start

1. Install the extension.
2. Open any `.azeroth` file - the language server activates automatically.
3. For a hands-on tour, open `packages/compiler/examples/Showcase.azeroth` and
   try completion, hover, and go-to-definition.

Use **AzerothJS: Restart Language Server** (`Ctrl+Shift+P`) if the server ever
gets into a bad state.

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

## Development

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
# Bundle extension + server into self-contained dist/*.js (esbuild)
npm run bundle -w azerothjs-vscode

# Build a self-contained .vsix in dist/ (bundles, then vendors TypeScript)
npm run package -w azerothjs-vscode

# Build the .vsix and immediately install it into VS Code
npm run install-extension -w azerothjs-vscode
```

**Why a staging step?** `vsce` cannot resolve a hoisted `typescript` dependency
from inside an npm workspace, so `package.mjs` stages a standalone copy of the
extension outside the monorepo before running `vsce`.

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
