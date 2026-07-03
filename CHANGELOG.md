# Changelog

All notable changes to AzerothJS are documented here. The monorepo is versioned in
lockstep: one version covers every `@azerothjs/*` package, the `azerothjs` entry
package, and both editor integrations.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org).

## [Unreleased]

### Changed

- **BREAKING:** `azerothjs` (unscoped) is now the framework's entry package and the
  compiler's code-generation target. Install `azerothjs` instead of `@azerothjs/core`
  and import from `'azerothjs'`; `@azerothjs/core` is removed and receives no further
  releases.
- Release flow publishes to npm before pushing the tag, so CI triggered by the push
  always finds the released versions on the registry.
- All READMEs rewritten for npm: root front page, `azerothjs` flagship page, and
  per-package pages with install instructions; non-ASCII punctuation removed from
  authored text repo-wide.

## [0.7.0-beta.1] - 2026-07-02

### Added

- `form` keyword: first-class forms in `.azeroth` (`form f = shape with { ... }`),
  including the array form `form rows[]` for dynamic lists of repeated sub-forms.
- Form engine: cross-field validation (`validateForm`), per-field async validation
  (`validateAsync` with AbortSignal + debounce), numeric field coercion, and
  `createFieldArray`.
- Cross-language editor intelligence: Find References / Go to Definition / Rename
  across the `.ts` and `.azeroth` boundary in both editors, with result spans mapped
  to real source positions.
- `reactive` semantic-token modifier: names declared by reactive keywords get a
  distinct, themeable color in VS Code and JetBrains.
- JetBrains: usage-aware inspections (a `.ts` export used only from `.azeroth` files
  is no longer flagged unused) and `.azeroth`-aware Find Usages.
- Generated type projections (`.azeroth/types` mirror with declaration maps) so
  editors without tsserver-plugin support resolve `.azeroth` imports with full types.
- CI: editor plugins built, verified (JetBrains Plugin Verifier), and attached to
  GitHub Releases; typecheck and coverage gates.

### Changed

- **BREAKING:** published packages require Node >= 24.
- `props {}` blocks removed: component props are standard TypeScript parameters.
- `watch` folded into `effect (deps)`; `bind:` on components lowers to
  `value` + `on<Prop>Change`.

## [0.6.0-beta.1] - 2026-06-21

- Component-only `.azeroth` authoring model, unified compiler IR, and the rebuilt
  editor tooling stack (language service, language server, VS Code extension,
  JetBrains plugin, tsserver plugin, ESLint processor).

[Unreleased]: https://github.com/AzerothJS/AzerothJS/compare/v0.7.0-beta.1...HEAD
[0.7.0-beta.1]: https://github.com/AzerothJS/AzerothJS/compare/v0.6.0-beta.1...v0.7.0-beta.1
[0.6.0-beta.1]: https://github.com/AzerothJS/AzerothJS/releases/tag/v0.6.0-beta.1
