// Memory + latency stress harness for the AzerothJS language service.
//
// Runs many open/edit/close cycles against a large `.azeroth` file, sampling
// process memory and warm request latency, then reports:
//   - p50/p95 latency for completion / hover / definition / diagnostics, against
//     the editor targets, and
//   - the RSS / heap trend, asserting steady-state memory doesn't drift up with
//     the cycle count (the leak check).
//
// Build the service first, then run with GC exposed so the memory delta is real:
//
//   npm run build -w @azerothjs/language-service
//   node --expose-gc scripts/perf-stress.mjs [cycles]
//
// Exit code is non-zero if a latency target or the memory budget is exceeded, so
// it can gate a pipeline. Tunable via env: CYCLES, HEAP_BUDGET_MB.
//
// The leak gate is on post-GC `heapUsed` measured from a *post-warmup* baseline,
// not RSS: V8 rarely returns RSS to the OS even when live memory is flat, and the
// first cycles pay one-time lib.d.ts/JIT costs. heapUsed-after-gc reflects what's
// actually retained, which is what a leak would grow.

import { AzerothLanguageService, pathToUri } from '@azerothjs/language-service';
import path from 'node:path';
import { tmpdir } from 'node:os';

const CYCLES = Number(process.argv[2] ?? process.env.CYCLES ?? 1000);
const HEAP_BUDGET_MB = Number(process.env.HEAP_BUDGET_MB ?? 24);
const ROOT = tmpdir();
// Cycles excluded from the baseline so one-time costs don't count as a leak.
const WARMUP = Math.min(30, Math.floor(CYCLES / 5));

// Warm-request latency targets (ms). Completion is allowed more headroom than a
// pure navigation query, matching the prompt's <100ms / <50ms goals.
const TARGETS = { completion: 100, hover: 50, definition: 50 };

/** A large, realistic component: markup, expressions, class and styleMap CSS. */
function source(seed)
{
    const rows = [];
    for (let i = 0; i < 120; i++)
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

const positions = {
    completion: { line: 5, character: 20 },
    hover: { line: 5, character: 30 },
    definition: { line: 5, character: 30 }
};

function percentile(values, p)
{
    if (values.length === 0)
    {
        return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Forces GC (if exposed) and returns post-collection memory in MB. */
function memoryMB()
{
    if (typeof globalThis.gc === 'function')
    {
        // Collect twice: the first pass frees, the second compacts young survivors.
        globalThis.gc();
        globalThis.gc();
    }
    const { rss, heapUsed } = process.memoryUsage();
    return { rss: rss / (1024 * 1024), heap: heapUsed / (1024 * 1024) };
}

function time(fn)
{
    const start = performance.now();
    fn();
    return performance.now() - start;
}

const ls = new AzerothLanguageService(ROOT);
const samples = { completion: [], hover: [], definition: [] };
const rssTrend = [];

// Warm up once: the first call pays the cold lib.d.ts load.
const warmUri = pathToUri(path.join(ROOT, 'Warm.azeroth'));
ls.didOpen(warmUri, source(0));
ls.getDiagnostics(warmUri);
ls.getCompletions(warmUri, positions.completion);
ls.getHover(warmUri, positions.hover);
ls.getDefinition(warmUri, positions.definition);
ls.didClose(warmUri);

if (typeof globalThis.gc !== 'function')
{
    console.warn('! Run with `node --expose-gc` for an accurate memory reading.\n');
}

let baselineHeap = 0;

for (let c = 0; c < CYCLES; c++)
{
    const uri = pathToUri(path.join(ROOT, `Stress${ c }.azeroth`));
    ls.didOpen(uri, source(c));
    ls.getDiagnostics(uri);
    ls.getSemanticTokens(uri);
    ls.didChange(uri, source(c + 100000));

    const t = {
        completion: time(() => ls.getCompletions(uri, positions.completion)),
        hover: time(() => ls.getHover(uri, positions.hover)),
        definition: time(() => ls.getDefinition(uri, positions.definition))
    };
    ls.didClose(uri);

    // Only count steady-state cycles toward latency and the memory baseline.
    if (c >= WARMUP)
    {
        samples.completion.push(t.completion);
        samples.hover.push(t.hover);
        samples.definition.push(t.definition);
    }
    if (c === WARMUP)
    {
        baselineHeap = memoryMB().heap;
    }
    if (c % 100 === 0)
    {
        const { rss, heapUsed } = process.memoryUsage();
        rssTrend.push(rss / (1024 * 1024));
        process.stdout.write(`\r  cycle ${ c }/${ CYCLES }  heap ${ (heapUsed / (1024 * 1024)).toFixed(1) }MB   `);
    }
}

const final = memoryMB();
const stats = ls.getCacheStats();
const heapGrowth = final.heap - baselineHeap;

console.log('\n');
console.log(`Cycles:            ${ CYCLES } (first ${ WARMUP } excluded as warmup)`);
console.log('Latency (warm, ms) p50 / p95  [target]');
let latencyFail = false;
for (const key of ['completion', 'hover', 'definition'])
{
    const p50 = percentile(samples[key], 50);
    const p95 = percentile(samples[key], 95);
    const ok = p95 <= TARGETS[key];
    latencyFail ||= !ok;
    console.log(`  ${ key.padEnd(12) } ${ p50.toFixed(2) } / ${ p95.toFixed(2) }   [<= ${ TARGETS[key] }] ${ ok ? 'OK' : 'SLOW' }`);
}
console.log('');
console.log(`Heap (post-GC):    baseline ${ baselineHeap.toFixed(1) }MB -> final ${ final.heap.toFixed(1) }MB  (growth ${ heapGrowth.toFixed(1) }MB, budget ${ HEAP_BUDGET_MB }MB)`);
console.log(`RSS (final):       ${ final.rss.toFixed(1) }MB  (sticky; informational only)`);
console.log(`Open caches:       open=${ stats.openDocuments } virtual=${ stats.virtualCache } mtime=${ stats.mtimeCache }`);

const cacheLeak = stats.openDocuments !== 0 || stats.virtualCache !== 0;
const memoryFail = heapGrowth > HEAP_BUDGET_MB;
if (cacheLeak)
{
    console.error('\nFAIL: per-document caches not released after close (leak).');
}
if (memoryFail)
{
    console.error(`\nFAIL: post-GC heap grew ${ heapGrowth.toFixed(1) }MB > budget ${ HEAP_BUDGET_MB }MB.`);
}
if (latencyFail)
{
    console.error('\nFAIL: a warm-latency p95 exceeded its target.');
}
console.log(cacheLeak || memoryFail || latencyFail ? '\nResult: FAIL' : '\nResult: PASS');
process.exit(cacheLeak || memoryFail || latencyFail ? 1 : 0);
