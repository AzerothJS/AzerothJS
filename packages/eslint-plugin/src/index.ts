// @azerothjs/eslint-plugin: the reactivity foot-guns, plus a `.azeroth`
// processor that lets ESLint apply a normal TS ruleset to the SCRIPT of a
// component. The reactivity rules are SYNTACTIC by design - signals are tracked
// from `const [x, setX] = createSignal(...)` destructuring by name, so consumers
// need no type-services project wiring (the trade: aliased or re-exported
// signals are invisible). Markup is masked for the linter and stays the
// compiler's lint; no-unused-vars is delegated to azeroth-tsc - see
// azeroth-processor.ts.
//
// Flat-config use - `recommended` is an array (rules + the .azeroth processor),
// so drop it straight into the config list:
//
//     import azeroth from '@azerothjs/eslint-plugin';
//     export default [azeroth.configs.recommended];

import type { ESLint, Linter, Rule } from 'eslint';
import { noSelfWriteInEffect } from './rules/no-self-write-in-effect.ts';
import { requireEffectDisposal } from './rules/require-effect-disposal.ts';
import { handlerCall } from './rules/handler-call.ts';
import { azerothProcessor } from './azeroth-processor.ts';

const rules: Record<string, Rule.RuleModule> = {
    'no-self-write-in-effect': noSelfWriteInEffect,
    'require-effect-disposal': requireEffectDisposal,
    'handler-call': handlerCall
};

const plugin: ESLint.Plugin & { configs: { recommended: Linter.Config[] } } = {
    meta:
    {
        name: '@azerothjs/eslint-plugin',
        version: '0.4.0-beta.3'
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

// The recommended config references the plugin object itself, so it is attached
// after construction. Two entries: the reactivity rules (every file, including
// the `.azeroth` script the processor surfaces) and the processor wiring that
// makes `.azeroth` files lintable at all.
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
    }
];

export default plugin;
export { rules };
