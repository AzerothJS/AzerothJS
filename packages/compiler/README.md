# @azerothjs/compiler

## Overview

The `.azeroth` single-file-component compiler. A `.azeroth` file is a JavaScript
or TypeScript module written with AzerothJS markup. The
compiler locates the markup regions inside otherwise ordinary code and rewrites
them into `h()` hyperscript calls with fine-grained reactive bindings, leaving
the rest of the module byte-for-byte. For example:

```
<h1>Count: {count()}</h1>
```

compiles to:

```js
h('h1', {}, 'Count: ', () => (count()))
```

It has no runtime dependencies and is used both as a build-time tool (the Vite
plugin) and as the shared language core that the editor tooling reuses.

## Architecture

The compiler does not have a type system, symbol table, or semantic analyzer. It
treats a `.azeroth` file as code with embedded markup and only transforms the
markup, which is why the rest of the module passes through unchanged. The
pipeline, in the order it runs:

1. Scanner: finds markup regions inside arbitrary JavaScript, correctly skipping
   strings, template literals, comments, and regular expressions, and detecting
   whether a `<` begins markup or is a comparison or generic.
2. Parser: turns a markup region into an AST (`parseMarkup`).
3. Codegen: turns the AST into `h()` and component-call source, adding the
   reactive wrapping (`() => (...)`) around dynamic expressions.
4. Compile: orchestrates scan, parse, codegen, and splice back into the module,
   producing the output plus a source map.

The scanner and parser are exported because the editor tooling
(`@azerothjs/language-service`) reuses them as its single source of truth for
markup behavior, rather than re-implementing a second parser that could drift.

## Components

| File | Role |
| --- | --- |
| `scanner.ts` | Markup-region detection and the low-level skip helpers. |
| `parser.ts` | `parseMarkup` and `CompileError`. |
| `codegen.ts` | `generate`, `walkComponentTags`, the `ExpressionCompiler` hook. |
| `compile.ts` | `compile`: the end-to-end entry point and `CompileResult`. |
| `sourcemap.ts` | Source-map construction (VLQ encoding, mappings). |
| `vite.ts` | `azeroth`: the Vite plugin and its options. |
| `types.ts` | The markup AST node types and `Span`. |

### Public API

- `compile(source, filename?)` returns the compiled module and its source map.
- `parseMarkup(source, start)` parses one markup region to an AST node.
- `generate(node, compileExpression)` emits source for a markup AST node.
- `walkComponentTags(...)` visits component tags in a region.
- The scanner helpers (`findMarkupStart`, `skipString`, `skipTemplate`,
  `skipBalanced`, `skipRegex`, `isIdentStart`, `isIdentPart`, `isWhitespace`,
  and the comment skippers) are exported for tooling that needs the same
  scanning behavior.
- `azeroth(options?)` is the Vite plugin.

## Building

```sh
npm run build -w @azerothjs/compiler
```

Several other packages (the language service and server, and anything importing
the AST or scanner) depend on the compiler being built first; the repository root
`npm run build` builds in dependency order.

## Testing

```sh
npx vitest run test/compiler
```

## Configuration

The Vite plugin (`azeroth`) compiles `.azeroth` files as part of a Vite build.
Add it to a project's `vite.config`:

```ts
import { azeroth } from '@azerothjs/compiler';

export default {
    plugins: [azeroth()]
};
```

## Authoring idiom and reactivity rules

A component is a plain function that returns markup; there is no
`defineComponent` wrapper. Props are the function's first argument, read where
they are used so they stay reactive:

```
function Greeting(props: { name: string })
{
    return <p>Hello {props.name}</p>;
}
```

How the compiler emits each dynamic `{expr}` decides whether it is reactive:

- An event handler (`onClick={…}`), a function literal, a bare reference
  (`draft`, `props.x`), or an array/object literal is passed through verbatim.
- Any other expression is wrapped in a getter, `() => (expr)`, so the runtime
  re-applies it when the signals it reads change. `value={draft()}` becomes
  `value: () => (draft())`.

`classList()` and `styleMap()` (from `@azerothjs/core`) return a getter, so a
`class={classList({ active: isActive })}` ends up wrapped as a
getter-returning-a-getter. The renderer resolves a reactive value by calling
through while it is still a function, so this works without special-casing in
the compiler - see `DECISIONS.md` (entry 1) for why the fix lives in the
renderer rather than here.

An attribute-less, child-less component tag compiles to a zero-argument call,
`<Comp/>` -> `Comp()`, so a prop-less component never has to declare an unused
props parameter (`DECISIONS.md`, entry 2).

## Type checking

The compiler only transforms markup; it does not type-check. `tsc` cannot parse
`.azeroth`, so use `azeroth-tsc` (from `@azerothjs/language-server`) to gate a
build, the same way `vue-tsc` does for Vue:

```sh
npx azeroth-tsc            # check every .azeroth file under the cwd
npx azeroth-tsc -p tsconfig.json
```

It compiles each file to its virtual TypeScript module, type-checks it against
the project's tsconfig, and prints `tsc`-style diagnostics mapped back to the
original `.azeroth` positions, exiting non-zero on the first error. In the
editor, `@azerothjs/language-service` provides the same analysis live.

## Examples

`examples/Showcase.azeroth` is a single comprehensive `.azeroth` file (a function
component and a class component) used to exercise both the compiler and the
editor tooling. Compile a string directly:

```ts
import { compile } from '@azerothjs/compiler';

const { code, map } = compile('export default () => <h1>Hi {name()}</h1>;', 'App.azeroth');
```

## Contributing

The scanner is the trickiest part: it must distinguish markup from comparison and
generic syntax and skip every JavaScript token kind, because a mistake there
mis-compiles otherwise valid code. Keep its behavior covered by tests under
`test/compiler`, and remember that the language service depends on the exported
scanner and parser behaving exactly as the compiler uses them.
