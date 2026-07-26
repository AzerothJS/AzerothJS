<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/logo-transparent.png" alt="AzerothJS" width="120" />

# AzerothJS for JetBrains

**Framework-grade support for `.azeroth` single-file components in WebStorm, IDEA Ultimate, and other paid JetBrains IDEs - powered by the compiler, not heuristics.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
[![JetBrains IDE](https://img.shields.io/badge/JetBrains-2026.1%2B-orange.svg)](https://www.jetbrains.com)

</div>

---

Full language support for [AzerothJS](../../README.md) - the fine-grained,
zero-dependency, fullstack TypeScript framework. Intelligence for `.azeroth`
single-file components comes from the bundled AzerothJS language server, which reuses
the framework's own compiler for accurate, compiler-aware analysis.

---

## ✨ What you get

- **The `.ts` ⇄ `.azeroth` boundary dissolved** - go-to-definition, Find Usages, and
  safe rename work in both directions between your TypeScript and your components.
- **Usage-aware inspections** - the IDE's unused-symbol analysis sees component usages,
  so a `.ts` export used only from markup is never falsely flagged.
- **Themeable reactive colors** - every token, including reactive declaration names,
  is a customizable color under *Editor -> Color Scheme -> AzerothJS*.
- **Zero config** - open a project, open a component, everything works.

---

## 📦 Install

**From the JetBrains Marketplace** (recommended): *Settings -> Plugins -> Marketplace*,
search for **AzerothJS**, and click Install.

**From a `.zip` file**: *Settings -> Plugins -> gear icon -> Install Plugin from Disk...*
and select the zip, or extract it into `<IDE-config-dir>/plugins/` and restart.

> [!NOTE]
> A plugin is loaded at startup - **restart the IDE** after installing or updating.

---

## 📋 Features

| Feature | Details |
| --- | --- |
| **Syntax highlighting** | A native lexer handles strings, comments, and `${ }` interpolations correctly so braces inside them never mispair. Semantic tokens from the server refine components, host tags, and event attributes on top. |
| **Completion** | HTML tags and user/built-in components, attributes, DOM events, CSS in `style` values, and full TypeScript completion inside `{ ... }` expression holes, with auto-imports. |
| **Hover** | Types, signatures, and JSDoc - including AzerothJS keywords and the runtime's built-in components (`Show`, `For`, `Switch`, `Dynamic`, `Suspense`, `Portal`, `ErrorBoundary`). |
| **Diagnostics** | Markup parse errors and TypeScript type errors, surfaced inline with clear explanations. |
| **Navigation** | Go to definition / type definition across `.azeroth` and `.ts`. |
| **Find references & rename** | Cross-file, across `.azeroth` and `.ts`. |
| **Usage-aware inspections** | Unused-symbol analysis and Find Usages see `.azeroth` usages, so a `.ts` export used only from a component is never flagged unused. |
| **Semantic & themeable colors** | A distinct color for reactive names; every token is a customizable attribute under *Editor -> Color Scheme -> AzerothJS*. |
| **Formatting** | Full document formatting. |
| **Inlay hints** | Parameter names and inferred types at call sites. |
| **Signature help** | Shows the active parameter while typing function arguments. |
| **Editing aids** | Tag auto-close on `>` and `/>`, and matching open/close tag highlighting. |

---

## ✅ Requirements

| Requirement | Details |
| --- | --- |
| JetBrains IDE | **2026.1 or later**, paid edition (WebStorm, PhpStorm, IntelliJ IDEA Ultimate, CLion, GoLand, PyCharm Professional, and others that ship the LSP API). The LSP API is **not** available in free Community editions. |
| Node.js | Must be on `PATH` - the plugin starts the bundled language server via Node. It is auto-detected from `PATH` and common version managers (nvm, fnm, volta, Homebrew). |

New to AzerothJS? `npm create azeroth@latest my-app` scaffolds a working frontend,
backend, or fullstack project in one command.

---

## ⚙️ Configuration

Go to *Settings -> Languages & Frameworks -> AzerothJS*. The toggles are sent to the
server as `initializationOptions` and map to the same per-feature options the VS Code
extension uses. TypeScript intelligence uses the nearest `tsconfig.json` in the project.

### ESLint and Tailwind for `.azeroth`

These are JetBrains' own bundled integrations, not something this plugin controls.
Two one-time IDE settings enable them for `.azeroth`:

- **ESLint** - *Settings -> Languages & Frameworks -> JavaScript -> Code Quality
  Tools -> ESLint -> Run for files* - extend the pattern to include `.azeroth`, e.g.
  `{**/*,*}.{js,ts,vue,html,azeroth}`. ESLint then runs the
  `@azerothjs/eslint-plugin` processor (script linted; markup masked from rules).
- **Tailwind CSS** - *Settings -> Languages & Frameworks -> Style Sheets -> Tailwind
  CSS*, add to the config JSON: `"includeLanguages": { "azeroth": "html" }`, plus the
  same `experimental.classRegex` the VS Code extension uses for `classList({ ... })`.

A plugin cannot force a third-party integration's file globs, so these stay manual.

---

<details>
<summary><b>Architecture</b></summary>

The plugin combines native platform mechanisms with the bundled language server:

- **Native `.azeroth` language** - a real lexer, parser definition, brace matcher, and
  color settings page provide base highlighting and correct bracket matching (braces
  inside strings and template interpolations never break the pairing).
- **`AzerothLspServerSupportProvider`** - uses the platform LSP API
  (`com.intellij.platform.lsp`, 2026.1+) to start the bundled server for `.azeroth`
  files and delegate completion, hover, diagnostics, navigation, rename, and the rest.
- **Usage visibility** - a Find Usages provider, an implicit-usage provider, and a
  references searcher let the IDE's PSI-based inspections see `.azeroth` usages of
  `.ts` symbols.
- **`AzerothTypedHandler`** - type-driven editing behavior (tag auto-close, triggering
  completion) on the IDE side.
- **Settings** - `AzerothSettings` (persistent state) and `AzerothConfigurable` (the UI
  panel); toggles flow to the server as `initializationOptions`.

### Why LSP plus a native lexer, not the IDE's TypeScript engine

Registering `.azeroth` as a TypeScript variant and letting the IDE's native engine
analyze it would report false errors (`Show` is not imported, markup needs `h()`,
reactive wrapping is missing) because that engine does not know AzerothJS semantics.
The bundled server reuses the AzerothJS compiler, so its analysis is correct by
construction; the native lexer supplies base highlighting without a second, incorrect
analyzer.

</details>

---

## 🏗️ Building from source

Requires **JDK 21** (set `JAVA_HOME`) and **Gradle 9 or later**. Build the language
server bundle first (the plugin packages it), then the plugin:

```sh
# 1. Bundle the language server (from the monorepo root)
npm run bundle -w azerothjs-vscode

# 2. Build the plugin zip
cd editors/jetbrains
gradle buildPlugin
# -> build/distributions/azerothjs-jetbrains-<version>.zip
```

The `buildPlugin` task depends on `bundleServer`, which copies `server.js` and a
trimmed copy of TypeScript into the plugin's `server/` resource directory; if the
server bundle is missing, the task fails loudly rather than shipping a plugin that
can't start.

Run the plugin in a sandbox IDE for local iteration:

```sh
cd editors/jetbrains
gradle runIde
```

Pass `-PlocalIdePath=<path-to-IDE>` to iterate against an already-installed IDE instead
of downloading the pinned version. The underlying language analysis is covered by the
`@azerothjs/language-service` test suite at the repository root (`npm test`).

---

## 🤝 Contributing

Keep language analysis in `@azerothjs/language-service`; the Kotlin side handles only
IDE wiring (starting the server, highlighting, settings, editing hooks). When the server
gains a capability, the LSP client picks it up through capability negotiation - no Kotlin
change is needed. See
[CONTRIBUTING.md](https://github.com/AzerothJS/AzerothJS/blob/main/CONTRIBUTING.md)
for the full workflow.

---

<div align="center">
<sub>Part of <a href="../../README.md">AzerothJS</a> · <a href="https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE">MIT License</a></sub>
</div>
