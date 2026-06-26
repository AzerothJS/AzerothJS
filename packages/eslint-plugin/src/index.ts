// @azerothjs/eslint-plugin: the reactivity foot-guns for plain `.ts` files, plus a `.azeroth` processor
// that surfaces the compiler's own `.azeroth` diagnostics (the authority on the language's semantics) as
// ESLint messages - so `eslint .` reports `.azeroth` issues without ESLint ever parsing `.azeroth` syntax
// (the compiler owns that; see azeroth-processor.ts). The `.ts` reactivity rules are SYNTACTIC by design -
// signals are tracked from `const [x, setX] = createSignal(...)` destructuring by name, so consumers need
// no type-services project wiring (the trade: aliased or re-exported signals are invisible).
//
// Flat-config use - `recommended` is an ARRAY (rules + the .azeroth processor), so spread it:
//
//     import azeroth from '@azerothjs/eslint-plugin';
//     export default [...azeroth.configs.recommended];

import type { ESLint, Linter, Rule } from 'eslint';
import { noSelfWriteInEffect } from './rules/no-self-write-in-effect.ts';
import { requireEffectDisposal } from './rules/require-effect-disposal.ts';
import { handlerCall } from './rules/handler-call.ts';
import { azerothProcessor } from './azeroth-processor.ts';
import { azerothParser } from './azeroth-parser.ts';

// Whitespace / punctuation-placement / layout rules describe the GENERATED module's formatting, not the
// original `.azeroth` source: the projection re-flows whitespace and re-emits scaffolding, so a layout
// violation in the virtual module (a same-line brace, a missing space after a semicolon, an indent
// level) does not correspond to anything in the source - its position and fix would be misleading. These
// can't be made faithful by ANY lint-the-projection approach. Formatting `.azeroth` is the language
// service formatter's job; ESLint on `.azeroth` covers correctness/semantics. So the whole core layout
// family (and the matching `@stylistic/*` rules) is turned off on the virtual blocks. (Rules that act on
// verbatim TOKEN CONTENT rather than inter-token whitespace - e.g. `quotes`, `eqeqeq` - still work and
// are deliberately NOT in this list.)
const LAYOUT_RULE_NAMES =
[
    'array-bracket-newline', 'array-bracket-spacing', 'array-element-newline', 'arrow-parens',
    'arrow-spacing', 'block-spacing', 'brace-style', 'comma-dangle', 'comma-spacing', 'comma-style',
    'computed-property-spacing', 'dot-location', 'eol-last', 'func-call-spacing',
    'function-call-argument-newline', 'function-paren-newline', 'generator-star-spacing',
    'implicit-arrow-linebreak', 'indent', 'jsx-quotes', 'key-spacing', 'keyword-spacing',
    'line-comment-position', 'linebreak-style', 'lines-around-comment', 'lines-between-class-members',
    'max-len', 'max-statements-per-line', 'multiline-ternary', 'new-parens', 'newline-per-chained-call',
    'no-extra-parens', 'no-extra-semi', 'no-floating-decimal', 'no-mixed-operators',
    'no-mixed-spaces-and-tabs', 'no-multi-spaces', 'no-multiple-empty-lines', 'no-tabs',
    'no-trailing-spaces', 'no-whitespace-before-property', 'nonblock-statement-body-position',
    'object-curly-newline', 'object-curly-spacing', 'object-property-newline', 'operator-linebreak',
    'padded-blocks', 'padding-line-between-statements', 'quote-props', 'rest-spread-spacing', 'semi',
    'semi-spacing', 'semi-style', 'space-before-blocks', 'space-before-function-paren', 'space-in-parens',
    'space-infix-ops', 'space-unary-ops', 'spaced-comment', 'switch-colon-spacing',
    'template-curly-spacing', 'template-tag-spacing', 'unicode-bom', 'wrap-iife', 'wrap-regex',
    'yield-star-spacing'
];
const LAYOUT_RULES_OFF: Linter.RulesRecord = Object.fromEntries(
    LAYOUT_RULE_NAMES.flatMap(name => [[name, 'off'], [`@stylistic/${ name }`, 'off']])
);

const rules: Record<string, Rule.RuleModule> = {
    'no-self-write-in-effect': noSelfWriteInEffect,
    'require-effect-disposal': requireEffectDisposal,
    'handler-call': handlerCall
};

const plugin: ESLint.Plugin & { configs: { recommended: Linter.Config[] } } = {
    meta:
    {
        name: '@azerothjs/eslint-plugin',
        version: '0.6.0-beta.1'
    },
    rules,
    processors:
    {
        azeroth: azerothProcessor
    },
    configs:
    {
        recommended: []
    }
};

// The recommended config references the plugin object itself, so it is attached after construction. Two
// entries: the reactivity rules (for plain `.ts` files) and the `.azeroth` processor that surfaces the
// compiler's diagnostics for `.azeroth` files.
plugin.configs.recommended = [
    {
        name: 'azeroth/reactivity',
        plugins:
        {
            azeroth: plugin
        },
        rules:
        {
            'azeroth/no-self-write-in-effect': 'warn',
            'azeroth/require-effect-disposal': 'warn',
            'azeroth/handler-call': 'warn'
        }
    },
    {
        name: 'azeroth/azeroth-files',
        files: ['**/*.azeroth'],
        plugins:
        {
            azeroth: plugin
        },
        processor: 'azeroth/azeroth'
    },
    {
        // The processor lints each `.azeroth` file as a virtual `.ts` block named `<file>.azeroth/0.ts`.
        // The project's own `.ts` configuration (typescript-eslint's parser + rules) matches and lints
        // that block automatically - which is exactly how `.azeroth` gets the SAME rule set as `.ts`.
        // This entry only adjusts what doesn't carry through the projection.
        name: 'azeroth/azeroth-virtual',
        files: ['**/*.azeroth/*.ts'],
        languageOptions:
        {
            // The `.azeroth` parser: it parses the virtual block in PROGRAM mode against the shared
            // AzerothProject's program, so it carries real `parserServices` - this is what makes
            // type-aware `@typescript-eslint` rules (no-floating-promises, strict-boolean-expressions, ...)
            // work on `.azeroth`. Reuses the language service's program; no second TypeScript program.
            parser: azerothParser
        },
        rules:
        {
            // The compiler reports these on `.azeroth` itself (surfaced by the processor), so silence the
            // hand-written `.ts` reactivity rules here to avoid double-reporting the same finding.
            'azeroth/no-self-write-in-effect': 'off',
            'azeroth/require-effect-disposal': 'off',
            'azeroth/handler-call': 'off',
            // NOTE: `prefer-const` is intentionally LEFT ON. `state x = v` lowers to `let x = v`, which
            // would draw a false positive when that state is never reassigned - but the processor drops
            // exactly those (a prefer-const message landing on a `state` name), so a genuine user `let foo`
            // that is never reassigned is still flagged. (It was previously disabled wholesale, which
            // silenced that real signal too.)
            ...LAYOUT_RULES_OFF
        }
    }
];

export default plugin;
export { rules };
