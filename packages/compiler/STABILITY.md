# Syntax stability policy (1.x)

RATIFIED. Companion to [GRAMMAR.md](./GRAMMAR.md),
which records WHAT the language is; this page records how it is allowed to CHANGE.

## 1. The freeze

The 1.x keyword set is FROZEN as shipped:

> `component` · `state` `derived` `deferred` · `resource` `stream` `store` `selector`
> `form` (+ `form NAME[]`) · `effect` (both forms) · `batch` `untrack` `cleanup`
> `dispose` `mount` · the `with { }` clause

Through every 1.x release: **no removals, no renames, no semantic changes, no merging
of keywords into options of other keywords**. Each keyword stays separate and
first-class - settled; not revisited per release.

One SECTION has since been added: `style { }`. Sections are a separate category from
keywords, admitted under their own rule (§2.2); the keyword freeze above is untouched.

## 2. The rubric - what can EARN keyword status

### 2.1 Keywords

A candidate construct must pass ALL of:

1. **Reactive or root-bound.** It declares a reactive value whose reads/initializer
   the compiler rewrites, or it binds a block's lifecycle to the component's
   reactive root. Imperative features that neither track nor dispose are never
   keywords (`ref` is the canonical rejection).
2. **Existing surface shape.** It fits one of the two 1.x shapes -
   declaration (`kw NAME = value [with { }] ;`) or block (`kw [(args)] [with { }] { }`).
   New shapes are 2.0 territory.
3. **Shape-gated, never reserved.** The word stays a legal identifier everywhere
   except its exact position + shape (GRAMMAR.md §7).
4. **One runtime helper.** It maps to exactly one entry in `keyword-spec.ts` -
   the tables, all three emitters, the projection style, editor tooling (semantic
   tokens, keyword docs), and eslint coverage land in ONE change, with a GRAMMAR.md
   diff and empirical parser probes (the 6.1 discipline).
5. **Capture analysis.** Because contextual keywords claim a shape, adding one can
   re-interpret pathological existing code (`kw {` as an expression statement
   followed by a block). An addition must show the captured shape is not meaningful
   TypeScript in practice, and ship a diagnostic that flags identifiers shadowing
   the new keyword in body position.

### 2.2 Sections

A **section** is a module-level block that composes another language into the file.
It is not a keyword and cannot pass §2.1 - it declares no reactive value and binds no
lifecycle - so it has its own rule, which is deliberately harder to satisfy:

1. **Composition only.** It must do something that no combination of plain
   TypeScript, plain markup and a normal `import` can do. A section that merely
   relocates code that already had a home is rejected; this is what rules out a
   `script { }` (the module level and the component body already ARE TypeScript) and
   an import syntax for CSS (`import './x.css'` already works).
2. **Module level, at most one per module, build-time only.** No runtime value, no
   reactivity, no per-instance meaning. A file has one of a section, or none.
3. **The interior is the other language, unparsed.** The compiler may rewrite named
   things it can see on BOTH sides, and nothing else. It must not invent dialect
   syntax, and everything the guest language gains later must keep working untouched.
4. **Shape-gated and analysed like a keyword.** §2.1's rules 3 and 5 apply verbatim:
   the word stays a legal identifier everywhere else, and the captured shape must be
   meaningless TypeScript, with a diagnostic where it is written wrongly.
5. **Removable without migration.** A team that ignores the section keeps every prior
   mechanism working unchanged.

**ADOPTED: `style { ... }`.** (1) Composition: the compiler rewrites `.field-error`
in the CSS and `class="field-error"` in the markup to one content-hashed name -
simultaneous knowledge of two languages, which is exactly what neither of them has
alone. (2) One stylesheet per file, registered at module load. (3) The body is never
parsed as CSS; only `.class` selectors are suffixed. (4) `style` followed by `{` at a
module statement start is an expression statement plus a block - the same argument
that admitted `mount` - and `azeroth/style-section` reports every other placement.
(5) External `.css` files, CSS Modules and utility frameworks are unaffected, and a
component that outgrows its section moves the CSS to a normal file with a normal
import.

## 3. Semver for syntax

- **PATCH**: no syntax changes of any kind. Parser bug fixes only where behavior
  converges on GRAMMAR.md.
- **MINOR**: may ADD a keyword that passes the full rubric (§2.1), or a section that
  passes §2.2. Existing code compiles unchanged (shape-gating + capture analysis).
  May add new *options* inside existing `with { }` clauses.
- **MAJOR (2.0)**: the only place removals, renames, or new surface shapes can
  happen - each with a codemod.
- GRAMMAR.md is normative: no syntax change merges without its diff, and the
  compiler's divergence from it is a defect regardless of direction.

## 4. Worked example: `onMount` (the first rubric case)

The runtime gained `onMount(fn)` (post-connection, owner-gated, cleanup-returning).
Does it need syntax?

**Rubric check (§2.1).** (1) Root-bound: yes - it runs under the registering owner, is
gated on `Owner.disposed`, and its returned cleanup registers on the owner. That is
precisely the class `cleanup { }` / `dispose { }` occupy. (2) Shape: the block shape
fits exactly (`mount { ... }` -> `onMount(() => { ... })`). (3) Shape-gated: an
identifier `mount` not followed by `{` stays plain code. (4) One helper: `onMount`.
(5) Capture: `mount {` as plain TS is an expression statement followed by an empty
block - legal but meaningless; the standard diagnostic covers it.

**ADOPTED: `mount { ... }` is a wrapper keyword** (ratified with this policy; the first addition to pass the rubric). The
honest argument is not that the call form is broken - `onMount(() => {})` works -
but that the lifecycle triad is currently HALF syntax: authors write `cleanup { }`
and `dispose { }` as structure and `onMount(() => { })` as a call. The wrapper class
exists for exactly this block-authoring consistency, and `mount` completes it. The
alternative (keep the call, document the asymmetry as historical) is coherent but
leaves the language teaching two idioms for one concept family.

## 5. What this policy does NOT cover

Markup-layer attribute names (`class:`/`style:`/`bind:`/`on*`, `data-route-focus`
and friends) are API surface, not grammar - they follow the packages' normal semver,
not this page. Expression interiors belong to TypeScript and inherit its evolution.
