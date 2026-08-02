# Versioning

AzerothJS follows [Semantic Versioning](https://semver.org). This page is the
contract behind the version number - what a release may change, and what it may
never change.

## One version

Every official package ships the same version in one release: the `azerothjs`
entry package, every `@azerothjs/*` package, `create-azeroth`, and both editor
integrations. Packages are guaranteed to interoperate only within a single
version; mixing versions across the set is unsupported.

## The grammar is public API

A `.azeroth` program is written against the grammar, so grammar changes are API
changes and carry the same semver weight as a runtime or compiler change. The
syntax-specific rules (the keyword freeze, the rubric for new keywords) live in
[STABILITY.md](packages/compiler/STABILITY.md); this page states the general
contract they specialize.

## What each number may contain

- **Major** - breaking changes to the grammar, the runtime, the compiler, or any
  published API ship here and nowhere else.
- **Minor** - new features across the language, runtime, compiler, and tooling.
  Every program that compiled keeps compiling, with unchanged meaning.
- **Patch** - bug fixes only.

## Deprecation and removal

Nothing published is removed without warning. A deprecation is announced in the
changelog, keeps working for at least one major cycle after the announcement,
and is removed in a later major - so code written against a stable API always
gets a full cycle of notice. Deprecation is the only sanctioned compatibility
surface: ad-hoc aliases and silent shims outside this process do not exist.

## Majors are milestones, with migrations

Major releases are milestone-driven, not calendar-driven: a major ships when its
changes are complete and migration-ready, not on a date. Because the compiler
owns the source format, majors may ship codemods (`azeroth upgrade`) that
rewrite affected programs automatically - migration tooling, not compatibility
layers, is how AzerothJS carries users across breaking changes. Every major gets
a prerelease window on the `next` dist-tag before `latest` moves.

## Long-term support

There is no LTS line today. One will be introduced when production adoption
requires it, not before; when it is, the policy will be stated here first.
