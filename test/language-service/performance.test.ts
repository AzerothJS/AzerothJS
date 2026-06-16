// Latency guardrails for the editor-critical service methods. The budgets here
// are DELIBERATELY LOOSE regression-catchers: these run in CI on varied (often
// shared, often slow) hardware, so the goal is catching ORDER-OF-MAGNITUDE
// regressions - an O(n) feature going O(n^2), a stray full-program rebuild per
// keystroke - not micro-perf. Every measurement is warmed up first because the
// first call into the program pays the one-time cold lib.d.ts load.

import { describe, it, expect, beforeAll } from 'vitest';
import { AzerothLanguageService, LineIndex, pathToUri, type Position } from '@azerothjs/language-service';
import path from 'node:path';

const ROOT = process.cwd();

function at(source: string, needle: string, offsetInNeedle = 0): Position
{
    return new LineIndex(source).positionAt(source.indexOf(needle) + offsetInNeedle);
}

/** A ~30-60 line component. `index` seeds names; `imports` are sibling base names to import and render. */
function makeComponent(index: number, imports: readonly number[]): string
{
    const lines: string[] = [];
    lines.push("import { createSignal, createMemo } from '@azerothjs/core';");
    for (const dep of imports)
    {
        lines.push(`import Comp${ dep } from './Comp${ dep }.azeroth';`);
    }
    lines.push('');
    lines.push(`export default function Comp${ index }(props: { label: string; seed: number })`);
    lines.push('{');
    lines.push('    const [count, setCount] = createSignal(props.seed);');
    lines.push('    const doubled = createMemo(() => count() * 2);');
    lines.push('    const title = createMemo(() => props.label + \' #\' + count());');
    lines.push('');
    lines.push('    return (');
    lines.push(`        <section class="comp-${ index }">`);
    lines.push('            <header>');
    lines.push('                <h3>{title()}</h3>');
    lines.push('                <span>{doubled()}</span>');
    lines.push('            </header>');
    lines.push('            <button onClick={() => setCount(count() + 1)}>inc</button>');
    for (const dep of imports)
    {
        lines.push(`            <Comp${ dep } label={title()} seed={count()} />`);
    }
    lines.push('            <footer>{props.label}</footer>');
    lines.push('        </section>');
    lines.push('    );');
    lines.push('}');
    return lines.join('\n');
}

const FILE_COUNT = 50;
const sources: string[] = [];
const uris: string[] = [];

let ls: AzerothLanguageService;

beforeAll(() =>
{
    ls = new AzerothLanguageService(ROOT);
    for (let i = 0; i < FILE_COUNT; i++)
    {
        // The first file imports several others, exercising cross-file resolution.
        const imports = i === 0 ? [1, 2, 3, 4, 5] : [];
        const src = makeComponent(i, imports);
        const uri = pathToUri(path.join(ROOT, `Comp${ i }.azeroth`));
        sources[i] = src;
        uris[i] = uri;
        ls.didOpen(uri, src);
    }

    // Warm up the program once: the first request pays the cold lib.d.ts cost,
    // which would otherwise be charged to whichever budget happens to run first.
    ls.getDiagnostics(uris[0]);
    ls.getCompletions(uris[0], at(sources[0], '<section', 1));
    ls.getHover(uris[0], at(sources[0], 'count()', 0));
    ls.getSemanticTokens(uris[0]);
    ls.getDefinition(uris[0], at(sources[0], '<Comp1', 1));
});

describe('editor latency budgets (loose regression-catchers, not micro-perf)', () =>
{
    it('getCompletions stays under 400ms in a tag position', () =>
    {
        const src = sources[0];
        const pos = at(src, '<section', 1);
        const start = performance.now();
        const items = ls.getCompletions(uris[0], pos);
        const elapsed = performance.now() - start;
        expect(items.length).toBeGreaterThan(0);
        expect(elapsed).toBeLessThan(400);
    });

    it('getDiagnostics on a ~50-line file stays under 300ms', () =>
    {
        const start = performance.now();
        const diags = ls.getDiagnostics(uris[0]);
        const elapsed = performance.now() - start;
        // A clean, well-typed file: no diagnostics, but the full type-check still runs.
        expect(diags).toEqual([]);
        expect(elapsed).toBeLessThan(300);
    });

    it('getHover stays under 150ms', () =>
    {
        const src = sources[0];
        const pos = at(src, 'count()', 0);
        const start = performance.now();
        ls.getHover(uris[0], pos);
        const elapsed = performance.now() - start;
        expect(elapsed).toBeLessThan(150);
    });

    it('getSemanticTokens stays under 150ms', () =>
    {
        const start = performance.now();
        const tokens = ls.getSemanticTokens(uris[0]);
        const elapsed = performance.now() - start;
        expect(tokens.data.length).toBeGreaterThan(0);
        expect(elapsed).toBeLessThan(150);
    });
});

describe('cross-file scaling (catches super-linear navigation cost)', () =>
{
    /** Median getDefinition time over `samples` runs against the first `fileCount` files. */
    function measureDefinition(fileCount: number, samples: number): number
    {
        const times: number[] = [];
        for (let s = 0; s < samples; s++)
        {
            const i = s % fileCount;
            const src = sources[i];
            const pos = at(src, 'createSignal', 0);
            const start = performance.now();
            ls.getDefinition(uris[i], pos);
            times.push(performance.now() - start);
        }
        times.sort((a, b) => a - b);
        return times[Math.floor(times.length / 2)];
    }

    it('cross-file getDefinition cost does not blow up super-linearly from 10 -> 50 files', () =>
    {
        // Same program (all 50 files are open); we only vary how many distinct
        // files we query. A correctly-incremental service answers each query in
        // roughly constant time, so 50-file work must not dwarf 10-file work.
        const small = measureDefinition(10, 20);
        const large = measureDefinition(FILE_COUNT, 20);

        // Floor the baseline so sub-millisecond timer jitter can't make the ratio
        // explode (e.g. 0.1ms -> 0.8ms is 8x but meaningless).
        const baseline = Math.max(small, 1);
        expect(large).toBeLessThan(baseline * 8);
    });
});
