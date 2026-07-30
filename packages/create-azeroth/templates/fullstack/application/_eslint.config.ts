import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';
import azeroth from '@azerothjs/eslint-plugin';

// The AzerothJS house style: allman braces, 4-space indent, single quotes, and the
// TypeScript discipline the framework itself is written under. `azeroth.configs.recommended`
// makes .azeroth a first-class lint target (full rule set + the reactivity rules).
const config: ReturnType<typeof defineConfig> = defineConfig([
    globalIgnores([
        '**/dist/**',
        // The SSR bundle from `vite build --ssr`: generated output, not source. Without
        // this, `azeroth check` after a build lints the bundle and drowns in style errors.
        '**/dist-server/**',
        '**/node_modules/**',
        '**/build/**',
        // Generated .azeroth type mirror (the Vite plugin's emitDeclarations output).
        '**/.azeroth/**'
    ]),
    js.configs.recommended,
    tseslint.configs.recommended,
    {
        files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
        languageOptions: { globals: globals.browser },
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
    ...azeroth.configs.recommended,
    {
        // A .azeroth component's return type is owned by the compiler, not the author.
        files: ['**/*.azeroth/*.ts'],
        rules: { '@typescript-eslint/explicit-function-return-type': 'off' }
    }
]);

export default config;
