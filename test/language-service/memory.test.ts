// Memory-leak guardrail. The service caches everything per document path
// (source buffer, compiled virtual module, mtimes); the contract is that closing
// a document releases its entries. Rather than chase flaky RSS/heap deltas, this
// asserts the invariant deterministically: after many open/edit/close cycles the
// per-document caches fall back to the count of still-open documents, never
// growing with the number of cycles. The runnable RSS harness lives at
// scripts/perf-stress.mjs. Also checks the per-provider metrics wiring.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { AzerothLanguageService, pathToUri, type Position } from '@azerothjs/language-service';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

// An ISOLATED workspace dir, not the shared OS temp root: the cache-size
// assertions below count discovered `.azeroth` files, so a stray file dropped in
// the shared tmpdir by another tool would otherwise inflate the counts.
const ROOT = fs.mkdtempSync(path.join(tmpdir(), 'azeroth-mem-'));

/** A multi-component `.azeroth` source large enough to exercise the real paths. */
function bigSource(seed: number): string
{
    const rows: string[] = [];
    for (let i = 0; i < 40; i++)
    {
        rows.push(`            <li class="row row-${ i }" style={styleMap({ color: '#0080ff', fontWeight: 'bold' })}>{label()} ${ seed }-${ i }</li>`);
    }
    return [
        "import { createSignal, createMemo } from '@azerothjs/core';",
        '',
        'export default function Big(props: { title: string })',
        '{',
        `    const [n, setN] = createSignal(${ seed });`,
        '    const label = createMemo(() => props.title + n());',
        '    return (',
        '        <ul class="list">',
        ...rows,
        '            <button onClick={() => setN(n() + 1)}>inc</button>',
        '        </ul>',
        '    );',
        '}'
    ].join('\n');
}

let ls: AzerothLanguageService;

beforeAll(() =>
{
    ls = new AzerothLanguageService(ROOT);
});

afterEach(() =>
{
    ls.setMetricsEnabled(false);
});

afterAll(() =>
{
    fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('cache lifecycle (leak guardrail)', () =>
{
    it('releases per-document caches across many open/edit/close cycles', () =>
    {
        const CYCLES = 300;
        for (let c = 0; c < CYCLES; c++)
        {
            const uri = pathToUri(path.join(ROOT, `Cycle${ c }.azeroth`));
            ls.didOpen(uri, bigSource(c));
            // Exercise the providers that build/cache state.
            ls.getDiagnostics(uri);
            ls.getSemanticTokens(uri);
            ls.didChange(uri, bigSource(c + 1000));
            ls.getCompletions(uri, { line: 7, character: 18 });
            ls.didClose(uri);
        }

        const stats = ls.getCacheStats();
        // Nothing is open at the end, so the cycle-scaling caches must be empty -
        // if they tracked cycles they'd be ~300 here.
        expect(stats.openDocuments).toBe(0);
        expect(stats.virtualCache).toBe(0);
    });

    it('keeps caches bounded by the count of currently-open documents', () =>
    {
        const open: string[] = [];
        for (let c = 0; c < 25; c++)
        {
            const uri = pathToUri(path.join(ROOT, `Live${ c }.azeroth`));
            ls.didOpen(uri, bigSource(c));
            open.push(uri);
        }
        expect(ls.getCacheStats().openDocuments).toBe(25);

        for (const uri of open)
        {
            ls.didClose(uri);
        }
        expect(ls.getCacheStats().openDocuments).toBe(0);
        expect(ls.getCacheStats().virtualCache).toBe(0);
    });
});

describe('per-provider metrics', () =>
{
    it('records a timing for each instrumented provider when enabled', () =>
    {
        const uri = pathToUri(path.join(ROOT, 'Metrics.azeroth'));
        ls.didOpen(uri, bigSource(1));
        const pos: Position = { line: 5, character: 20 };

        ls.setMetricsEnabled(true);
        ls.getCompletions(uri, pos);
        ls.getHover(uri, pos);
        ls.getDefinition(uri, pos);
        ls.getDiagnostics(uri);
        ls.getSemanticTokens(uri);

        const { requests } = ls.getMetrics();
        for (const label of ['completion', 'hover', 'definition', 'diagnostics', 'semanticTokens'])
        {
            expect(requests[label]).toBeTypeOf('number');
            expect(requests[label]).toBeGreaterThanOrEqual(0);
        }
        ls.didClose(uri);
    });

    it('records nothing while instrumentation is disabled', () =>
    {
        const uri = pathToUri(path.join(ROOT, 'NoMetrics.azeroth'));
        ls.didOpen(uri, bigSource(2));
        ls.setMetricsEnabled(false);
        // A disabled call must be a pure passthrough: it must not write or overwrite
        // the recorded `hover` timing (left from the enabled test above, or absent).
        const before = ls.getMetrics().requests.hover;
        ls.getHover(uri, { line: 5, character: 20 });
        expect(ls.getMetrics().requests.hover).toBe(before);
        ls.didClose(uri);
    });
});
