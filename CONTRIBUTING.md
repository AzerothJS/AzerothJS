# Contributing to AzerothJS

Thanks for your interest in improving AzerothJS. This guide covers how to set up
the repo, the workflow, and the conventions the codebase follows. Most of these
conventions are enforced automatically (ESLint, CI), but a few are project
choices worth knowing up front.

## Prerequisites

- **Node.js >= 24** (see `.nvmrc`; run `nvm use` if you use nvm). CI tests
  Node 24 on Linux and Windows.
- **npm 11+** (the repo pins `packageManager` in `package.json`).

## Setup

```bash
git clone https://github.com/AzerothJS/AzerothJS.git
cd AzerothJS
npm ci
```

`npm ci` installs the whole monorepo from the lockfile and wires up the git hooks
(via the `prepare` script).

## Repository layout

This is an npm-workspaces monorepo. Runtime and tooling live under `packages/*`;
the two editor integrations live under `editors/*`. There is no top-level `src/`
or `test/` directory - each package owns its own `src/` and `tests/`.

| Path | What it is |
| --- | --- |
| `packages/reactivity` | Signals, memos, effects, roots, render-mode primitives. The base layer. |
| `packages/renderer` `packages/component` | DOM rendering, control flow, component teardown. |
| `packages/store` `packages/form` `packages/router` `packages/server` | App-level building blocks. |
| `packages/compiler` | The `.azeroth` single-file-component compiler and the Vite plugin. |
| `packages/azerothjs` | The framework's entry package (`npm i azerothjs`), re-exporting the runtime. |
| `packages/testing` | Test helpers (`renderTest`, `cleanup`, `leakGuard`, `fire`). |
| `packages/language-service` `packages/language-server` `packages/typescript-plugin` `packages/eslint-plugin` | Editor tooling. |
| `packages/devtools` | Browser devtools panel/agent. |
| `editors/vscode` `editors/jetbrains` | Editor extensions. |

The compiler's `src/project.ts` (`generateVirtualCode`) is the single `.azeroth`
to TypeScript lowering; the language service, TS plugin, declaration emit, and
ESLint integration are all thin adapters over it. If you touch `.azeroth`
type-checking, that is where to look.

## Everyday commands

```bash
npm test           # run the full vitest suite (runs against src, no build needed)
npm run test:watch # watch mode
npm run lint       # eslint over the whole repo
npm run lint:fix   # autofix style issues
npm run build      # compile + emit declarations for all packages
npm run leak       # deterministic reactive-graph memory-leak gate
npm run typecheck  # whole-monorepo type-check (no emit)
npm run dev        # whole-monorepo type-check in watch mode
```

Before opening a PR, make sure `npm run lint`, `npm run typecheck`, `npm test`,
and `npm run build` all pass. CI runs these (plus the leak gate, the publish
contract check, test coverage on Linux, a Windows test cell, and - when editor
or package code changes - builds of both editor plugins), so a green local run
should mean a green CI run. `npm run verify` chains every local gate in one
command.

## Testing

- Tests live in each package's `tests/` directory as `*.spec.ts` (not a top-level
  `test/` folder, and not `.test.ts`).
- The harness is vitest + happy-dom. Files default to a DOM environment; opt out
  for SSR/compiler tests with a `// @vitest-environment node` comment at the top.
- Prefer the `@azerothjs/testing` helpers (`renderTest`, `fire`, `leakGuard`) for
  rendering and event tests - they handle mount/teardown and let you assert the
  absence of subscriber leaks. Drop to the raw `render`/`hydrate` APIs only when
  the test is specifically exercising those low-level paths.
- New behaviour needs a test. Bug fixes should add a regression test.

## Coding conventions

These are enforced by `eslint.config.ts`; `npm run lint:fix` applies most of them.

- **Allman brace style** - opening braces go on their own line.
- **Single quotes**, 4-space indentation, semicolons, no trailing commas, LF line endings.
- **Explicit member accessibility** on class members (`public`/`private`/`protected`).
- **`interface` over `type`** for object shapes.
- **Comments are ASCII-only.** No non-ASCII punctuation or symbols in source comments.
- **No internal lineage references in doc comments.** Don't cite ADRs, milestones,
  internal RFCs, spec sections, design-doc paths, or decision IDs in code comments -
  they don't survive into the published package and mean nothing to a reader.
  External standards (e.g. "RFC 5322") are fine.
- Write doc comments for public functions, types, and interfaces; explain **why**,
  not just **what**.
- Each reactive keyword in the language is kept as a separate first-class concept
  (its own AST identity) even when two are semantically close today - this is
  deliberate, to keep room for per-keyword evolution. Don't fold one keyword into
  another's option without discussing it first.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary`. The **scope is a repository path**, not a bare package
name - it names where the change lives:

| Scope | Used for | Example |
| --- | --- | --- |
| `packages/<name>` | one package | `feat(packages/form): field arrays and async validation` |
| `packages` | a change spanning several packages | `feat(packages): editor plugins, declaration maps, and reactive highlighting` |
| `editors/<vscode\|jetbrains>` | one editor integration | `feat(editors/jetbrains): native JetBrains Azeroth language support` |
| `editors` | both editor integrations | `feat(editors): first-class .azeroth support across VS Code & JetBrains` |
| `ci` / `actions` | workflows | `chore(ci): GitHub Actions to latest versions` |
| `scripts` | repo scripts | `chore(scripts): support resuming interrupted version bumps` |
| `build` | build wiring (tsconfig, build order) | `fix(build): missing packages to tsconfig and build order` |
| `deps` / `deps-dev` | dependency bumps (dependabot's prefixes) | `chore(deps): bump vscode-languageserver to 10.0.1` |
| `release` | the release commit itself (created by `release.mjs`) | `chore(release): v0.7.0-beta.1` |

Common types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`,
`chore`, `ci`. Mark a breaking change with `!` after the scope and a
`BREAKING CHANGE:` footer, e.g.
`build(packages)!: raise the Node engines floor to >=24 in every published package`.

This convention is a readability and history aid; it is **not** wired into any
automated versioning (see Releases below), so it's documented here rather than
enforced by a commit hook.

## Pull requests

1. Branch off `main`.
2. Make your change with tests; keep `lint`, `test`, and `build` green.
3. Update the `[Unreleased]` section of `CHANGELOG.md` if your change affects
   published behaviour.
4. Open the PR and fill in the template. CI must pass before review.

## Releases (maintainer only)

The monorepo is versioned **in lockstep**: every package and editor integration
shares one version, and inter-package dependencies are pinned to that exact
version. Releases are cut with `scripts/release.mjs`:

```bash
npm run release -- beta                    # next beta iteration (0.7.0-beta.1 -> 0.7.0-beta.2)
npm run release -- rc                      # promote the line to rc.1
npm run release -- stable                  # cut the stable release (drop the suffix)
npm run release -- minor                   # next minor, staying on the current channel
npm run release -- minor --channel stable  # next minor as a stable release
npm run release -- 0.7.0-beta.1            # or spell out the full version
npm run release -- beta --dry-run          # preview every step, change nothing
```

The version argument is a full version or a **bump keyword** resolved against the
current version (`alpha`/`beta`/`rc`, `pre`, `stable`, `patch`/`minor`/`major`) -
run `node scripts/release.mjs --help` for the exact rules.

The script bumps every manifest (packages, both editors, and the version examples
in the docs), **promotes the `CHANGELOG.md` `[Unreleased]` section automatically**
(retitles it with the version and date, inserts a fresh empty section, rewrites
the compare links; `--no-changelog` skips this), updates the lockfile, runs the
build/lint gate, commits and tags, publishes `azerothjs` and the `@azerothjs/*`
packages to npm with the dist-tag implied by the version (a prerelease publishes
under its prerelease id; a stable version under `latest`), syncs the VS Code
extension's lockfile against the freshly published versions, and pushes.

Publishing happens **before** the push on purpose: the pushed tag triggers CI
that builds the editor extensions against the just-released registry versions,
so the registry must be consistent first. Publishing is also **idempotent** -
versions already on the registry are skipped, so an interrupted run can simply
be re-run.

This bespoke lockstep model is why the project does **not** use changesets or
semantic-release - those tools assume independently versioned packages and
commit- or fragment-derived versioning, which would fight the single-version
model rather than help it.

### Version numbers

Versions follow [Semantic Versioning](https://semver.org): `MAJOR.MINOR.PATCH`,
optionally with a `-prerelease` suffix. Bump the leftmost part that applies and
reset the parts to its right to `0` (a MINOR bump zeroes PATCH: `1.4.7 -> 1.5.0`).

| Part | Bump for | Example |
| --- | --- | --- |
| `MAJOR` | a breaking change (existing code may need updating) | `1.4.7 -> 2.0.0` |
| `MINOR` | a backward-compatible feature | `1.4.7 -> 1.5.0` |
| `PATCH` | a backward-compatible bug fix | `1.4.7 -> 1.4.8` |

While the project is on `0.y.z` (major version zero) the API is still
stabilizing, so **any** release - even a MINOR bump - may break. Reaching
`1.0.0` is the commitment that the public API is stable and won't break without
a MAJOR bump.

A `-channel.n` suffix marks a **pre-release**: a version that ranks *below* the
stable release of the same number (`1.0.0-beta.2` is older than `1.0.0`). The
channel names a maturity stage; `.n` is the iteration within it:

| Channel | Meaning |
| --- | --- |
| `alpha` | earliest, unstable, incomplete; for internal / early testers - APIs churn freely |
| `beta` | feature-complete-ish but still buggy; public testing - APIs mostly frozen |
| `rc` | release candidate - ships as the final unless a blocker turns up (only bug fixes between an rc and the final) |
| `next` / `canary` | rolling bleeding-edge builds, not a maturity gate |

Pre-releases only ever move forwards through that order, which is also their
precedence (a pre-release always ranks below its stable):

```
1.0.0-alpha.1  <  1.0.0-beta.1  <  1.0.0-rc.1  <  1.0.0  <  1.0.1
```

The channel becomes the npm dist-tag - a stable version publishes under `latest`,
a pre-release under its channel - so `npm i azerothjs` gets the newest
release and `npm i azerothjs@beta` opts into the beta line. `release.mjs`
derives all of this from the version string and rejects an unknown channel (a
typo like `-bta.1`); run `node scripts/release.mjs --help` for the full guide.

### Publishing with provenance (optional)

The local flow above publishes without an npm provenance attestation. To publish
from CI with provenance instead, use the **Publish (npm, provenance)** workflow
(`.github/workflows/publish.yml`): a manual `workflow_dispatch` that checks out
the already-pushed tag, re-runs the full gate on a clean machine, and publishes
with `--provenance` via npm OIDC **trusted publishing** (no `NPM_TOKEN`).

This requires a one-time setup on npmjs.com: configure a *Trusted Publisher* for
`azerothjs` and each `@azerothjs/*` package, pointing at this repository and
`.github/workflows/publish.yml`. Until that is configured, the workflow will fail
authentication - which is fine; the local `npm run release` flow is unaffected.
The workflow intentionally does not bump, tag, push, or move the `latest`
dist-tag; cut and push the tag with `npm run release -- <version> --no-publish`
(or the normal flow) first, then run the workflow to publish that tag.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
