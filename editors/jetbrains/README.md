# AzerothJS for JetBrains

Full language support for `.azeroth` single-file components in JetBrains IDEs - 
powered by the AzerothJS compiler, not heuristics.

## Requirements

| Requirement | Details |
| --- | --- |
| JetBrains IDE | **2026.1 or later**, paid edition (WebStorm, PhpStorm, IntelliJ IDEA Ultimate, CLion, GoLand, PyCharm Professional, and others that ship the LSP API). The LSP API is **not** available in free Community editions. |
| Node.js | Must be on `PATH` - the plugin starts the bundled language server via Node. |

## Installation

**From the JetBrains Marketplace** (recommended): go to *Settings -> Plugins ->
Marketplace*, search for **AzerothJS**, and click Install. Alternatively, visit
the [plugin page](https://plugins.jetbrains.com/plugin/azerothjs).

**From a `.zip` file**:
1. *Settings -> Plugins -> gear icon -> Install Plugin from Disk...* and select the zip, or
2. Extract it into `<IDE-config-dir>/plugins/` and restart the IDE.

A plugin is loaded at startup - **restart the IDE** after installing or updating.

## Features

Intelligence is provided by the bundled AzerothJS language server, which reuses
the framework's own compiler for accurate, compiler-aware analysis:

| Feature | Details |
| --- | --- |
| **Syntax highlighting** | A native lexer handles strings, comments, and `${ }` interpolations correctly so braces inside them never mispair. Semantic tokens from the server refine components, host tags, and event attributes on top. |
| **Completion** | HTML tags and user/built-in components, attributes, DOM events, CSS in `style` values, and full TypeScript completion inside `{ ... }` expression holes. |
| **Hover** | Types, signatures, and JSDoc - including the runtime's built-in components (`Show`, `For`, `Switch`, `Dynamic`, `Suspense`, `Portal`, `ErrorBoundary`). |
| **Diagnostics** | Markup parse errors and TypeScript type errors, surfaced inline with clear explanations. |
| **Go to definition / type definition** | Works across `.azeroth` and `.ts` files. |
| **Find references & rename** | Cross-file, across `.azeroth` and `.ts`. |
| **Formatting** | Full document formatting. |
| **Inlay hints** | Parameter names and inferred types at call sites. |
| **Signature help** | Shows the active parameter while typing function arguments. |
| **Editing aids** | Tag auto-close on `>` and `/>` via `AzerothTypedHandler`. |

## Configuration

Go to *Settings -> Languages & Frameworks -> AzerothJS*. The toggles are sent to
the server as `initializationOptions` and map to the same per-feature options the
VS Code extension uses. TypeScript intelligence uses the nearest `tsconfig.json`
in the project.

### ESLint and Tailwind for `.azeroth`

These are JetBrains' own bundled integrations, not something this plugin controls.
Two one-time IDE settings enable them for `.azeroth`:

- **ESLint** - *Settings -> Languages & Frameworks -> JavaScript -> Code Quality
  Tools -> ESLint -> Run for files* - extend the pattern to include `.azeroth`, e.g.
  `{**/*,*}.{js,ts,vue,html,azeroth}`. ESLint then runs the
  `@azerothjs/eslint-plugin` processor (script linted; markup masked from rules).
- **Tailwind CSS** - *Settings -> Languages & Frameworks -> Style Sheets -> Tailwind
  CSS*, add to the config JSON: `"includeLanguages": { "azeroth": "html" }` (its
  own language - not jsx/tsx), plus the same `experimental.classRegex` the VS
  Code extension uses for `classList({ ... })`.

A plugin cannot force a third-party integration's file globs, so these stay manual
until Tailwind completion is served directly by `@azerothjs/language-server` over
LSP.

## Architecture

The plugin combines two platform mechanisms with the bundled language server:

```
JetBrains IDE
  AzerothLexer               base highlighting + brace matching
  LspServerSupportProvider   starts the bundled server, routes LSP requests
  settings panel             toggles sent as initializationOptions
        |
        bundled server  (server/server.js + its own copy of TypeScript)
        |
        language service  (compiler-aware analysis - shared with VS Code)
```

- **`AzerothLexer`** - native lexer for base highlighting and correct
  brace/bracket matching. It understands strings, comments, and template `${ }`
  interpolations so braces inside them are never mis-paired.
- **`AzerothLspServerSupportProvider`** - uses the platform LSP API
  (`com.intellij.platform.lsp`, 2026.1+) to start the bundled server for
  `.azeroth` files and delegate completion, hover, diagnostics, navigation, and
  the rest.
- **`AzerothTypedHandler`** - type-driven editing behaviour (tag auto-close,
  triggering completion) on the IDE side.
- **Settings** - `AzerothSettings` (persistent state) and `AzerothConfigurable`
  (the UI panel); toggles flow to the server as `initializationOptions`.

### Why LSP plus a native lexer, not the IDE's TypeScript engine

It is tempting to register `.azeroth` as a TypeScript variant and let the IDE's
native engine analyze it. That engine does not know AzerothJS semantics and would
report false errors (`Show` is not imported, markup needs `h()`, reactive wrapping
is missing). The bundled server reuses the AzerothJS compiler, so its analysis is
correct by construction. The native lexer supplies base highlighting without
introducing a second, incorrect analyzer.

## Source layout

| Path | Role |
| --- | --- |
| `src/main/kotlin/com/azerothjs/AzerothLspServerSupportProvider.kt` | Starts the bundled server and describes the LSP integration. |
| `src/main/kotlin/com/azerothjs/AzerothTextMateBundleProvider.kt` | Registers the bundled TextMate grammars. |
| `src/main/kotlin/com/azerothjs/AzerothTypedHandler.kt` | Type-driven editing behaviour on the IDE side. |
| `src/main/kotlin/com/azerothjs/AzerothSettings.kt` | Persistent settings state. |
| `src/main/kotlin/com/azerothjs/AzerothConfigurable.kt` | The Settings panel (Languages and Frameworks -> AzerothJS). |
| `src/main/resources/META-INF/plugin.xml` | Plugin descriptor and extension registrations. |
| `src/main/resources/textmate/*` | Bundled grammars and language configuration. |

## Development

Open `editors/jetbrains` as a Gradle project in IntelliJ IDEA or WebStorm.

**Target IDE**: the build is reproducible by default - it downloads the IDE
version pinned in `gradle.properties` (`platformType` / `platformVersion`). For
fast local iteration against an already-installed IDE, pass
`-PlocalIdePath=<path-to-IDE>` to Gradle instead of downloading it.

**Kotlin version**: pin the Kotlin version in `build.gradle.kts` to match your
IDE's bundled-library metadata; a mismatch fails the build with a
metadata-version error.

Run the plugin in a sandbox IDE:

```sh
cd editors/jetbrains
gradle runIde
```

## Building

Requires **JDK 21** (set `JAVA_HOME`) and **Gradle 9 or later**. Build the
server bundle first (it must exist before the plugin packages it), then the
plugin:

```sh
# 1. Bundle the language server (from the monorepo root)
npm run bundle -w azerothjs-vscode    # -> editors/vscode/dist/server.js

# 2. Build the plugin zip
cd editors/jetbrains
gradle buildPlugin
# -> build/distributions/azerothjs-jetbrains-<version>.zip
```

The `buildPlugin` task depends on `bundleServer`, which copies `server.js` and a
trimmed copy of TypeScript (`lib/*.d.ts`) into the plugin's `server/` resource
directory. If `server.js` is missing, the task fails loudly rather than shipping
an empty `server/` folder that silently can't start the server.

**Releases** are cut from the monorepo root with `npm run release -- <version>`
(see `scripts/release.mjs`). The plugin is versioned in lockstep with the
`@azerothjs/*` packages it bundles.

## Testing

Run the plugin in a sandbox IDE (`gradle runIde`) and open a `.azeroth` file;
verify highlighting, completion, hover, diagnostics, and tag auto-close. The
underlying language analysis is covered by the `@azerothjs/language-service`
test suite at the repository root (`npm test`).

## Quick start

1. Install the plugin from the JetBrains Marketplace.
2. Ensure Node.js is on `PATH` (run `node -v` in a terminal to confirm).
3. Open any `.azeroth` file - the language server activates automatically.
4. For a hands-on tour, open `packages/compiler/examples/Showcase.azeroth` and
   try completion, hover, go-to-definition, and diagnostics.

## Contributing

Keep language analysis in `@azerothjs/language-service`; the Kotlin side should
only handle IDE wiring (starting the server, highlighting, settings, editing
hooks). When the server gains a new capability, the LSP client picks it up
through capability negotiation - no Kotlin change is needed. Changes here are
limited to settings, grammar tweaks, and editing behaviour.

See [CONTRIBUTING.md](https://github.com/AzerothJS/AzerothJS/blob/main/CONTRIBUTING.md)
for the full workflow.
