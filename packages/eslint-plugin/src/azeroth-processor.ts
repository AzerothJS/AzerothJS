// An ESLint processor that makes a `.azeroth` component lintable with a normal
// TypeScript ruleset - INCLUDING its markup.
//
// A `.azeroth` file is a TS module with AzerothJS markup (`return <div>…`). The
// processor surfaces the component VERBATIM as a single virtual
// `*.azeroth/0_index.ts` block; the recommended config wires up a parser for that
// block (see azeroth-parser.ts) that understands the markup, so every rule -
// `indent`, `quotes`, `semi`, the reactivity rules, … - lints the script AND the
// markup. Because the block text is byte-for-byte the source, every lint message
// (and every autofix) maps 1:1 back onto the original file with no offset
// bookkeeping.
//
// (Earlier versions masked the markup as a comment to keep it out of the linter;
// that hid all markup-level findings, which is exactly what users wanted fixed.)

import type { Linter } from 'eslint';

/**
 * The `.azeroth` processor. One output block, identical to the source, named
 * `index.ts` so it matches a project's TypeScript and `.azeroth/` rule globs.
 * Autofix is on: with a verbatim 1:1 block, fixes land exactly where the rule
 * reported, so editor fix-on-save works on `.azeroth` files too.
 */
export const azerothProcessor: Linter.Processor = {
    meta: { name: '@azerothjs/eslint-plugin/azeroth', version: '0.6.0-beta.1' },
    supportsAutofix: true,
    preprocess(text: string): Linter.ProcessorFile[]
    {
        return [{ text, filename: 'index.ts' }];
    },
    postprocess(messages: Linter.LintMessage[][]): Linter.LintMessage[]
    {
        return messages[0] ?? [];
    }
};
