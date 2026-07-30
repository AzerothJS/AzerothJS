import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';
import azeroth from '@azerothjs/eslint-plugin';

// The AzerothJS house style: allman braces, 4-space indent, single quotes, and the
// TypeScript discipline the framework itself is written under. The azeroth reactivity
// rules apply to the server's .ts too - every @azerothjs/http request is a reactive root.
const config: ReturnType<typeof defineConfig> = defineConfig([
    globalIgnores([
        '**/dist/**',
        '**/node_modules/**',
        '**/build/**'
    ]),
    js.configs.recommended,
    tseslint.configs.recommended,
    {
        files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
        languageOptions: { globals: globals.node },
        rules:
        {
            'no-undef': 'off',
            // TypeScript models overloaded signatures natively; the base rule flags them.
            'no-redeclare': 'off',
            'space-before-blocks': 'error',
            'quotes': ['error', 'single', { avoidEscape: true }],
            'key-spacing': 'error',
            'semi-spacing': 'error',
            'curly': ['error', 'all'],
            'indent': ['error', 4, { SwitchCase: 1 }],
            'semi': ['error', 'always'],
            'brace-style': ['error', 'allman'],
            // Allman puts a multi-line call's opening paren on its own line, which this rule reads
            // as two statements. There is no ASI hazard - a parenthesis there can only continue the
            // call - so the two rules cannot both hold, and the house style wins.
            'no-unexpected-multiline': 'off',
            'block-spacing': ['error', 'always'],
            'object-curly-spacing': ['error', 'always'],
            'template-curly-spacing': ['error', 'always'],
            'comma-dangle': ['error', 'never'],
            'no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0, maxBOF: 0 }],
            'no-trailing-spaces': 'error',
            'linebreak-style': ['error', 'unix'],
            'no-unused-vars': 'off',
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/explicit-function-return-type': ['warn', { allowExpressions: true, allowTypedFunctionExpressions: true }],
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
            '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
            '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'separate-type-imports', disallowTypeAnnotations: false }],
            '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'explicit', overrides: { constructors: 'no-public' } }],
            '@typescript-eslint/parameter-properties': ['error', { prefer: 'class-property' }],
            // Native #private members over the erased `private`/`protected`; union literals over enums; ES modules over namespaces.
            'no-restricted-syntax':
            [
                'error',
                {
                    selector: ':matches(PropertyDefinition, MethodDefinition, TSAbstractPropertyDefinition, TSAbstractMethodDefinition)[accessibility=private]',
                    message: 'Use a native #private member - TypeScript `private` is erased and stays reachable at runtime.'
                },
                {
                    selector: ':matches(PropertyDefinition, MethodDefinition)[accessibility=protected]',
                    message: 'No `protected` members - prefer composition over inheritance-facing state.'
                },
                {
                    selector: 'TSEnumDeclaration',
                    message: 'Use a union of literal types instead of an enum.'
                },
                {
                    selector: "TSModuleDeclaration[id.type='Identifier']",
                    message: 'Use ES modules instead of a namespace.'
                }
            ]
        }
    },
    {
        files: ['**/*.{js,mjs,cjs}'],
        rules: { '@typescript-eslint/explicit-function-return-type': 'off' }
    },
    {
        files: ['**/*.spec.ts', '**/tests/**/*.ts'],
        rules: { '@typescript-eslint/explicit-function-return-type': 'off' }
    },
    // Only the first entry of this preset applies here: it carries no `files` filter, so
    // the reactivity rules reach plain .ts. The `.azeroth` processor entries are inert in
    // a server app - there are no components to process.
    ...azeroth.configs.recommended
]);

export default config;
