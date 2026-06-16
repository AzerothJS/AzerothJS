// An ESLint processor that makes the SCRIPT of a `.azeroth` component lintable
// with a normal TypeScript ruleset, without false positives.
//
// A `.azeroth` file is a TS module whose markup (`return <div>...`) is not valid
// TypeScript, so a TS parser chokes on it. This processor masks each top-level
// markup region as `0` followed by a same-length block comment of dashes
// (newlines preserved). The result parses - `0` is a valid expression in every
// position markup can appear (`return <m>`, `const x = <m>`, `<m>` as a
// statement) - and because the mask keeps the exact length and line breaks, all
// surrounding script keeps its original position. So every lint message maps 1:1
// back onto the source with no offset bookkeeping.
//
// Masking as a COMMENT (not blanked whitespace) is deliberate: no style rule
// inspects comment bodies, so indent / quotes / template-curly-spacing /
// trailing-space etc. never fire on the markup - only on real script tokens.
// Dashes rather than spaces keep no-trailing-spaces and no-multiple-empty-lines
// quiet on the masked lines.
//
// The one rule that cannot survive masking is no-unused-vars: an import or local
// used ONLY in markup looks unused once the markup is a comment. That check is
// delegated to `azeroth-tsc` (a consuming app's tsconfig carries
// `noUnusedLocals`/`noUnusedParameters`, and the virtual code it type-checks
// keeps the markup references), so those messages are dropped in postprocess.

import type { Linter } from 'eslint';
import { findMarkupStart, parseMarkup } from '@azerothjs/compiler';

/** Rules whose findings are hidden by the mask and covered by azeroth-tsc. */
const DELEGATED_RULES = new Set([
    '@typescript-eslint/no-unused-vars',
    'no-unused-vars'
]);

/**
 * Replaces every top-level markup region in `source` with a same-length
 * `0`-plus-block-comment mask, leaving all surrounding script byte-for-byte and
 * line-for-line in place. The returned text parses as TypeScript.
 */
export function maskMarkup(source: string): string
{
    const out = source.split('');
    let from = 0;
    while (from < source.length)
    {
        const start = findMarkupStart(source, from);
        if (start < 0)
        {
            break;
        }
        let end: number;
        try
        {
            end = parseMarkup(source, start).end;
        }
        catch
        {
            // Not real (or not yet complete) markup here - step past it and keep
            // scanning. Advancing guarantees the loop terminates.
            from = start + 1;
            continue;
        }
        maskRegion(out, start, end);
        from = end;
    }
    return out.join('');
}

/** Masks `out[start..end)` as `0` + a dash-filled block comment of equal width. */
function maskRegion(out: string[], start: number, end: number): void
{
    if (end - start >= 5)
    {
        out[start] = '0';
        out[start + 1] = '/';
        out[start + 2] = '*';
        for (let i = start + 3; i < end - 2; i++)
        {
            if (out[i] !== '\n' && out[i] !== '\r')
            {
                out[i] = '-';
            }
        }
        out[end - 2] = '*';
        out[end - 1] = '/';
    }
    else
    {
        // A tiny tag like `<a/>` (always single-line): a parenthesized zero of
        // the same width.
        for (let i = start; i < end; i++)
        {
            out[i] = ' ';
        }
        out[start] = '(';
        out[start + 1] = '0';
        out[end - 1] = ')';
    }
}

/**
 * The `.azeroth` processor. One output block whose positions are identical to the
 * source, so {@link postprocess} only filters out the delegated rules. Autofix is
 * off - a fix must never land inside a masked region.
 */
export const azerothProcessor: Linter.Processor = {
    meta: { name: '@azerothjs/eslint-plugin/azeroth', version: '0.6.0-beta.1' },
    supportsAutofix: false,
    preprocess(text: string): Linter.ProcessorFile[]
    {
        return [{ text: maskMarkup(text), filename: 'index.ts' }];
    },
    postprocess(messages: Linter.LintMessage[][]): Linter.LintMessage[]
    {
        return (messages[0] ?? []).filter(message => !DELEGATED_RULES.has(message.ruleId ?? ''));
    }
};
