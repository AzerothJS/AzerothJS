// @vitest-environment node
//
// The structural-safety contract of `--fix`: applying fixes must never change a file's
// markup skeleton. Two halves:
//
//   1. The BOM coordinate bug, reproduced through REAL applier semantics. ESLint's
//      SourceCode strips a leading U+FEFF before rules and the fixer see the text, but
//      hands processors the RAW text - so fix offsets computed BOM-inclusively drift one
//      character and a whitespace-only indent fix eats the `<` of the tag it indents.
//      Found live: it corrupted two production pages during the let= migration.
//
//   2. The structural guard: any fix whose application would change the markup skeleton
//      is stripped, and the message survives report-only. A wrong fix costs an autofix,
//      never a file.
import { describe, it, expect } from 'vitest';
import type { Linter } from 'eslint';
import { parseMarkup, findMarkupStart } from '@azerothjs/compiler';
import { azerothProcessor } from '../src/azeroth-processor.ts';

const BOM = '﻿';

// Wrong indentation (the <p> under-indented), CRLF line endings, and a leading BOM -
// the exact shape of the files that corrupted.
const FIXTURE = [
    'export default component Card()',
    '{',
    '    <div>',
    '      <p>text</p>',
    '        <b>tail</b>',
    '    </div>',
    '}',
    ''
].join('\r\n');

/**
 * ESLint's application semantics, faithfully: strip the BOM, apply fixes bottom-up to
 * the STRIPPED text, re-prepend the BOM. This is the half the old pipeline disagreed
 * with - a harness that applies fixes to the raw text would hide the bug forever.
 */
function applyLikeESLint(raw: string, messages: Linter.LintMessage[]): string
{
    const hasBom = raw.charCodeAt(0) === 0xFEFF;
    let text = hasBom ? raw.slice(1) : raw;
    const fixes = messages.filter((m) => m.fix !== undefined).map((m) => m.fix as { range: [number, number]; text: string });
    fixes.sort((a, b) => b.range[0] - a.range[0]);
    for (const fix of fixes)
    {
        text = text.slice(0, fix.range[0]) + fix.text + text.slice(fix.range[1]);
    }
    return hasBom ? BOM + text : text;
}

function skeleton(source: string): string
{
    const text = source.charCodeAt(0) === 0xFEFF ? source.slice(1) : source;
    const at = findMarkupStart(text, 0);
    const events: string[] = [];
    const walk = (node: { kind: string; tag?: string; children?: { kind: string }[] }): void =>
    {
        if (node.kind !== 'element' && node.kind !== 'fragment')
        {
            return;
        }
        events.push(node.tag ?? '<>');
        for (const child of node.children ?? [])
        {
            walk(child);
        }
        events.push('/');
    };
    walk(parseMarkup(text, at).node);
    return events.join(' ');
}

function processorMessages(source: string, name: string): Linter.LintMessage[]
{
    azerothProcessor.preprocess?.(source, name);
    return azerothProcessor.postprocess?.([[]], name) ?? [];
}

describe('autofix structural safety', () =>
{
    it('a BOM file survives --fix with its structure intact and its indent corrected', () =>
    {
        const raw = BOM + FIXTURE;
        const messages = processorMessages(raw, 'Bom.azeroth');
        expect(messages.some((m) => m.ruleId === 'azeroth/markup-indent' && m.fix !== undefined)).toBe(true);

        const fixed = applyLikeESLint(raw, messages);

        // Structure identical, and the tag the old bug ate is intact.
        expect(skeleton(fixed)).toBe(skeleton(raw));
        expect(fixed).toContain('<p>text</p>');
        expect(fixed).toContain('<b>tail</b>');

        // The fix actually FIXED: relint the result, no indent findings remain.
        const relint = processorMessages(fixed, 'Bom2.azeroth');
        expect(relint.filter((m) => m.ruleId === 'azeroth/markup-indent')).toEqual([]);
    });

    it('the same file without a BOM behaves identically', () =>
    {
        const messages = processorMessages(FIXTURE, 'Plain.azeroth');
        const fixed = applyLikeESLint(FIXTURE, messages);

        expect(skeleton(fixed)).toBe(skeleton(FIXTURE));
        expect(processorMessages(fixed, 'Plain2.azeroth').filter((m) => m.ruleId === 'azeroth/markup-indent')).toEqual([]);
    });

    it('a fix that would change the markup skeleton is stripped, not applied', () =>
    {
        // A synthetic virtual-block message whose fix survives the byte-identity map
        // (the span is echoed verbatim in the projection) but renames an OPENING tag
        // only - exactly the class of corruption the guard exists to refuse.
        azerothProcessor.preprocess?.(FIXTURE, 'Guard.azeroth');
        const virtualBlocks = azerothProcessor.preprocess?.(FIXTURE, 'Guard.azeroth');
        const virtualText = typeof virtualBlocks?.[0] === 'string' ? virtualBlocks[0] : virtualBlocks?.[0]?.text ?? '';
        const at = virtualText.indexOf("'p'") !== -1 ? virtualText.indexOf("'p'") + 1 : virtualText.indexOf('<p>') + 1;

        const synthetic: Linter.LintMessage = {
            ruleId: 'x/corruptor',
            severity: 1,
            message: 'synthetic',
            line: 1,
            column: 1,
            fix: { range: [at, at + 1], text: 'q' }
        };
        const messages = azerothProcessor.postprocess?.([[synthetic]], 'Guard.azeroth') ?? [];

        const fixed = applyLikeESLint(FIXTURE, messages);
        expect(skeleton(fixed)).toBe(skeleton(FIXTURE));
    });
});
