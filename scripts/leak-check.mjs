// Deterministic reactive-graph leak gate for CI (run via `npm run leak`).
//
//   node --expose-gc scripts/leak-check.mjs
//
// Churns createRoot -> build a small reactive tree -> dispose, many times, and asserts the heap does NOT
// grow beyond a threshold once GC settles. It is deterministic and EXITS NON-ZERO on a leak, so it is
// safe to gate a PR on.
import { createSignal, createMemo, createEffect, createRoot } from '@azerothjs/reactivity';

const gc = globalThis.gc;
if (typeof gc !== 'function')
{
    console.error('leak-check requires --expose-gc (run: node --expose-gc scripts/leak-check.mjs)');
    process.exit(2);
}

/** One churn: build a small reactive tree under a root, then dispose it. A leak shows as heap growth. */
function churn(n)
{
    for (let i = 0; i < n; i++)
    {
        const dispose = createRoot((d) =>
        {
            const [s, set] = createSignal(0);
            const m = createMemo(() => s() + 1);
            createEffect(() =>
            {
                s(); m();
            });
            createEffect(() =>
            {
                m();
            });
            set(i);
            return d;
        });
        dispose();
    }
}

const THRESHOLD_KB = 2000;

churn(2000); // warm caches / JIT
gc(); await new Promise((r) => setTimeout(r, 50)); gc();
const before = process.memoryUsage().heapUsed;

churn(50000);
gc(); await new Promise((r) => setTimeout(r, 50)); gc();
const after = process.memoryUsage().heapUsed;

const deltaKB = (after - before) / 1024;
const stable = Math.abs(deltaKB) < THRESHOLD_KB;
console.log(`heap delta after 50k root churns: ${ deltaKB.toFixed(1) } KB (threshold ${ THRESHOLD_KB } KB) => ${ stable ? 'STABLE' : 'GROWS' }`);

if (!stable)
{
    console.error('LEAK DETECTED: disposing a reactive tree did not release its memory (heap grew past threshold).');
    process.exit(1);
}
