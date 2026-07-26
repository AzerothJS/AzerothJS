<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="128" />

# AzerothJS for VS Code

**Framework-grade editor support for `.azeroth` single-file components, powered by the compiler - not heuristics.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%3E%3D1.84-blue.svg)](https://code.visualstudio.com)

</div>

---

Official language support for [AzerothJS](../../README.md) - the fine-grained,
zero-dependency, fullstack TypeScript framework. Full intelligence for `.azeroth`
single-file components, backed by the framework's own compiler.

---

## ✨ What you get

- **A bundled language server** - no Node.js required; install and open a `.azeroth`
  file, that's it.
- **The `.ts` ⇄ `.azeroth` boundary dissolved** - definition, references, and rename
  work in both directions across your TypeScript and your components.
- **Compiler-true diagnostics and types** - real type errors in expressions, real props
  at the boundary, no `any`.
- **Semantic highlighting that shows reactivity** - reactive names get their own color,
  so you always see what re-renders.

---

## 🌉 The `.ts` ⇄ `.azeroth` boundary, dissolved

The differentiator: your TypeScript files and your components behave as ONE codebase.

- **Go to definition / references / rename work in BOTH directions** across
  `.ts` and `.azeroth` - rename a store field in a `.ts` file and every component
  using it updates, and vice versa.
- **Real component types inside plain `.ts` files**: a bundled TypeScript server
  plugin teaches VS Code's own TS engine what `.azeroth` imports are - props are
  typed, errors are real, no `any` at the boundary.
- Unused-export analysis, quick-open, and workspace symbols see both worlds.

---

## 📋 Everything a first-class language gets

| Feature | Details |
| --- | --- |
| **Completion** | HTML tags and user/built-in components in tag position; attributes and DOM events; CSS in inline `style` values; full type-aware TypeScript inside `{ ... }` holes; auto-imports for not-yet-imported symbols. |
| **Hover** | Types, signatures, JSDoc - plus full documentation for every AzerothJS keyword (`state`, `derived`, `effect`, `form`, ...) and built-in component (`Show`, `For`, `Switch`, `Suspense`, `Portal`, `ErrorBoundary`, ...). |
| **Diagnostics** | Compiler markup errors + real TypeScript type errors in expressions and script. Errors say what is wrong, why, and how to fix it. |
| **Navigation** | Definition, type definition, implementation, references - cross-file, cross-language. |
| **Rename** | Safe cross-file rename across the `.ts` ⇄ `.azeroth` boundary. |
| **Semantic highlighting** | Components, host tags, event attributes, and expression holes each get their own token - and **reactive names get a distinct color**, so you always see what re-renders. |
| **Symbols & structure** | Outline, workspace-wide symbol search, folding, selection ranges. |
| **Inlay hints** | Parameter names, inferred types, return types - each individually toggleable. |
| **Signature help, quick fixes, CodeLens, call hierarchy** | The full modern set, compiler-aware. |
| **Colors & links** | CSS color swatches in style values; clickable document links. |
| **Formatting & editing aids** | Document + range formatting, on-type formatting, tag auto-close, linked editing of tag pairs. |

---

## 🔌 Zero-config companions

The extension pre-wires common tooling so a project needs **no `.vscode/settings.json`**:

- **ESLint**: `.azeroth` files are first-class lint targets for
  `@azerothjs/eslint-plugin` (script linted, markup masked).
- **Tailwind CSS**: `class="..."`, `class={...}`, and `classList({...})` all
  complete via pre-wired `includeLanguages` + `classRegex`.

> [!NOTE]
> These are defaults - your own settings of the same keys win. Companion extensions
> are recommended, never required.

---

## 🚀 Quick start

1. Install the extension - the language server is **bundled**; no Node.js required.
2. Open any `.azeroth` file. That's it.
3. New to AzerothJS? `npm create azeroth@latest my-app` scaffolds a working
   frontend, backend, or fullstack project in one command.

---

## ⚙️ Key settings

Settings live under `azeroth.*` (*Settings -> Extensions -> AzerothJS*) - 33
per-feature toggles. The ones most people touch:

| Setting | Default | Effect |
| --- | --- | --- |
| `azeroth.suggest.autoImports` | `true` | Complete not-yet-imported symbols and add the import. |
| `azeroth.suggest.componentSnippets` | `true` | Component completions insert a ready tag pair. |
| `azeroth.inlayHints.enabled` | `true` | Master switch for all inlay hints. |
| `azeroth.autoClosingTags` | `true` | Insert the closing tag on `>`. |
| `azeroth.format.enable` | `true` | Document/range/on-type formatting. |
| `azeroth.diagnostics.enable` | `true` | Compiler + type diagnostics. |

Every capability (hover, rename, CodeLens, semantic tokens, ...) has its own
`azeroth.<feature>.enable` switch.

---

## ✅ Requirements

| Requirement | Minimum |
| --- | --- |
| VS Code | 1.84 |
| Node.js | **not required** - the language server is bundled |

---

## 🏗️ Building from source

From the monorepo root:

```sh
npm run bundle  -w azerothjs-vscode   # bundle the language server
npm run package -w azerothjs-vscode   # produce the .vsix
```

---

## 🔧 Troubleshooting

- **The file icon doesn't show?** Third-party file-icon themes (e.g. Material
  Icon Theme) override extension icons by design. The AzerothJS icon shows under
  VS Code's default *Seti* file icon theme.
- **Stale behavior after an update?** Run **AzerothJS: Restart Language Server**
  from the command palette, or reload the window.
- TypeScript intelligence follows the nearest `tsconfig.json` in your workspace.

---

## 🔗 Links

[Framework](../../README.md) ·
[Getting started](https://github.com/AzerothJS/AzerothJS#quick-start) ·
[Issues](https://github.com/AzerothJS/AzerothJS/issues) ·
[Changelog](https://github.com/AzerothJS/AzerothJS/blob/main/CHANGELOG.md)

---

<div align="center">
<sub>Part of <a href="../../README.md">AzerothJS</a> · <a href="https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE">MIT License</a></sub>
</div>
