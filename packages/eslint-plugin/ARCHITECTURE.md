# ESLint integration architecture

The goal: a `.azeroth` file is linted **exactly like a `.ts` file** - every core rule, every
`@typescript-eslint` rule (including type-aware ones), every plugin, every autofix - with diagnostics at
the original `.azeroth` location, and **no second parser or TypeScript program** (the compiler's
projection and the language service's program stay the single sources of truth).

## The chosen architecture: hybrid processor + program-providing parser

Two ESLint extension points work together, each doing the part it is best at.

```
  .azeroth file
      │  preprocess()                      ── azeroth-processor.ts
      ▼
  register in the shared AzerothProject    ── project-pool.ts   (LS program now contains the twin)
      │  + generateVirtualCode()           ── @azerothjs/compiler (the ONE projection)
      ▼
  virtual TypeScript block  ──►  parseForESLint()   ── azeroth-parser.ts
      │                              │ parses the twin in PROGRAM mode against the
      │                              │ AzerothProject program  => real parserServices
      ▼                              ▼
  ESLint runs every configured rule on the virtual module (core + @typescript-eslint + plugins),
  type-aware rules included, because parserServices.program / getTypeChecker is present
      │  postprocess()                     ── azeroth-processor.ts
      ▼
  map every message + autofix back to the ORIGINAL .azeroth via the compiler CodeMapping;
  drop anything in generated scaffolding; merge the compiler's reactivity diagnostics
      ▼
  one unified diagnostics list, at original .azeroth locations
```

- **Processor** (`azeroth-processor.ts`) - lowers the file to its virtual TypeScript (via
  `generateVirtualCode`), and in `postprocess` maps every message **and** autofix back through the
  byte-exact `CodeMapping`, drops diagnostics that fall in generated scaffolding (so nothing points into
  virtual code), and merges the compiler's own reactivity diagnostics into the same list.
- **Parser** (`azeroth-parser.ts`) - set as `languageOptions.parser` for the virtual blocks. It parses
  the virtual twin in **program mode** against the language service's existing program (see below), so
  the parse result carries real `parserServices` (`program`, `getTypeChecker`, the ESTree<->TS node map).
- **Project pool** (`project-pool.ts`) - one `AzerothProject` (a `ts.LanguageService`) per workspace
  root, reused across the whole lint run. This *is* the language service's program; the parser borrows
  it rather than building a second one.

## Why not the alternatives

**Processor alone (the previous implementation).** A processor can lint the projected module and map
results back, which covers all syntactic rules. But its virtual block belongs to no `tsconfig`, so there
is no `Program`/`parserServices` for it - every type-aware `@typescript-eslint` rule throws "requires
type information". Rejected: it cannot satisfy requirement #2.

**A pure custom parser that remaps the AST (the Vue/Svelte model).** Parse the virtual module, remap
every node/token/comment range to the original, hand ESLint the original text + remapped AST; rules then
report natively (no postprocess). This is elegant where the embedded language *is* the script (Vue/Svelte
keep `<script>` as real top-level code). It is a poor fit here because the AzerothJS projection **wraps**
the user's code (`component X { ... }` -> `export default function X(props...) { ... }`, markup -> `h(...)`
calls, `state`->`let`, ...). That means the AST contains **scaffolding nodes with no source origin** (the
wrapper function, the `props` parameter, `declare const h`). A pure parser would either (a) surface
lint messages on those nodes (false positives the user can't act on) or (b) require pruning them, which
breaks the scope manager and the ESTree<->TS map that type-aware rules depend on, and breaks ESLint's
range-ordering invariants (a tree mixing real and synthetic positions). The processor's
"lint-the-projection then drop scaffolding-located messages in postprocess" handles exactly this case
cleanly. So we keep the processor for mapping/drop and add the parser **only** to supply the program.

**Building a dedicated TypeScript program for ESLint.** Rejected per requirement #2 ("reuse the existing
Language Service Program"): it would double the type-check cost and risk drifting from what the editor
and `azeroth-tsc` see. The pool reuses the one program.

## How parserServices / program reuse works

1. `preprocess` calls `registerDocument(file, source)`, which `openDocument`s the file in the pooled
   `AzerothProject`. The project presents every `.azeroth` file to TypeScript under its virtual twin
   `‹file›.azeroth.ts`, so after registration the program contains that twin (with full types,
   cross-file `.azeroth` resolution, and the project's own `lib`/ambient declarations).
2. The virtual block ESLint hands the parser is named `‹file›.azeroth/0.ts`; the parser derives the
   `.azeroth` path from it, looks up the same pooled project, and calls
   `@typescript-eslint/parser.parseForESLint(virtual, { programs: [program], filePath: twin })`.
3. In program mode, `typescript-estree` uses the program's existing `SourceFile` for the twin (it does
   **not** re-parse), so the returned `services.esTreeNodeToTSNodeMap` maps ESTree nodes to the very TS
   nodes the program's `typeChecker` knows. Type-aware rules call
   `services.getTypeChecker().getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node))` and get real
   types - verified: `no-floating-promises` and `strict-boolean-expressions` fire on `.azeroth`.

Paths are normalised to absolute, forward-slashed form (`project-pool.ts`) so the document the processor
registers and the file the parser looks up key to the same project and twin, regardless of OS separator.

## How the mapping works

The compiler's `CodeMapping` is a list of **verbatim segments** - spans copied byte-for-byte from source
to virtual. `postprocess`:

- maps a message's start/end (1-based line/col -> offset -> `toOriginal` -> offset -> line/col); a start in
  scaffolding (`toOriginal === null`) drops the message;
- maps a fix by mapping **both** endpoints with `toOriginal` and accepting it only when the source slice
  is byte-identical to the virtual slice it replaces - so an autofix rewrites exactly the text the rule
  intended and never reaches into scaffolding;
- offsets are computed over UTF-16 code units (ESLint/TS convention); CRLF and surrogate pairs are
  fuzz-tested (see Compatibility.md / the source-map fuzz test).

## Why formatting rules cannot be supported (proof, not a punt)

Formatting splits into two kinds, and **both** fail for a sound, intrinsic reason:

1. **Structure-driven layout** (`indent`, `brace-style`, `padded-blocks`, `key-spacing`, ...) derives the
   *expected* layout from **AST nesting**. The AST is the projection's structure - a `FunctionDeclaration`
   wrapping `VariableDeclaration`s and `CallExpression h(...)` - **not** the source's structure
   (`component`, markup elements, `state`/`derived`). Expected indentation computed from
   `function -> block -> statement` nesting has no correct meaning when applied to `component X { <div>...`.
   No range mapping can fix this: the divergence is structural, not positional.
2. **Whitespace-scanning rules** (`no-trailing-spaces`, `no-multiple-empty-lines`, `*-spacing`) examine
   the text between tokens. In this architecture rules run over the **virtual** module's text (the
   projection re-flows whitespace and re-emits scaffolding), so they see the projection's whitespace, not
   the source's. Mapping a message back to the source produces a location that doesn't correspond to a
   real whitespace decision the user made.

Therefore formatting `.azeroth` is the **language-service formatter's** job (`getFormattingEdits`), and
the recommended config turns the layout family off for `.azeroth`. (Rules that act on verbatim *token
content* - `quotes`, `eqeqeq` - are unaffected and remain on.)

## Files

| File | Role |
|---|---|
| `src/azeroth-processor.ts` | preprocess -> project; postprocess -> map messages + fixes, drop scaffolding, merge compiler diagnostics |
| `src/azeroth-parser.ts` | `parseForESLint`: parse the virtual twin in program mode against the pooled program => parserServices |
| `src/project-pool.ts` | one reused `AzerothProject` (LS program) per workspace root; path normalisation |
| `src/index.ts` | plugin + `configs.recommended` (processor for `.azeroth`, parser + tuning for the virtual blocks) |
| `COMPATIBILITY.md` | per-rule-category compatibility (✅ / ⚠ / ❌ with reasons) |
| `PERFORMANCE.md` | cold/warm/incremental lint cost and the program-reuse model |
