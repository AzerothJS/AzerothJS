import azeroth from '@azerothjs/eslint-plugin';
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
    globalIgnores(['**/dist/**', '**/node_modules/**']),
    js.configs.recommended,
    tseslint.configs.recommended,
    {
        languageOptions: { globals: globals.browser }
    },
    // Makes `.azeroth` a first-class lint target: every component is linted with the
    // full rule set plus the azeroth-specific rules (effect discipline, handler calls).
    ...azeroth.configs.recommended
]);
