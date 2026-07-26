<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />

# @azerothjs/eslint-plugin

**AzerothJS ESLint rules - reactivity foot-guns in plain .ts files**

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Feslint-plugin?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/eslint-plugin)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

</div>

---

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework. A development-time companion to [`azerothjs`](https://www.npmjs.com/package/azerothjs) - install it as a dev dependency alongside the framework.

ESLint rules for AzerothJS reactivity foot-guns in plain `.ts` files, plus a processor that makes
`.azeroth` a **first-class lint target**: your normal core + `@typescript-eslint` rules run on `.azeroth`
files (reported at original `.azeroth` locations, with autofix), alongside the compiler's own reactivity
diagnostics - all in the same `eslint .` run. It reuses the compiler's projection, so there is no second
parser and no JSX/TSX assumptions. The exceptions are whitespace/formatting rules and type-aware rules:
the projection rearranges markup around the embedded expressions, so those rules only run reliably on
`.ts` files - scope them there.

Requires ESLint 9+ (flat config).

---

## 📦 Install

ESM-only; requires Node >= 22.

```sh
npm install -D @azerothjs/eslint-plugin eslint @typescript-eslint/parser
```

> [!NOTE]
> Peers: ESLint 9+ (flat config) and `@typescript-eslint/parser` 8+. TypeScript
> (`>=5 <7`) is an optional peer - install it to enable the type-aware rules on
> `.azeroth` files.

---

## 🚀 Usage (flat config)

`configs.recommended` is an **array** - spread it into your config:

```ts
// eslint.config.ts
import azeroth from '@azerothjs/eslint-plugin';

export default [
    ...azeroth.configs.recommended
];
```

It contributes two entries:

1. **Reactivity rules** applied to your `.ts` files (where signals are written by hand as
   `createSignal(...)`).
2. **A `.azeroth` processor** (`files: ['**/*.azeroth']`) that projects each `.azeroth` file to its
   virtual TypeScript, lets your `.ts` rules lint it, and maps every message + autofix back to the
   `.azeroth` source - plus a virtual-block entry that tunes what doesn't carry through the projection
   (layout rules off, type-aware rules off, reactivity de-duplicated). **Put `...azeroth.configs.recommended`
   last** so these adjustments win over your other configs.

Then `eslint .` reports `.ts` rule violations, `.azeroth` rule violations, and `.azeroth` reactivity
diagnostics - at correct source locations - in one run.

### Manual wiring (without `recommended`)

```ts
import azeroth from '@azerothjs/eslint-plugin';

export default [
    {
        // Reactivity rules for hand-written signals in `.ts` files.
        plugins: { azeroth },
        rules: {
            'azeroth/no-self-write-in-effect': 'warn',
            'azeroth/require-effect-disposal': 'warn',
            'azeroth/handler-call': 'warn'
        }
    },
    {
        // Surface the compiler's diagnostics for `.azeroth` files.
        files: ['**/*.azeroth'],
        plugins: { azeroth },
        processor: 'azeroth/azeroth'
    }
];
```

---

## 🏗️ How it works

A `.azeroth` file uses `component` / `state` / `effect` / markup syntax that is not valid TypeScript,
so it cannot be linted by feeding the raw text to a TS parser. The **authority on `.azeroth` semantics
is the compiler**: its `diagnoseModule` reports the reactivity foot-guns (self-write-in-effect, a
constant `derived`, an inert `effect`, ...) over the parsed module. The processor runs `diagnoseModule`
and reports each finding as an ESLint message at its exact source location, so `.azeroth` issues appear
in the same `eslint .` run as the rest of your project - without ESLint ever parsing `.azeroth` syntax.

Consequences of this design:

- The processor forwards the compiler's diagnostics only. It does **not** run arbitrary `.ts` rules
  (style, `no-unused-vars`, ...) over `.azeroth` markup, and does **not** autofix.
- Type errors in `.azeroth` files surface through the **language server** (the AzerothJS editor
  extension, or the `azeroth-tsc` CLI), not through ESLint.

The three rules below are syntactic and apply to plain `.ts` files; inside `.azeroth` the equivalent
checks are the compiler's, surfaced by the processor.

---

## 📏 Rules

| Rule | What it catches |
| --- | --- |
| `azeroth/no-self-write-in-effect` | An effect that reads a signal and writes it back - a synchronous feedback loop. |
| `azeroth/require-effect-disposal` | Effects that allocate (timers, listeners, subscriptions) without `onCleanup`. |
| `azeroth/handler-call` | `onClick={save()}` - calling the handler at render instead of passing it. |

Signals are tracked from `const [x, setX] = createSignal(...)` destructuring by name, so no
type-services project wiring is needed (the trade-off: aliased or re-exported signals are invisible).

---

## 📏 Markup rules (inside `.azeroth`)

Your regular ESLint rules already reach INSIDE `{ ... }` expressions: the processor lints the
compiler's TypeScript projection, where every expression is mapped byte-for-byte, so `eqeqeq`,
`space-infix-ops`, `no-unused-vars`, ... fire on markup expressions and their autofixes rewrite the
original `.azeroth` source.

The markup PUNCTUATION around those expressions is a different story - the projection lowers it away,
so no TypeScript-based rule can ever see an interpolation's braces. Those rules live in the compiler
and are surfaced (with working `--fix`) by the processor:

| Rule | What it catches |
| --- | --- |
| `azeroth/interpolation-spacing` | `{expr}` - markup expression braces want exactly one space: `{ expr }` (autofixed; a multiline side is always accepted; spreads `{...props}` stay tight). |
| `azeroth/duplicate-attr` | The same attribute written twice on one element (the later one silently wins). |
| `azeroth/event-case` | `onclick=` for a known DOM event - the convention is camelCase (`onClick`). |

These are always-on warnings (they come from the compiler, not the rule registry), the same findings
the `azeroth()` Vite plugin prints at build time and the editors squiggle.

---

## 🧭 Editor integration

`.azeroth` files lint through the official ESLint integration once it is told to validate the `azeroth`
extension:

- **VS Code** - the AzerothJS extension already ships the required default
  (`"eslint.validate": ["azeroth"]`), so the ESLint extension (`dbaeumer.vscode-eslint`) lints
  `.azeroth` files out of the box: live diagnostics and the Problems panel. Enable fix-on-save the same
  way you would for JS/TS.
- **JetBrains (WebStorm / IDEs with the JavaScript plugin)** - WebStorm's built-in ESLint runs the same
  flat config, but its "Run for files" glob must include `azeroth`. One time, in
  **Settings -> Languages & Frameworks -> JavaScript -> Code Quality Tools -> ESLint**, add `azeroth` to
  *Run for files*.

---

## 🔗 Related

See the [monorepo README](../../README.md) for the full framework. Related tooling:

- [`@azerothjs/language-server`](../language-server) - the LSP server and the `azeroth-tsc` CLI type checker (where `.azeroth` type errors surface).
- [`@azerothjs/typescript-plugin`](../typescript-plugin) - live `.ts` -> `.azeroth` resolution inside `tsserver`.
- Editor extensions: [VS Code](../../editors/vscode), [JetBrains](../../editors/jetbrains).

---

<div align="center">
<sub>Part of <a href="../../README.md">AzerothJS</a> · <a href="https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE">MIT License</a></sub>
</div>
