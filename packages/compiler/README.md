<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/compiler

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fcompiler?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/compiler)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework. Applications usually install [`azerothjs`](https://www.npmjs.com/package/azerothjs); depend on this package directly for a narrower surface.

## Overview

The `.azeroth` single-file-component compiler. A `.azeroth` file is a TypeScript module written with
`component` blocks and AzerothJS markup. The compiler turns each component into one mode-aware runtime
artifact and copies everything outside a component (imports, types, helpers) through unchanged.

The supported way to use it is the **Vite plugin** - add `azeroth()` to a Vite config and imports of
`.azeroth` files just work, with source maps back to the original markup and build-time lint and
diagnostics.

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { azeroth } from '@azerothjs/compiler';

export default defineConfig({ plugins: [azeroth()] });
```

It has no runtime dependencies; `typescript` is a peer dependency (used for parsing component
expressions) and `vite` is a peer dependency loaded only at transform time.

## Install

```sh
npm install -D @azerothjs/compiler
```

## Architecture

`.azeroth` is component-only - there is no standalone markup transform. The pipeline, in run order:

1. **parser** - splits the source into `component` declarations and pass-through (opaque) regions, and
   parses each component body into items (`props`/`state`/`derived`/`effect`/markup output). Inner
   JS/TS is left as source spans.
2. **analyze** - for each component, finds the reactive sources and the dependency set every
   expression reads, using the TypeScript parser for scope-correct read collection.
3. **lower** - turns the markup output plus analysis into a target-independent **Render Plan IR**: a
   static template skeleton plus a list of surgical bindings.
4. **optimize** - IR -> IR passes (constant folding).
5. **codegen** - emits one artifact from the IR through a single emitter. Reactive reads become getter
   calls and writes become setter calls.

There is **one IR and one emitter**. An element-rooted output emits a mode-dispatched body: a hoisted
`<template>` cloned on the client, the same tree serialized to HTML for SSR, and adopted on hydration.
Because SSR and hydration share the emitter, their comment markers line up by construction.

## Public API

The supported entry point is the Vite plugin; the lower-level pieces are exported for tooling.

- `azeroth(options?)` - the Vite plugin (`options.extension` defaults to `'.azeroth'`;
  `options.typeCheck` toggles build-time type checking, default `true`).
- `parseModule(source)` - parse a `.azeroth` module into its AST (components + opaque regions).
- `diagnoseModule(source)` - semantic diagnostics the type system can't see (inert effects, constant
  deriveds, setup-time event handlers, ...).
- `typeCheckModuleTS(source, options?)` - real TypeScript-backed type checking of handlers and
  component props (`options.fileName` enables cross-file resolution). Used by the plugin's
  `typeCheck` option.
- `lintSource(source)` / `lintMarkup(node)` - markup lint (duplicate attributes, lowercase event
  names).
- `parseMarkup(source, start)` / `CompileError` - parse one markup region beginning at a `<`.
- `findMarkupStart` and the scanner helpers (`skipString`, `skipTemplate`, `skipBalanced`,
  `skipRegex`, `isIdentStart`, `isIdentPart`, `isWhitespace`, comment skippers) - markup-region
  scanning over arbitrary JS/TS.
- `walkComponentTags(node, visit)` - visit the component tags in a markup tree.
- Source-map helpers (`vlqEncode`, `buildLineStarts`, `locationFor`, `encodeMappings`) and the markup
  AST types (`Span`, `MarkupElement`, ...).

Every exported symbol is documented at its definition.

## Authoring idiom and reactivity

A component is a `component` block. Declare reactive state with `state`, derived values with
`derived`, and side effects with `effect`, and type props with an ordinary TypeScript parameter on the
`component` signature. You read and write state as plain variables; the compiler rewrites a read of
`count` to `count()` and a write `count = x` / `count++` to the signal's setter, so reactivity is
resolved at compile time with a tiny runtime.

```azeroth
component Greeting(props: { name: string })
{
    <p>Hello {props.name}</p>
}
```

The parameter is plain TypeScript, so every natural form works: a named interface
(`component Greeting(props: GreetingProps)`), a destructured binding with defaults
(`component Greeting({ name = "world" }: GreetingProps)`), or an inline object type. A destructured
prop stays reactive - a bare `name` read lowers to `props.name`.

### Reactive keywords: effect, deferred, and the block-wrappers

The reactive vocabulary is deliberately small. Each keyword maps to one runtime primitive; everything
else (resources, roots, stores, error handling, ...) stays an ordinary import + function call.

**`effect { ... }`** - runs on mount and re-runs whenever the reactive values it reads change. Purely
auto-tracked (it discovers its dependencies by running its body). A `with { ... }` clause passes options
(e.g. `name`) to `createEffect`:

```azeroth
effect { document.title = `${ count } now`; }
effect with { name: 'sync' } { syncToServer(data); }   // -> createEffect(fn, { name: 'sync' })
```

**`effect (deps) [(values, prev)] [with { ... }] { ... }`** - an explicit-dependency effect (the `on`
primitive). It tracks *exactly* the listed deps (the body's other reads do not subscribe); the
optional `(values, prev)` binds the current and previous dependency-value tuples; `with { skipInitial: true }`
skips the mount run.

```azeroth
effect (count) { logServer(count); }                     // -> on([() => count()], () => { ... })
effect (a, b) (cur, prev) { diff(prev, cur); }            // current + previous value tuples
effect (count) with { skipInitial: true } { save(count); }      // skip the mount run -> on(..., { skipInitial: true })
```

**`deferred name = expr [with { ... }]`** - a read-only reactive value like `derived`, but recomputed at
idle priority. Compiles to `createDeferred(() => (expr), options?)`; reads are bare like any source.

**Block-wrappers** - `<keyword> { ... }` -> `<fn>(() => { ... })`, with the body reactively rewritten:

| Keyword | Runtime | Use |
|---|---|---|
| `batch { ... }` | `batch` | coalesce a burst of writes into one effect flush |
| `untrack { ... }` | `untrack` | run without subscribing the active effect |
| `cleanup { ... }` | `onCleanup` | teardown registered inside an effect (runs before re-run/dispose) |
| `dispose { ... }` | `onRootDispose` | teardown for the surrounding scope (runs once on dispose) |

```azeroth
effect {
    const id = setInterval(tick, 1000);
    cleanup { clearInterval(id); }
}
batch { firstName = 'Ada'; lastName = 'Lovelace'; }   // -> batch(() => { setFirstName(...); setLastName(...); })
```

All of these work at the component top level **and** in nested scopes (render callbacks, IIFEs, and
module-level composable functions). For hand-written `.ts`, the same runtime functions are imported and
called directly - `createEffect`/`on`/`batch`/`untrack`/`onCleanup`/`onRootDispose`/`createDeferred`.

How the compiler emits each dynamic `{expr}` decides whether it is reactive:

- **On a host element**: an event handler (`onClick={...}`), a function literal, a bare reference, or an
  array/object literal is passed through verbatim; any other expression is wrapped in a getter
  `() => (expr)` so the runtime re-applies it when the signals it reads change.
- **On a component tag**: every prop is passed as a getter-object entry
  (`Child({ get name() { return expr } })`), read uniformly as `props.name`, so one prop contract
  covers user, library, and built-in components.

For conditional classes and styles the canonical authoring form is the directive: `class:active={isActive}`
toggles one class, `style:color={tone}` sets one property, and both merge with a static `class="..."` /
`style="..."` on the same element. Reach for the `classList()` / `styleMap()` helpers (from
`azerothjs`) only when the whole set is computed from an object; they return a getter the renderer
resolves by calling through while it is still a function, so `class={classList(obj)}` needs no
special-casing in the compiler.

Two-way input binding follows the same pattern: `bind:value={state}` (and `bind:checked={state}`) is the
canonical mirror for a form control or a value-bearing component, desugaring to the value prop plus the
write-back listener/callback. Keep the explicit `value={state}` + `onInput={...}` form for inputs that
transform, validate, or otherwise do more than mirror.

A whole form is the `form` keyword (lowers to `createForm`): `form f = { ...initial } with { validate, onSubmit }`.
A FIELD reads as `f.field` and binds with `bind:value={f.field}` (the read lowers to `f.values().field`, the
write to `f.setValue('field', v)`); the rest of the form API is explicit - `f.errors()`, `f.touched()`,
`f.submitting()`, `f.handleSubmit`. This is the idiomatic form style; the `createForm` runtime primitive can
also be driven by a hand-built field component when an app prefers that abstraction.

A prop-less, child-less component tag compiles to a zero-argument call (`<Comp/>` -> `Comp()`), so a
component without props never declares an unused props parameter.

### Event handlers (`on*` attributes)

An event-handler attribute is a **function position**: its value must be a function - the listener
invoked when the event fires (`(event) => void`). That is the whole rule; everything else follows
from it. The value is an ordinary TypeScript expression, so the authoritative check is the **type
system**: an expression whose type is not a function is ill-typed in handler position.

The three canonical, always-correct forms:

| Form | Example | Why it is a function |
| --- | --- | --- |
| Reference | `onClick={save}`, `onClick={props.onClose}` | the name *is* the function |
| Inline function | `onClick={() => count++}`, `onClick={(e) => save(e)}` | a function literal |
| Factory call | `onClick={makeHandler(id)}` | a call that *returns* a function |

Independently of types, the compiler **rejects at build time** any handler expression that is
recognizably a *side effect performed when the component is created*, not a function. Exactly three
forms are rejected:

1. an **assignment** - `count = 1`, `x += y` (any assignment operator);
2. an **increment / decrement** - `count++`, `--n`;
3. a **no-argument call of a plain name or path** - `save()`, `props.onClose()`, `actions.reset()`.

Each runs once at setup and yields a non-function value, so wiring it as a listener never does what
the author intended. The fix is always to make it a function - `onClick={() => count++}` or
`onClick={save}`.

**Why `makeHandler(id)` is accepted but `save()` is rejected.** This is not "arguments make a call
valid." The compiler is a *conservative rejecter*: it flags only what it can prove - without type
information - is a setup-time mistake, and stays silent on everything else, deferring to the type
system. `save()`, a plain name called with no arguments, is unmistakably "call `save` now" (the single
most common handler error), so it is rejected. `makeHandler(id)` matches no such pattern, so the
compiler does not flag it; whether it truly returns a function is then a type question. Acceptance by
the compiler means "no provable error here," not "guaranteed correct" - only the type checker
guarantees that.

**Mental model:** *a handler is a function - pass one.* When in doubt, write `() => ...`. Use a factory
call only when it returns a handler; a *zero-argument* factory (`getHandler()`) is syntactically
indistinguishable from the `save()` mistake and is therefore rejected - bind it to a name first
(`const handler = getHandler();` ... `onClick={handler}`).

### TypeScript syntax (the TSX rules)

Because `.azeroth` mixes markup with TypeScript, it follows the same disambiguation rules as `.tsx`:

- **No angle-bracket type assertions.** Write `value as Foo`, not `<Foo>value` - a `<Foo>...` is read
  as a markup element, so a forgotten `</Foo>` is reported as an unclosed tag where it sits rather
  than silently compiling as a cast.
- **Generic arrows need a trailing comma.** Write `<T,>(v: T) => v`; the comma tells the parser the
  `<T,>` is a type-parameter list, not a tag. Type arguments in call position (`foo<Bar>(x)`,
  `new C<Bar>()`) are unaffected.

Precise boundary (for tooling authors): after stripping wrapping parentheses, a handler is rejected
iff it is an assignment expression, a prefix/postfix `++`/`--`, or a zero-argument call (including
`?.()`) whose callee is an identifier or a dotted member path. Every other expression - a reference, a
function literal, a call with arguments, or a call whose callee is itself a call or an index access - 
is left to the type system.

## Type checking and diagnostics

Three independent layers run during a build, in increasing depth.

**Lint** (`lintSource`) - markup nits that need no type knowledge: duplicate attributes, lowercase
event names. Reported as warnings.

**Semantic diagnostics** (`diagnoseModule`) - mistakes the parser can see but the type system cannot:
an `effect` or `derived` with no reactive dependency (warning), a duplicate `props` block or a write
to a read-only `derived` (error). Error-severity diagnostics fail the build.

**Unused imports** (`diagnoseUnusedImports(source, compiledJs)`) - an `azeroth/unused-import` warning
for any import never used. Detection is reliable because it walks the COMPILED JS (markup already
lowered to `h()`/component calls) for value use, then cross-checks the source so a type-only import
(`import type { T }`, used in a props annotation `component C(props: { x: T })`) is never falsely
flagged. Runs in the Vite plugin
(which has the compiled output); warning severity, located at the unused name.

**Type checking** (`typeCheckModuleTS`) - a real TypeScript-backed checker, **on by default**
(disable with `azeroth({ typeCheck: false })`). It projects each `.azeroth` module to TypeScript, runs
the real TypeScript `TypeChecker`, and fails the build on a genuine type error, located back in the
`.azeroth` source:

- a **non-function event handler** - `onClick={count}` where `count` is a number (exactly the
  type-only mistake the handler rule above defers to the type system);
- a **wrong-typed component prop** - `<Child count={"x"} />` where `count: number`;
- a **missing required prop** - `<Child />` when `Child` requires `count`. A component that takes its
  children as markup (`<Card>...</Card>`) satisfies a required `children` prop automatically;
- a **misused built-in control-flow component** - the built-ins (`For`, `Show`, `Switch`, ...) are
  checked against their real runtime prop types, so a `<For>` missing its required `key` (a runtime
  crash) or with a non-iterable `each` is caught.

Component prop checks resolve across files: props on a component **imported from another `.azeroth`
file** are checked through TypeScript's module resolver (the import may use the explicit `.azeroth`
extension or omit it). `on*` props on a component are typed by the receiving component, not as DOM
events. The check is **sound** - it never reports a false error. It is enabled by default; turn it off
with `typeCheck: false` if you want to skip it. The (immutable) TypeScript lib files are parsed once
and reused across files, so a typical component checks in single-digit milliseconds; a fully shared
incremental Program remains a possible future optimization.

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
