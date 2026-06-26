// @vitest-environment node
//
// End-to-end coverage for the `.azeroth` ESLint processor. Each test drives the SAME pipeline ESLint
// runs: preprocess the `.azeroth` source into a virtual `.ts` block, lint that block with the real
// `@typescript-eslint/parser` and stock rules, then postprocess the messages back. It verifies that
//   - core + TypeScript rules actually fire on `.azeroth` content,
//   - every message maps to the ORIGINAL `.azeroth` location (never the virtual module),
//   - autofixes map back and, applied, correct the original source,
//   - diagnostics that would land in generated scaffolding are dropped,
//   - the compiler's reactivity diagnostics are merged into the same list.

import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { azerothProcessor } from '../src/azeroth-processor.ts';

const linter = new Linter();

/** Runs the full processor pipeline and returns the mapped messages (original-file coordinates). */
function lint(source: string, rules: Linter.RulesRecord): Linter.LintMessage[]
{
    const blocks = azerothProcessor.preprocess!(source, 'Demo.azeroth');
    // Lint the virtual block exactly as the project's `.ts` config would (TS parser + the given rules).
    // In a real run the virtual file is `Demo.azeroth/0.ts` and the user's `**/*.ts` config matches it;
    // here we lint it directly with an equivalent flat config (a `files` pattern is required so ESLint's
    // flat-config matcher considers the file lintable).
    const raw = linter.verify(
        typeof blocks[0] === 'string' ? blocks[0] : blocks[0].text,
        { files: ['**/*.ts'], languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' }, rules },
        'virtual.ts'
    );
    return azerothProcessor.postprocess!([raw], 'Demo.azeroth');
}

/** 1-based line/column -> absolute offset, for slicing the original source under a message. */
function toOffset(source: string, line: number, column: number): number
{
    const starts = [0];
    for (let i = 0; i < source.length; i++)
    {
        if (source[i] === '\n')
        {
            starts.push(i + 1);
        }
    }
    return starts[line - 1] + (column - 1);
}

/** Applies mapped fixes to the original source (descending, so earlier edits don't shift later ranges). */
function applyFixes(source: string, messages: Linter.LintMessage[]): string
{
    const fixes = messages.filter(m => m.fix).map(m => m.fix!).sort((a, b) => b.range[0] - a.range[0]);
    let out = source;
    for (const fix of fixes)
    {
        out = out.slice(0, fix.range[0]) + fix.text + out.slice(fix.range[1]);
    }
    return out;
}

const SOURCE = [
    'export default component Demo',                            // 0
    '{',                                                        // 1
    '    const greeting = "hi";',                               // 2
    '    state count = 0;',                                     // 3
    '    derived doubled = count == 0 ? greeting : "lots";',    // 4
    '    const unusedLocal = 42;',                              // 5
    '    <p>{ doubled }</p>',                                   // 6
    '}',                                                        // 7
    ''
].join('\n');

describe('azeroth ESLint processor — rules fire and map back', () =>
{
    it('eqeqeq fires on `==` inside a derived and maps to the original `==`', () =>
    {
        const messages = lint(SOURCE, { eqeqeq: 'error' });
        const eq = messages.find(m => m.ruleId === 'eqeqeq');
        expect(eq, 'eqeqeq should fire on `count == 0`').toBeDefined();
        expect(eq!.severity).toBe(2);
        // The reported location points at exactly the `==` the user wrote (eqeqeq itself declines to
        // autofix `count == 0` since `===` could change semantics - so we assert the location, not a fix).
        const offset = toOffset(SOURCE, eq!.line, eq!.column);
        expect(SOURCE.slice(offset, offset + 2)).toBe('==');
    });

    it('quotes fires on each user string literal and maps each fix', () =>
    {
        const messages = lint(SOURCE, { quotes: ['error', 'single'] });
        const quoteMsgs = messages.filter(m => m.ruleId === 'quotes');
        expect(quoteMsgs.length).toBe(2); // "hi" and "lots" - and nothing from scaffolding
        for (const m of quoteMsgs)
        {
            // Each fix replaces a double-quoted literal the user actually wrote.
            expect(SOURCE.slice(m.fix!.range[0], m.fix!.range[1])).toMatch(/^"[^"]*"$/);
        }
    });

    it('no-unused-vars reports only the user binding, never generated scaffolding', () =>
    {
        const messages = lint(SOURCE, { 'no-unused-vars': 'warn' });
        const unused = messages.filter(m => m.ruleId === 'no-unused-vars');
        // Exactly one — the user's `unusedLocal`. The projection's generated `props` param, `h`/`__az*`
        // helpers, etc. live in scaffolding and are dropped, so they never leak in here.
        expect(unused.length).toBe(1);
        const m = unused[0];
        const offset = toOffset(SOURCE, m.line, m.column);
        expect(SOURCE.slice(offset, offset + 'unusedLocal'.length)).toBe('unusedLocal');
        expect(m.severity).toBe(1);
    });

    it('autofix, applied to the ORIGINAL source, produces valid corrected `.azeroth`', () =>
    {
        const messages = lint(SOURCE, { quotes: ['error', 'single'] });
        const fixed = applyFixes(SOURCE, messages);
        // Both user string literals are re-quoted, in place, in the original source.
        expect(fixed).toContain("const greeting = 'hi';");
        expect(fixed).toContain("count == 0 ? greeting : 'lots'");
        // The rest of the file is untouched — no scaffolding text leaked into the source.
        expect(fixed).toContain('export default component Demo');
        expect(fixed).toContain('<p>{ doubled }</p>');
        expect(fixed).not.toContain('__az');
        expect(fixed).not.toContain('declare const h');
    });
});

describe('azeroth ESLint processor — unified compiler diagnostics', () =>
{
    it('surfaces the compiler reactivity diagnostic alongside ESLint messages', () =>
    {
        const src = 'export default component C\n{\n    derived d = 1 + 2;\n    <p>{ d }</p>\n}\n';
        const messages = lint(src, { eqeqeq: 'error' });
        const constant = messages.find(m => m.ruleId === 'azeroth/constant-derived');
        expect(constant, 'the compiler diagnostic should appear in the same list').toBeDefined();
        expect(constant!.severity).toBe(1); // warning
        // It points at the `derived d` the user wrote (line 3).
        expect(constant!.line).toBe(3);
    });

    it('a clean component produces no messages', () =>
    {
        const src = 'export default component Ok\n{\n    state n = 0;\n    <button onClick={() => { n = n + 1; }}>{ n }</button>\n}\n';
        expect(lint(src, { eqeqeq: 'error', quotes: ['error', 'single'], 'no-unused-vars': 'warn' })).toEqual([]);
    });
});

describe('azeroth ESLint processor — prefer-const distinguishes user `let` from `state`', () =>
{
    const src = [
        'export default component F',
        '{',
        '    state count = 0;',                         // projects to `let count` — must NOT be flagged
        '    let label = "x";',                         // genuine user `let`, never reassigned — flag it
        '    derived d = count + label.length;',
        '    <p>{ d }</p>',
        '}',
        ''
    ].join('\n');

    it('flags a never-reassigned user `let` and points at it', () =>
    {
        const messages = lint(src, { 'prefer-const': 'error' });
        const pc = messages.filter(m => m.ruleId === 'prefer-const');
        expect(pc.length).toBe(1);
        const offset = toOffset(src, pc[0].line, pc[0].column);
        expect(src.slice(offset, offset + 'label'.length)).toBe('label');
    });

    it('does NOT flag a `state` declaration (its projected `let` is a false positive)', () =>
    {
        const messages = lint(src, { 'prefer-const': 'error' });
        // Not one of the prefer-const hits lands on the `state count` name.
        const onCount = messages.filter(m => m.ruleId === 'prefer-const').some((m) =>
        {
            const offset = toOffset(src, m.line, m.column);
            return src.slice(offset, offset + 'count'.length) === 'count';
        });
        expect(onCount).toBe(false);
    });
});
