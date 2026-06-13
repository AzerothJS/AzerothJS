// @azerothjs/eslint-plugin: the reactivity foot-guns in plain .ts files
// (markup in .azeroth files is covered by the compiler's lint, surfaced in
// the editor and the Vite build). The rules are SYNTACTIC by design -
// signals are tracked from `const [x, setX] = createSignal(...)`
// destructuring by name, so consumers need no type-services project
// wiring. The trade: aliased or re-exported signals are invisible.
//
// Flat-config use:
//
//     import azeroth from '@azerothjs/eslint-plugin';
//     export default [azeroth.configs.recommended];

import type { ESLint, Linter, Rule } from 'eslint';
import { noSelfWriteInEffect } from './rules/no-self-write-in-effect.ts';
import { requireEffectDisposal } from './rules/require-effect-disposal.ts';
import { handlerCall } from './rules/handler-call.ts';

const rules: Record<string, Rule.RuleModule> = {
    'no-self-write-in-effect': noSelfWriteInEffect,
    'require-effect-disposal': requireEffectDisposal,
    'handler-call': handlerCall
};

const plugin: ESLint.Plugin & { configs: { recommended: Linter.Config } } = {
    meta:
    {
        name: '@azerothjs/eslint-plugin',
        version: '0.4.0-beta.3'
    },
    rules,
    configs:
    {
        recommended: {} as Linter.Config
    }
};

// The recommended config references the plugin object itself, so it is
// attached after construction.
plugin.configs.recommended = {
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
};

export default plugin;
export { rules };
