<!--
Thanks for contributing to AzerothJS! Fill in every section that applies and delete the ones that
don't. See CONTRIBUTING.md for the full workflow and coding conventions.
-->

## Summary

<!-- One or two sentences: what does this PR do and why?
     Link the related issue where it exists: Closes #<n> / Fixes #<n> / Ref #<n> -->

## Motivation

<!-- What problem does this solve or what gap does it fill?
     If there is no linked issue, explain the context here so reviewers understand *why*. -->

## Type of change

<!-- Check every type that applies. -->

- [ ] `feat` — new feature or public-API addition
- [ ] `fix` — bug fix
- [ ] `perf` — performance improvement (no API change)
- [ ] `refactor` — internal restructure (no behaviour change)
- [ ] `docs` — documentation only
- [ ] `test` — adds or corrects tests, no production-code change
- [ ] `chore` — tooling, scripts, dependency updates, config
- [ ] `ci` — CI/CD workflow change
- [ ] **Breaking change** — removes or alters an existing public API

## Affected packages

<!-- Check every package whose published API or runtime behaviour is changed.
     Unchanged packages and editor-only changes can be left unchecked. -->

- [ ] `@azerothjs/reactivity`
- [ ] `@azerothjs/renderer`
- [ ] `@azerothjs/component`
- [ ] `@azerothjs/store`
- [ ] `@azerothjs/form`
- [ ] `@azerothjs/router`
- [ ] `@azerothjs/server`
- [ ] `@azerothjs/compiler`
- [ ] `@azerothjs/core`
- [ ] `@azerothjs/testing`
- [ ] `@azerothjs/language-service` / `@azerothjs/language-server` / `@azerothjs/typescript-plugin`
- [ ] `@azerothjs/eslint-plugin`
- [ ] `@azerothjs/devtools`
- [ ] `editors/vscode`
- [ ] `editors/jetbrains`

## Description

<!-- Walk reviewers through your approach. Explain design decisions and trade-offs so they
     understand *why* the code looks the way it does, not just *what* changed. -->

## Breaking changes

<!-- If this PR contains a breaking change, describe exactly what breaks and the migration path
     users should follow. Delete this section if there are none. -->

## Testing

<!-- Describe how the change is tested. Call out any important test cases or edge cases exercised.
     If no new tests were added, explain why existing coverage is sufficient. -->

## Checklist

- [ ] `npm run lint` passes (`npm run lint:fix` applied for style issues)
- [ ] `npm test` passes
- [ ] `npm run build` succeeds for all packages
- [ ] `npm run typecheck` passes
- [ ] `npm run leak` shows no reactive-graph leaks *(required when touching `@azerothjs/reactivity` or any reactive primitive)*
- [ ] New behaviour is covered by tests in the relevant `tests/*.spec.ts`
- [ ] Bug fixes include a regression test
- [ ] Public API additions/changes have doc comments that explain **why**, not just what
- [ ] `CHANGELOG.md` `[Unreleased]` section updated *(required when published behaviour changes)*
- [ ] Commit message(s) follow Conventional Commits — `type(scope): summary`
- [ ] Comments are ASCII-only and contain no internal lineage references (no ADR IDs, milestone links, internal RFC paths — see CONTRIBUTING.md)
