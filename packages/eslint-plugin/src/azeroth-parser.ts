// A thin parser wrapper that lets the AzerothJS markup in a surfaced `.azeroth`
// script be parsed, while the block keeps its `.ts` identity for rule matching.
//
// AzerothJS is its own language; this only concerns the THIRD-PARTY parser we
// reuse to read it. @typescript-eslint/parser enables markup parsing only for
// its markup script-kind (selected by a trailing `x` on the extension) - under a
// plain `.ts` extension it reads `<div>` as a type assertion/generic and fails
// with "'>' expected". The processor names its virtual block `index.ts` on
// purpose, so it matches the `**/*.ts` rule globs a project already targets; this
// wrapper hands that buffer to the upstream parser under the markup script-kind
// so the AzerothJS markup is understood, then returns the result unchanged.

import * as tsParser from '@typescript-eslint/parser';
import type { Linter } from 'eslint';

type ParserOptions = Parameters<typeof tsParser.parseForESLint>[1];

// @typescript-eslint's ParseForESLintResult is structurally a superset of
// ESLint's (its token `type`s are a wider enum), so the object is cast through
// `unknown` to ESLint's Parser type - the runtime value is exactly what ESLint
// expects (it IS @typescript-eslint/parser's output).
const parser =
{
    meta: { name: '@azerothjs/eslint-plugin/parser' },
    parseForESLint(code: string, options?: ParserOptions)
    {
        const merged = { ...(options ?? {}) } as ParserOptions & { filePath?: string; ecmaFeatures?: Record<string, unknown> };
        // `jsx` is the upstream parser's option name for "parse markup", not a
        // statement about the AzerothJS language.
        merged.ecmaFeatures = { ...(merged.ecmaFeatures ?? {}), jsx: true };
        if (typeof merged.filePath === 'string')
        {
            // Select the upstream parser's markup script-kind for the virtual
            // `…/0_index.ts` buffer (it keys off the trailing `x`).
            merged.filePath = merged.filePath.replace(/\.ts$/, '.tsx');
        }
        return tsParser.parseForESLint(code, merged);
    }
};

export const azerothParser: Linter.Parser = parser as unknown as Linter.Parser;
