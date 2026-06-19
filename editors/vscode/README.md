# AzerothJS for VS Code

## Overview

Language support for `.azeroth` files, the AzerothJS single-file component format
(a TypeScript module with AzerothJS markup).

The extension is a launcher for the AzerothJS language server
(`@azerothjs/language-server`), which reuses the framework's own compiler to
provide compiler-aware intelligence rather than heuristics:

- Context-aware completion: HTML tags and built-in or user components in tag
  position, attributes and DOM events in attribute position, CSS in inline
  `style` values, and full type-aware TypeScript completion inside `{ ... }`
  expression holes.
- Hover with types, signatures, and JSDoc, including the runtime's built-in
  components.
- Diagnostics: markup parse errors from the compiler, plus TypeScript type errors
  inside expressions and script.
- Go to definition and type definition, find references, and rename symbol,
  across `.azeroth` and `.ts` files.
- Document and workspace symbols, signature help, semantic highlighting, folding
  ranges, quick fixes, formatting, and inlay hints.
- Editing aids: tag auto-close and linked editing of matching tags.

## Architecture

The extension contributes editor metadata and starts the language server; all
analysis happens in the server.

```
VS Code  --LSP/stdio-->  language server  -->  language service (compiler-aware)
   |
   contributes: language registration, language-configuration.json,
   native source.azeroth TextMate grammar, semantic-token legend, settings
```

Three pieces work together:

- Static contributions in `package.json` register the `azeroth` language for
  `.azeroth`, a native `source.azeroth` TextMate grammar
  (`syntaxes/azeroth.tmLanguage.json`) that provides base highlighting for the
  whole file (script + AzerothJS markup), the semantic-token legend, and the
  configuration schema.
- `language-configuration.json` defines brackets, comments, auto-closing pairs,
  indentation, and on-enter rules.
- `src/extension.ts` starts the server over stdio with `vscode-languageclient`
  and wires the non-standard `azeroth/autoInsert` request to the editor's
  auto-insert hook for tag auto-close.

### How it interacts with the language server and service

VS Code is a generic LSP client here. On activation the extension launches the
bundled server, hands over capability negotiation, and lets the standard LSP
machinery route completion, hover, diagnostics, and the rest. The server
forwards each request to `@azerothjs/language-service`, which holds the
TypeScript bridge and markup model. The extension itself contains no language
logic; the only custom protocol is `azeroth/autoInsert`, which the extension
calls on type to obtain a closing tag from the service.

## Components

| Path | Role |
| --- | --- |
| `package.json` | Language, grammar, semantic-token legend, settings schema, and defaults. |
| `language-configuration.json` | Brackets, comments, auto-closing pairs, indentation, on-enter rules. |
| `syntaxes/azeroth.tmLanguage.json` | Native `source.azeroth` TextMate grammar. |
| `src/extension.ts` | Language client startup and the auto-insert wiring. |
| `esbuild.mjs` | Bundles the extension and the server into self-contained `dist/*.js`. |
| `package.mjs` | Builds and optionally installs a self-contained `.vsix`. |

## Development

To iterate without packaging, open `editors/vscode` in VS Code and press F5 (Run
Extension). The development host loads the server from the workspace, so changes
to the server or service are picked up on reload.

```sh
# Type-check the extension sources
npm run build -w azerothjs-vscode
```

## Building

```sh
# Bundle extension and server into self-contained dist/*.js (esbuild)
npm run bundle -w azerothjs-vscode

# Build a self-contained .vsix in dist/ (bundles, then vendors typescript)
npm run package -w azerothjs-vscode

# Build the .vsix and install it into VS Code
npm run install-extension -w azerothjs-vscode
```

The bundle step sets esbuild's `mainFields` to prefer the ESM build of
`vscode-html-languageservice`; the UMD build references internal paths that do
not resolve when bundled. Packaging stages a standalone copy outside the monorepo
before running `vsce`, because `vsce` cannot resolve a hoisted `typescript`
dependency from inside a workspace. See `PUBLISHING.md` for marketplace steps.

## Testing

The language features are covered by the language-service test suite at the
repository root (`npm test`). The extension layer itself is thin and is verified
by running the development host (F5) against a `.azeroth` file.

## Configuration

Settings live under the `azeroth.*` namespace (see the `contributes.configuration`
section of `package.json`) and are forwarded to the server as
`initializationOptions` and through `workspace/configuration`. They cover
per-feature toggles such as completion auto-imports, component snippets, and
inlay hints. TypeScript intelligence uses the nearest `tsconfig.json` in the
workspace. The extension also contributes Emmet support for the markup and
bracket-pair colorization defaults.

### Third-party tooling (zero-config)

`contributes.configurationDefaults` wires `.azeroth` into the common companion
extensions so a project needs **no `.vscode/settings.json`**:

- **ESLint** (`dbaeumer.vscode-eslint`): `eslint.validate` includes `azeroth`, so
  the editor runs ESLint on `.azeroth` files (the `@azerothjs/eslint-plugin`
  processor lints the script; markup is masked). It's a *forced* list separate
  from the probe defaults, so `.js`/`.ts` validation is unaffected.
- **Tailwind CSS** (`bradlc.vscode-tailwindcss`): `tailwindCSS.includeLanguages`
  maps `azeroth` to `html` (its own language — not jsx/tsx; `html` is a neutral
  markup extractor), plus `classRegex` entries so `class="…"`, `class={…}`, and
  `classList({ '…': … })` all complete.

These are *defaults* — a user setting of the same name overrides them. The
companion extensions are recommended, not bundled; nothing breaks if they're
absent.

## Examples

Open `packages/compiler/examples/Showcase.azeroth` to exercise completion, hover,
diagnostics, and navigation by hand.

## Contributing

Keep this package a thin client. Editor-visible behavior that depends on language
analysis belongs in the language service; the extension should only register
contributions and route requests. When adding a capability, register it here and
add the matching handler in `@azerothjs/language-server`.
