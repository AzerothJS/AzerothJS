import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';
// Self-hosted reactivity foot-gun rules, imported straight from source: the plugin's
// packaged entry also pulls the .azeroth processor, whose imports resolve to workspace
// dist/ - and CI lints before it builds, so the dist-free rule modules are used instead.
import { noSelfWriteInEffect } from './packages/eslint-plugin/src/rules/no-self-write-in-effect.ts';
import { requireEffectDisposal } from './packages/eslint-plugin/src/rules/require-effect-disposal.ts';
import { handlerCall } from './packages/eslint-plugin/src/rules/handler-call.ts';

const typeAwareSrc = ['packages/**/*.ts'];
const typeAwareTests = ['packages/*/tests/**/*.ts'];

export default defineConfig([
    globalIgnores([
        '**/dist/**',
        '**/node_modules/**',
        '**/build/**',
        '**/out/**',
        '**/.intellijPlatform/**',
        // Generated .azeroth type mirrors (the Vite plugin's emitDeclarations output).
        '**/.azeroth/**',
        // Test fixtures import `.azeroth` modules; resolving those is the plugin's
        // own job at test runtime, so they live outside every TS project (mirrors
        // the exclude in the package's tsconfig.build.json).
        'packages/typescript-plugin/tests/fixtures/**',
        // Scaffolding templates reference dependencies that exist only in a
        // scaffolded app (and carry {{placeholders}}) - they are data, not code.
        'packages/create-azeroth/templates/**'
    ]),
    tseslint.configs.recommended,
    {
        files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
        plugins:
        {
            js,
            azeroth:
            {
                rules:
                {
                    'no-self-write-in-effect': noSelfWriteInEffect,
                    'require-effect-disposal': requireEffectDisposal,
                    'handler-call': handlerCall
                }
            }
        },
        extends: ['js/recommended'],
        languageOptions: { globals: globals.browser },
        rules:
        {
            'no-undef': 'off',

            // TypeScript handles overloaded function signatures
            // natively; the base ESLint rule flags the overload
            // forms as redeclarations.
            'no-redeclare': 'off',

            'space-before-blocks': 'error',
            'quotes': ['error', 'single', { avoidEscape: true }],
            'key-spacing': 'error',
            'semi-spacing': 'error',
            'curly': ['error', 'all'],
            'indent': ['error', 4, { SwitchCase: 1 }],
            'semi': ['error', 'always'],
            'brace-style': ['error', 'allman'],
            'block-spacing': ['error', 'always'],
            'object-curly-spacing': ['error', 'always'],
            'template-curly-spacing': ['error', 'always'],
            'comma-dangle': ['error', 'never'],
            'no-multiple-empty-lines':
            [
                'error',
                {
                    max: 1,
                    maxEOF: 0,
                    maxBOF: 0
                }
            ],
            'no-trailing-spaces': 'error',
            'linebreak-style': ['error', 'unix'],
            'no-unused-vars': 'off',

            '@typescript-eslint/explicit-member-accessibility':
            [
                'error',
                {
                    accessibility: 'explicit',
                    overrides:
                    {
                        constructors: 'no-public'
                    }
                }
            ],
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/explicit-function-return-type': ['warn', { allowExpressions: true, allowTypedFunctionExpressions: true }],
            '@typescript-eslint/no-unused-vars':
            [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    destructuredArrayIgnorePattern: '^_'
                }
            ],
            '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
            // disallowTypeAnnotations stays off: `import('node:http2').X` annotations are the
            // deliberate idiom for typing OPTIONAL peers without a top-level import.
            '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'separate-type-imports', disallowTypeAnnotations: false }],
            '@typescript-eslint/parameter-properties': ['error', { prefer: 'class-property' }],

            // Native #privates over the erased `private`/`protected` keywords: real runtime
            // privacy is what a published zero-dependency runtime owes its semver (see
            // CONTRIBUTING "Coding conventions"). `enum`/`namespace` emit runtime artifacts
            // union literals and modules provide without.
            'no-restricted-syntax':
            [
                'error',
                {
                    selector: ':matches(PropertyDefinition, MethodDefinition, TSAbstractPropertyDefinition, TSAbstractMethodDefinition)[accessibility=private]',
                    message: 'Use a native #private member - TypeScript `private` is erased and the property stays reachable at runtime.'
                },
                {
                    selector: ':matches(PropertyDefinition, MethodDefinition)[accessibility=protected]',
                    message: 'No `protected` members - the codebase does not use inheritance-facing state.'
                },
                {
                    selector: 'TSEnumDeclaration',
                    message: 'Use a union of literal types instead of an enum.'
                },
                {
                    selector: "TSModuleDeclaration[id.type='Identifier']",
                    message: 'Use ES modules instead of a namespace.'
                }
            ],

            'azeroth/no-self-write-in-effect': 'warn',
            'azeroth/require-effect-disposal': 'warn',
            'azeroth/handler-call': 'warn'
        }
    },
    {
        files: ['**/*.{js,mjs,cjs}'],
        rules:
        {
            '@typescript-eslint/explicit-function-return-type': 'off'
        }
    },
    {
        files: ['**/*.spec.ts', '**/tests/**/*.ts'],
        rules:
        {
            '@typescript-eslint/explicit-function-return-type': 'off',
            // Tests exercise the reactivity foot-guns ON PURPOSE (loop guards,
            // disposal leaks, self-writes) - warning there is pure noise.
            'azeroth/no-self-write-in-effect': 'off',
            'azeroth/require-effect-disposal': 'off',
            'azeroth/handler-call': 'off'
        }
    },

    // Type-aware strict linting over every package.
    // strictTypeChecked minus three documented adjustments:
    //   restrict-template-expressions allowNumber - `${ count }` interpolation is
    //     safe and pervasive house style; the rule's value is catching objects.
    //   no-confusing-void-expression - pure style; contradicts the house's terse
    //     `(x) => doSideEffect(x)` arrow idiom.
    //   no-non-null-assertion stays ON in src but OFF in tests - a test asserting
    //     non-null after arranging exactly that state is idiomatic, not a hazard.
    ...tseslint.configs.strictTypeChecked.map((entry) => ({ ...entry, files: typeAwareSrc })),
    {
        files: typeAwareSrc,
        languageOptions:
        {
            parserOptions:
            {
                // typescript-plugin lives outside the root project (CJS, own build
                // config), so both projects are listed explicitly.
                project: ['./tsconfig.json', './packages/typescript-plugin/tsconfig.build.json'],
                tsconfigRootDir: import.meta.dirname
            }
        },
        rules:
        {
            '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
            '@typescript-eslint/no-confusing-void-expression': 'off',
            '@typescript-eslint/prefer-readonly': 'error',
            '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }]
        }
    },
    {
        files: typeAwareTests,
        rules:
        {
            '@typescript-eslint/no-non-null-assertion': 'off',
            // Tests simulate async fetchers with instantly-resolving `async` fns -
            // the async keyword IS the contract under test, not an oversight.
            '@typescript-eslint/require-await': 'off'
        }
    }
]);
