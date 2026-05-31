import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
    globalIgnores(['**/dist/**', '**/node_modules/**']),
    tseslint.configs.recommended,
    {
        files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
        plugins: { js },
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
            'quotes': ['error', 'single'],
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
            '@typescript-eslint/no-explicit-any': 'off',
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
            '@typescript-eslint/consistent-type-definitions': ['error', 'interface']
        }
    }
]);
