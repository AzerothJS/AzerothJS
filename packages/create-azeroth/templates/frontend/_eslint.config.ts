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
            // Both TS `private` and native `#private` are allowed in a starter app. Only enums
            // and namespaces are steered away (union literals and ES modules cover them).
            'no-restricted-syntax':
            [
                'error',
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
