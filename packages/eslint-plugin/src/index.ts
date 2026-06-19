// @azerothjs/eslint-plugin: the reactivity foot-guns, plus a `.azeroth`
// processor that lets ESLint apply a normal TS ruleset to a whole component -
// SCRIPT and markup. The processor surfaces the component VERBATIM as a virtual
// `*.azeroth/0_index.ts` block parsed by the wrapper parser (azeroth-parser.ts),
// so every rule runs and every fix maps 1:1 back to the source (see
// azeroth-processor.ts). The reactivity rules are SYNTACTIC by design - signals
// are tracked from `const [x, setX] = createSignal(...)` destructuring by name,
// so consumers need no type-services project wiring (the trade: aliased or
// re-exported signals are invisible).
//
// Flat-config use - `recommended` is an ARRAY (rules + the .azeroth processor +
// the markup parser), so spread it into the config list:
//
//     import azeroth from '@azerothjs/eslint-plugin';
//     export default [...azeroth.configs.recommended];

import type { ESLint, Linter, Rule } from 'eslint';
import { noSelfWriteInEffect } from './rules/no-self-write-in-effect.ts';
import { requireEffectDisposal } from './rules/require-effect-disposal.ts';
import { handlerCall } from './rules/handler-call.ts';
import { azerothProcessor } from './azeroth-processor.ts';
import { azerothParser } from './azeroth-parser.ts';

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
    },
    {
        // The processor surfaces each component as a verbatim virtual
        // `*.azeroth/0_index.ts` block. Parse those blocks with the wrapper parser
        // (azeroth-parser.ts) so the AzerothJS markup is understood; the `.ts`
        // name is kept so the block still matches a project's `**/*.ts` rule globs.
        name: 'azeroth/markup-parsing',
        files: ['**/*.azeroth/*'],
        languageOptions:
        {
            parser: azerothParser
        }
    }
];

export default plugin;
export { rules };
