# @azerothjs/eslint-plugin

ESLint rules for AzerothJS reactivity foot-guns, plus a processor that makes a
whole `.azeroth` single-file component — **script and markup** — lintable with a
normal TypeScript ruleset. Every configured rule runs, and every autofix applies,
exactly as on a `.ts`/`.tsx` file.

Requires ESLint 9+ (flat config).

## Install

```sh
npm i -D @azerothjs/eslint-plugin
```

## Usage (flat config)

`configs.recommended` is an **array** — spread it into your config. It contributes
three entries: the reactivity rules (applied everywhere, including the surfaced
`.azeroth` script), the `.azeroth` processor wiring, and the markup parser for the
surfaced virtual block.

```ts
// eslint.config.ts
import tseslint from 'typescript-eslint';
import azeroth from '@azerothjs/eslint-plugin';

export default [
    // Your TypeScript config. This is REQUIRED for `.azeroth` linting to work:
    // the processor surfaces the component script as a virtual `*.azeroth/0_index.ts`
    // block, and that block is only linted if a config's `files` matches `.ts`
    // (and supplies a TS parser). typescript-eslint's configs do exactly that.
    ...tseslint.configs.recommended,

    // AzerothJS reactivity rules + the `.azeroth` processor.
    ...azeroth.configs.recommended
];
```

Then `eslint .` lints `.azeroth` files. Without a `.ts`-matching config (e.g.
`typescript-eslint`), the processor still runs but the surfaced script is skipped
("File ignored because no matching configuration was supplied").

### Manual wiring (without `recommended`)

```ts
import azeroth from '@azerothjs/eslint-plugin';

export default [
    {
        files: ['**/*.azeroth'],
        plugins: { azeroth },
        processor: 'azeroth/azeroth'
    },
    {
        // The reactivity rules; apply wherever you want (they are syntactic).
        plugins: { azeroth },
        rules: {
            'azeroth/no-self-write-in-effect': 'warn',
            'azeroth/require-effect-disposal': 'warn',
            'azeroth/handler-call': 'warn'
        }
    }
];
```

## How the processor works

A `.azeroth` file is a TypeScript module whose markup (`return <div>…`) is not
valid plain TS. The processor surfaces the component **verbatim** as a single
virtual `*.azeroth/0_index.ts` block, and the `recommended` config wires a parser
for that block (`azeroth-parser.ts`) that hands the buffer to
`@typescript-eslint/parser` with markup parsing enabled, so the markup is
understood. Because the block text is byte-for-byte the source, **every lint
message — and every autofix — maps 1:1 back onto the original file** with no
offset bookkeeping.

This means rules lint the script **and** the markup: style rules (`indent`,
`quotes`, trailing-space, …) reach markup expressions, and `no-unused-vars` /
`@typescript-eslint/no-unused-vars` see an import or local used only in markup
(e.g. a `<Widget>` tag) as genuinely used, so they don't false-positive. Autofix
is enabled (`supportsAutofix`), so editor fix-on-save works on `.azeroth` files.

Because everything routes through real ESLint, **all of ESLint's machinery works
unchanged**: flat config and `overrides`, core rules, plugin rules, third-party
rules, custom rules, shared configs, `.eslintignore`/`ignores`, monorepo and
nested configs, and `eslint --fix` / `--fix-dry-run`. There is no allowlist — if a
rule runs on `.ts`, it runs on `.azeroth`.

## Editor integration

The processor is all an editor needs — both editors drive ESLint through their
normal ESLint integration, so diagnostics, the Problems/Problems-view panel,
quick fixes, "Fix all", and fix-on-save behave exactly as for `.ts`/`.tsx`.

### VS Code

The AzerothJS extension already ships the one required default —
`"eslint.validate": ["azeroth"]` — so the official **ESLint extension**
(`dbaeumer.vscode-eslint`) lints `.azeroth` files out of the box: live
diagnostics, the lightbulb/Quick Fix, Disable-rule actions, and the ESLint output
channel. To auto-fix on save, enable it the same way you would for JS/TS (this is
opt-in for every language, not just `.azeroth`):

```jsonc
// .vscode/settings.json
"editor.codeActionsOnSave": { "source.fixAll.eslint": "explicit" }
```

### JetBrains (WebStorm / IDEs with the JavaScript plugin)

WebStorm's **built-in ESLint** runs the same flat config, but its "Run for files"
glob defaults to JS/TS extensions and must be told about `.azeroth` (there is no
plugin API to extend that default safely). One time, in
**Settings → Languages & Frameworks → JavaScript → Code Quality Tools → ESLint**,
set *Run for files* to include `azeroth` and tick *Run eslint --fix on save*. That
persists to the project's `.idea/jsLinters/eslint.xml`:

```xml
<component name="EslintConfiguration">
  <files-pattern value="**/*.{js,ts,jsx,tsx,cjs,mjs,cts,mts,vue,html,json,azeroth}" />
  <option name="fix-on-save" value="true" />
</component>
```

After that, `.azeroth` files get inspections, the Problems view, intentions/quick
fixes, and fix-on-save like any JS/TS file.

## Known limitations

- **Type-aware rules on the markup block.** Rules that need type information
  (`@typescript-eslint/*-type-checked`) don't run on the *surfaced* block: like
  every ESLint processor, the virtual `*.azeroth/0_index.ts` isn't a real file in
  the TS program. Type errors themselves still surface through the language
  server's diagnostics; only type-*aware lint rules* are affected. Syntactic and
  stylistic rules are unaffected.
- **JetBrains needs the one-time glob entry above** — it can't be auto-configured
  from the plugin.

## Rules

| Rule | What it catches |
| --- | --- |
| `azeroth/no-self-write-in-effect` | An effect that reads a signal and writes it back — a synchronous feedback loop. |
| `azeroth/require-effect-disposal` | Effects that allocate (timers, listeners, subscriptions) without `onCleanup`. |
| `azeroth/handler-call` | `onClick={save()}` — calling the handler at render instead of passing it. |

The reactivity rules are syntactic: signals are tracked from
`const [x, setX] = createSignal(...)` destructuring by name, so no type-services
project wiring is needed (the trade-off: aliased or re-exported signals are
invisible).

## Building

```sh
npm run build -w @azerothjs/eslint-plugin
```
