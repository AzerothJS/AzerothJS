// @vitest-environment node
//
// Source-map fuzz (requirement #6). Generates hundreds of randomized `.azeroth` programs - mixing
// constructs, CRLF vs LF line endings, and string content with surrogate pairs / multi-byte Unicode -
// projects each, and verifies the offset mapping that every ESLint diagnostic and autofix is translated
// through. The invariants, checked at every offset strictly interior to a mapped segment:
//   - VERBATIM:  source[o] === virtual[toGenerated(o)]        (no off-by-one, no UTF-16/CRLF drift)
//   - BIJECTIVE: toOriginal(toGenerated(o)) === o             (no overlapping/misaligned segments)
// Offsets are UTF-16 code units (the ESLint/TypeScript convention), so a surrogate pair is two units and
// the per-unit equality check is exactly what guards against a UTF-16 mapping bug.

import { describe, it, expect } from 'vitest';
import { generateVirtualCode } from '@azerothjs/compiler';

/** Deterministic PRNG (mulberry32) so a failure is reproducible. */
function rng(seed: number): () => number
{
    let a = seed >>> 0;
    return () =>
    {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// String literals that exercise UTF-16: a BMP char, a surrogate-pair emoji, and an astral codepoint.
const UNICODE = ['plain', 'ünïcödé', 'emoji 😀 done', '漢字テスト', 'astral 𝟙𝟚𝟛', 'mixed a😀b漢c'];

function makeProgram(seed: number): string
{
    const r = rng(seed);
    const eol = r() < 0.5 ? '\r\n' : '\n';
    const body: string[] = [];
    const count = 1 + Math.floor(r() * 5);
    for (let i = 0; i < count; i++)
    {
        const pick = Math.floor(r() * 5);
        if (pick === 0)
        {
            body.push(`    state s${ i } = ${ Math.floor(r() * 100) };`);
        }
        else if (pick === 1)
        {
            body.push(`    derived d${ i } = s0 + ${ Math.floor(r() * 10) };`);
        }
        else if (pick === 2)
        {
            body.push(`    const u${ i } = "${ UNICODE[Math.floor(r() * UNICODE.length)] }";`);
        }
        else if (pick === 3)
        {
            body.push(`    effect { console.log(s0 === ${ Math.floor(r() * 5) }); }`);
        }
        else
        {
            body.push(`    const c${ i } = s0 == 0 ? "${ UNICODE[Math.floor(r() * UNICODE.length)] }" : "x";`);
        }
    }
    const lines = [
        'export default component Fuzz',
        '{',
        ...body,
        `    <div title="${ UNICODE[Math.floor(r() * UNICODE.length)] } 😀">{ s0 }</div>`,
        '}'
    ];
    return lines.join(eol) + eol;
}

describe('source-map fuzz: randomized .azeroth programs (CRLF + Unicode/surrogate pairs)', () =>
{
    it('preserves VERBATIM + BIJECTIVE mapping at every interior offset across 600 programs', () =>
    {
        let offsetsChecked = 0;
        for (let seed = 1; seed <= 600; seed++)
        {
            const source = makeProgram(seed);
            const { code, mapping } = generateVirtualCode(source);
            for (let o = 0; o < source.length; o++)
            {
                const g = mapping.toGenerated(o);
                if (g === null)
                {
                    continue;
                }
                const next = mapping.toGenerated(o + 1);
                if (next === null || next !== g + 1)
                {
                    continue; // only offsets strictly interior to a segment (boundaries are ambiguous)
                }
                offsetsChecked++;
                // Quote failures with the seed + offset so any fuzz failure is reproducible.
                if (source[o] !== code[g])
                {
                    throw new Error(`VERBATIM fail seed=${ seed } o=${ o }: source ${ JSON.stringify(source[o]) } !== virtual ${ JSON.stringify(code[g]) }`);
                }
                if (mapping.toOriginal(g) !== o)
                {
                    throw new Error(`BIJECTIVE fail seed=${ seed } o=${ o }: toOriginal(${ g }) = ${ mapping.toOriginal(g) }`);
                }
            }
        }
        expect(offsetsChecked).toBeGreaterThan(10000); // the fuzz actually exercised many offsets
    });
});
