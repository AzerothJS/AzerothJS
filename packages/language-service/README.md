# @azerothjs/language-service

## Overview

Compiler-aware language intelligence for `.azeroth` files, packaged so it can be
driven by any editor frontend. The bundled LSP server
(`@azerothjs/language-server`) is a thin adapter over this package; the test
suite and any other host use it directly.

```ts
import { AzerothLanguageService } from '@azerothjs/language-service';

const ls = new AzerothLanguageService(process.cwd());
ls.didOpen('file:///App.azeroth', 'export default () => <h1>Hi {name()}</h1>;');
ls.getHover('file:///App.azeroth', { line: 0, character: 32 }); // the type of name()
```

The package depends only on `typescript` and `@azerothjs/compiler`, so it runs
(and is unit-tested) without an editor in the loop.

## Architecture

A `.azeroth` file is a TypeScript module whose markup regions are written in
AzerothJS markup syntax. The AzerothJS compiler has no separate type system, symbol
table, or semantic analyzer: it locates markup regions and rewrites them into
`h(...)` calls, leaving everything else byte-for-byte. The authoritative
semantic engine for the language is therefore TypeScript itself.

That observation drives the whole design. Rather than re-implement type
inference, scope resolution, or symbol tables, the service:

1. Reuses the compiler (`scanner`, `parser`, AST, `walkComponentTags`) to locate
   and understand markup.
2. Compiles each `.azeroth` file to a virtual TypeScript module that matches
   what the compiler ships, while recording a precise, bidirectional offset map
   for every user-authored span.
3. Runs a single `ts.LanguageService` over those virtual modules. Every
   type-aware feature (inference, completion, hover, definitions, references,
   rename, signatures, diagnostics) comes from the TypeScript compiler.
4. Layers a markup model on top for the things TypeScript cannot know about:
   HTML tags, attribute and event names, and built-in components.

The dependency direction is one way. The facade (`service.ts`) owns the four
foundational modules; the providers build on all of them:

```
service.ts (facade)
  markup-model.ts    classify the caret; reuses scanner + parser
  virtual-code.ts    .azeroth to virtual TS + CodeMapping; reuses scanner + parser
  ts-project.ts      ts.LanguageService host over virtual files; cross-file resolve
  language-data.ts   HTML/event vocabulary + built-in component data

  providers/         one focused module per feature, built on the four above:
    completion, hover, navigation, symbols, diagnostics, signature,
    semantic-tokens, structure (folding/code-actions/format), editing,
    inlay-hints, html-service, css-service
```

### Virtual code and offset mapping

This is the keystone of the package. `<h1>Count: {count()}</h1>` compiles to
`h('h1', {  }, 'Count: ', () => (count()))`. `virtual-code.ts` walks the same
parser AST the compiler uses, emitting the same `h()` and component calls. Every
user-authored slice (the script between markup, expression-hole bodies,
attribute expressions, and component tag names) is copied byte-for-byte and
registered as a `MappingSegment`. Generated scaffolding (`h('h1', {`, quotes,
getters) is emitted but not mapped.

Because those copied spans are equal length, an offset inside one translates by
a simple additive shift. `CodeMapping` (`mapping.ts`) stores the segments sorted
both ways and binary-searches them, so:

- a request at an original offset is translated with `toGenerated`, then asked
  of TypeScript;
- each `TextSpan` TypeScript returns is translated back with `toOriginal` into
  an editor range.

The markup-bearing portion of a real `.azeroth` file is small relative to the
surrounding TypeScript, so the majority of every file is copied 1:1. That is why
the TypeScript-powered features behave consistently across the whole document.

If the markup fails to parse mid-edit, `generateVirtualCode` copies the
remainder verbatim instead of throwing, so completion and hover keep working
while the user is still typing.

### Where intelligence comes from

There is no second language implementation. Intelligence is split along the seam
the compiler already defines:

- Everything that is TypeScript (variables, functions, classes, generics, types,
  imports, scopes, visibility, the runtime API, and type inference) is answered
  by the `ts.LanguageService` in `ts-project.ts`, queried at mapped offsets. The
  runtime packages ship `.d.ts` and JSDoc, so this stays in sync with the
  framework.
- Host-element HTML (valid tags, attributes, attribute values, and MDN
  documentation) is answered by `vscode-html-languageservice`, the same engine
  VS Code's HTML support uses, applied to an embedded HTML view of the markup
  (`html-source.ts` and `providers/html-service.ts`).
- Inline `style="..."` values are answered by `vscode-css-languageservice`
  (`providers/css-service.ts`).
- Framework markup (the built-in components, their props, and the camelCase
  `on*` events AzerothJS binds) is the AzerothJS layer, from `language-data.ts`
  (transcribed from the runtime's own prop interfaces) and the TypeScript bridge
  (for user components).
- `markup-model.ts`, built on the compiler's parser, decides which of these
  applies at the caret.

`AzerothProject` presents each `Foo.azeroth` to TypeScript as a synthetic
`Foo.azeroth.ts` whose contents are the virtual module. It resolves
`import './Bar.azeroth'` to `Bar.azeroth.ts` (its virtual twin) so types and
definitions flow across `.azeroth` files, reads every real file from disk, and
honours the nearest `tsconfig.json` (including its `paths`), forcing only the
options the virtual modules require.

## Components

| File | Role |
| --- | --- |
| `service.ts` | The `AzerothLanguageService` facade; one instance per workspace. |
| `virtual-code.ts` | Compiles `.azeroth` to virtual TS with a `CodeMapping`. Reuses the compiler. |
| `mapping.ts` | `CodeMapping`: binary-searched bidirectional offset translation. |
| `markup-model.ts` | Caret classification and markup-node collection (reuses scanner/parser). |
| `ts-project.ts` | `AzerothProject`: the `ts.LanguageService` host over virtual files. |
| `language-data.ts` | HTML/event vocabulary and built-in component data. |
| `html-source.ts` | Builds the embedded HTML view (non-markup blanked to spaces). |
| `request.ts` | Per-request context plus offset/range translation helpers. |
| `text.ts` | `LineIndex`: line/column to offset conversion. |
| `uri.ts` | URI to filesystem path conversion. |
| `protocol.ts` | LSP-shaped result types, kept independent of the server package. |
| `providers/*.ts` | One focused module per editor feature. |

The public API is the `AzerothLanguageService` facade. Its lifecycle methods are
`didOpen`, `didChange`, and `didClose`; the rest are query methods named after
the LSP request they serve (`getCompletions`, `resolveCompletion`, `getHover`,
`getDefinition`, `getReferences`, `getRenameEdits`, `getDocumentSymbols`,
`getDiagnostics`, `getSemanticTokens`, `getCodeActions`, and so on). Result types
already mirror the LSP shapes, so the server adapter is close to a passthrough.

### Completion (`providers/completion.ts`)

Completion is context-first. `classifyPosition` (resilient to half-typed input)
decides which vocabulary applies:

| Caret context | Suggestions |
| --- | --- |
| Tag name (`<di`, `<Cou`) | HTML elements (with MDN docs) plus built-in components plus in-scope, non-ambient PascalCase identifiers (user components, via TypeScript). |
| Attribute name (`<button cla`) | Host element: HTML attributes plus camelCase DOM events. Component: its documented props and events. |
| Attribute value (`<input type="`) | Host element: HTML value enums and booleans from the HTML engine. Inline `style`: CSS property/value completion. |
| Expression / script / text | Full type-aware TypeScript completion at the mapped offset, plus tag suggestions immediately after a `<`. |

User-component candidates come from TypeScript completion entries filtered to
PascalCase values that are not `declare`d ambients, so `<Cou` offers the imported
`Counter` rather than the thousands of global DOM and JS types. TypeScript-sourced
items carry a `data` payload so `resolveCompletion` can fetch detail and JSDoc
lazily, and may attach an auto-import edit through `additionalTextEdits`. Snippet
completions (for example `when={$0}`) are emitted for component props and events.
Ranking is via `sortText`.

### Hover (`providers/hover.ts`)

For any mapped position (the script, an expression hole, an attribute expression,
or a component tag name) hover is TypeScript's quick-info: signature plus JSDoc,
rendered as Markdown. Host-element markup uses the HTML language service's
MDN-backed hover, with a fallback table for common form attributes the standard
HTML dataset ships without descriptions. Built-in components show their framework
documentation. Context is decided before the offset map is consulted, so a host
tag never shows a stray TypeScript result mid-edit.

### Navigation and symbols (`providers/navigation.ts`, `providers/symbols.ts`)

Definition, type-definition, references, and rename are TypeScript queries at the
mapped offset. Results are document spans that may live in this file or another
(`.azeroth` or `.ts`); `resolveLocation` maps a virtual-file span back through
that file's `CodeMapping` and reports the `.azeroth` URI, while real files report
directly. A declaration that contains markup straddles generated scaffolding, so
its full span is not one contiguous mapping; document symbols map the two
endpoints (which sit in verbatim script) independently to recover the source
range. Workspace symbols use TypeScript's `getNavigateToItems`.

### Diagnostics (`providers/diagnostics.ts`)

Two sources, prioritised. First, markup parse errors: the compiler's own
`parseMarkup` is run over each region and a `CompileError` is reported at its
exact offset with `source: 'azeroth'`. A hard markup error means the virtual
module is incomplete, so TypeScript diagnostics would be noise and are suppressed
until the markup parses. Second, TypeScript syntactic and semantic diagnostics
over the virtual module, mapped back to original ranges; diagnostics that land
purely in generated scaffolding are dropped, so what surfaces are genuine errors
in the user's expressions and script (`source: 'azeroth-ts'`).

### Structure (`providers/structure.ts`)

Quick fixes reuse TypeScript's `getCodeFixesAtPosition` for the diagnostics at a
range, with the resulting edits mapped back to the source. Formatting runs
TypeScript's formatter over the virtual module and keeps only the edits that fall
inside mapped (user-authored) spans, tidying the script and expressions without
disturbing the markup. This module also provides folding ranges, on-type
formatting, and selection ranges.

## Development

The source is TypeScript with ESM `.ts`-extension imports, 4-space indentation,
and Allman braces, matching the rest of the monorepo. Each module carries a
header comment describing its responsibility, and exported symbols carry JSDoc.

A good reading order follows the runtime pipeline: `virtual-code.ts` and
`mapping.ts`, then `ts-project.ts`, then `markup-model.ts`, then the providers,
then `service.ts`.

## Building

```sh
npm run build -w @azerothjs/language-service
```

This runs `tsc -p tsconfig.build.json` and emits `dist/`. The build depends on
`@azerothjs/compiler` being built first; the repository root `npm run build`
builds the packages in dependency order.

## Testing

Tests live under `test/language-service/` at the repository root and run with
Vitest:

```sh
npm test                       # whole repository
npx vitest run test/language-service
```

`language-service.test.ts` exercises the public facade end to end (completion,
hover, diagnostics, navigation) and `virtual-code.test.ts` checks the
compilation and offset mapping directly. Because the package needs no editor, the
tests construct an `AzerothLanguageService` over a temporary workspace and assert
on its results.

## Configuration

The service reads the nearest `tsconfig.json` for each file and analyses
`.azeroth` against it exactly as `tsc` would a `.ts`: `compilerOptions.paths`,
`baseUrl`, `types`, and `lib` are all honoured (the parsed options are spread
through), and only the options the virtual modules require (TypeScript source,
bundler-style module resolution, `noEmit`) are forced.

The project's own ambient/global declaration roots - the `.d.ts` files the
tsconfig already includes - are loaded into the program too. This is what makes a
Vite app's `src/vite-env.d.ts` (`/// <reference types="vite/client" />`) apply
inside `.azeroth`, so `import.meta.env.X`, `*.css`, and `?url` asset imports
resolve in a `.azeroth` file the same way they do in a `.ts` file. Provide the
tsconfig explicitly with `new AzerothLanguageService(dir, configPath)` when it is
not the nearest one.

Per-feature toggles are passed in by the caller through `CompletionOptions` and
`InlayHintOptions`; the server maps editor settings onto these.

### Command-line type checking (`azeroth-tsc`)

For CI and pre-commit, `@azerothjs/language-server` ships an `azeroth-tsc` binary
that batch-checks `.azeroth` files through this service and reports `tsc`-style
diagnostics mapped to original positions, exiting non-zero on error:

```sh
npx azeroth-tsc            # check every .azeroth file under the cwd
npx azeroth-tsc -p tsconfig.json
```

## Examples

`packages/compiler/examples/Showcase.azeroth` is a single comprehensive file
(both a function component and a class component) used to exercise the features
by hand in an editor.

## Contributing

Keep the seam intact: anything that is really TypeScript should be answered by
the TypeScript bridge rather than re-implemented, and anything markup-specific
belongs in `markup-model.ts` or `language-data.ts`. New features generally take
the shape of a new module under `providers/` plus a method on the facade. Add or
update tests under `test/language-service/`, and run the build with
`--noUnusedLocals --noUnusedParameters` (the repository default) before sending a
change.
