# Governance

Honest and small: AzerothJS is built and maintained by a single maintainer
([@IntelligentQuantum](https://github.com/IntelligentQuantum)), who makes final
decisions on design, scope, and releases. This page states how that works and what
binds it, so you can evaluate the project on facts rather than vibes.

## What binds decisions

The maintainer decides, but not arbitrarily - these published policies constrain
every release, and changing a policy is itself a documented decision:

- **[GRAMMAR.md](packages/compiler/GRAMMAR.md)** - the normative `.azeroth` grammar.
  Where the compiler and the document disagree, one of the two has a defect.
- **[STABILITY.md](packages/compiler/STABILITY.md)** - the syntax-stability policy:
  the 1.x keyword freeze, the rubric any future keyword must pass, and
  semver-for-syntax (PATCH: never; MINOR: rubric-passing additions only; MAJOR:
  everything else, with codemods).
- **[Semantic Versioning](https://semver.org)** over a **lockstep train**: every
  package ships the same version in one release; a breaking change anywhere is a
  breaking release everywhere. No compatibility shims, no legacy aliases - a
  rename or fold lands complete, with its migration path stated in the changelog.
- **The test suite as executable specification** - behavioral guarantees
  (hydration markers, escaping, the reactive semantics, kernel purity, grammar
  sync) are welded by tests that must be deleted knowingly to change them.

## How changes happen

- **Bugs and features** go through
  [issues](https://github.com/AzerothJS/AzerothJS/issues) and
  [discussions](https://github.com/AzerothJS/AzerothJS/discussions); pull requests
  are welcome under the [Contributing Guide](CONTRIBUTING.md). The maintainer
  reviews and decides; a decline states why.
- **Settled decisions stay settled.** The keyword set, the package layout, and the
  authoring model are not re-litigated per release; revisiting one is an explicit,
  documented event (a changelog entry and, for syntax, a STABILITY.md change).

## The single-maintainer question, answered plainly

One maintainer is a real constraint and you should weigh it. The mitigations are
structural, not promissory:

- The source is written to be **read**: every layer is from scratch, documented at
  the definition, with the design rationale in the module headers.
- The language and its stability rules are **normatively documented**, not tribal
  knowledge - a future maintainer (or a fork) inherits specifications, not habits.
- The MIT license and a boring, reproducible toolchain (npm, vite, vitest) mean
  nothing about the project is operationally captive.

## Security

Security reports follow the [Security Policy](SECURITY.md) - private reporting,
acknowledgement within 7 days, coordinated disclosure.
