# Contributing to AzerothJS

Thanks for your interest in improving AzerothJS. This guide covers how to set up
the repo, the workflow, and the conventions the codebase follows. Most of these
conventions are enforced automatically (ESLint, CI), but a few are project
choices worth knowing up front.

## Prerequisites

- **Node.js >= 20** (see `.nvmrc`; run `nvm use` if you use nvm). The CI matrix
  tests Node 20, 22, and 24.
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
| `packages/core` | Umbrella package re-exporting the runtime. |
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

Before opening a PR, make sure `npm run lint`, `npm test`, and `npm run build`
all pass. CI runs exactly these (plus the leak gate, and the test suite across
the Node matrix), so a green local run should mean a green CI run.

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
`type(scope): summary`, e.g. `fix(reactivity): clear stale deps on re-run`.
Common types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `chore`, `ci`.

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
npm run release -- 0.7.0-beta.1            # bump, verify, commit, tag, push, publish
npm run release -- 0.7.0-beta.1 --dry-run  # preview every step, change nothing
```

The script bumps every manifest, updates the lockfile, runs the build/lint gate,
commits and tags, pushes, and publishes the `@azerothjs/*` packages to npm with
the dist-tag implied by the version (a prerelease publishes under its prerelease
id; a stable version under `latest`). Promote the `CHANGELOG.md` `[Unreleased]`
section to the new version before releasing.

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
a pre-release under its channel - so `npm i @azerothjs/core` gets the newest
release and `npm i @azerothjs/core@beta` opts into the beta line. `release.mjs`
derives all of this from the version string and rejects an unknown channel (a
typo like `-bta.1`); run `node scripts/release.mjs --help` for the full guide.

### Publishing with provenance (optional)

The local flow above publishes without an npm provenance attestation. To publish
from CI with provenance instead, use the **Publish (npm, provenance)** workflow
(`.github/workflows/publish.yml`): a manual `workflow_dispatch` that checks out
the already-pushed tag, re-runs the full gate on a clean machine, and publishes
with `--provenance` via npm OIDC **trusted publishing** (no `NPM_TOKEN`).

This requires a one-time setup on npmjs.com: configure a *Trusted Publisher* for
each `@azerothjs/*` package, pointing at this repository and
`.github/workflows/publish.yml`. Until that is configured, the workflow will fail
authentication - which is fine; the local `npm run release` flow is unaffected.
The workflow intentionally does not bump, tag, push, or move the `latest`
dist-tag; cut and push the tag with `npm run release -- <version> --no-publish`
(or the normal flow) first, then run the workflow to publish that tag.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
