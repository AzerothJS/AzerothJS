// @vitest-environment node
//
// Autofix stress (requirement #5). Many fixable violations on one `.azeroth` file: every mapped fix must
// have a correct range/offset in the ORIGINAL source, the set must be non-overlapping, and applying them
// (in ESLint's descending order) must yield valid corrected `.azeroth` with nothing from the virtual
// scaffolding leaking in. Re-linting the fixed source must report no further fixes (fixpoint reached).

import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { azerothProcessor } from '../src/azeroth-processor.ts';

const linter = new Linter();

function lint(source: string, rules: Linter.RulesRecord): Linter.LintMessage[]
{
    const blocks = azerothProcessor.preprocess!(source, 'Stress.azeroth');
    const raw = linter.verify(
        typeof blocks[0] === 'string' ? blocks[0] : (blocks[0]?.text ?? ''),
        { files: ['**/*.ts'], languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' }, rules },
        'v.ts'
    );
    return azerothProcessor.postprocess!([raw], 'Stress.azeroth');
}

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
    'export default component Stress',
    '{',
    '    const a = "one";',
    '    const b = "two";',
    '    const c = "three";',
    '    derived label = a == b ? c : "four";',
    '    const nums = [1,2,3].map((n) => n);',
    '    <p title={ a }>{ label }{ nums.length }</p>',
    '}',
    ''
].join('\n');

describe('autofix stress: many fixes, correct ranges, ordering, fixpoint', () =>
{
    const messages = lint(SOURCE, { quotes: ['error', 'single'], 'comma-spacing': ['error', { after: true }] });
    const fixes = messages.filter(m => m.fix);

    it('produces several independent, non-overlapping, in-bounds fixes', () =>
    {
        expect(fixes.length).toBeGreaterThanOrEqual(4); // four string literals at least
        const ranges = fixes.map(m => m.fix!.range).sort((x, y) => x[0] - y[0]);
        for (const [s, e] of ranges)
        {
            expect(s).toBeGreaterThanOrEqual(0);
            expect(e).toBeLessThanOrEqual(SOURCE.length);
            expect(e).toBeGreaterThanOrEqual(s);
        }
        for (let i = 1; i < ranges.length; i++)
        {
            expect(ranges[i]![0], 'fix ranges must not overlap').toBeGreaterThanOrEqual(ranges[i - 1]![1]);
        }
    });

    it('applies all fixes correctly to the original source', () =>
    {
        const fixed = applyFixes(SOURCE, messages);
        expect(fixed).toContain("const a = 'one';");
        expect(fixed).toContain("const c = 'three';");
        expect(fixed).toContain("a == b ? c : 'four'"); // quotes fixed; eqeqeq (no autofix) left intact
        expect(fixed).not.toContain('"'); // every double quote re-quoted
        expect(fixed).not.toContain('__az');
        expect(fixed).not.toContain('declare const h');
        expect(fixed).toContain('export default component Stress'); // structure intact
    });

    it('reaches a fixpoint - the fixed source reports no further fixes', () =>
    {
        const fixed = applyFixes(SOURCE, messages);
        const again = lint(fixed, { quotes: ['error', 'single'], 'comma-spacing': ['error', { after: true }] });
        expect(again.filter(m => m.fix).length).toBe(0);
    });
});
