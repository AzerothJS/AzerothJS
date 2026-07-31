// Lifecycle memory gate for CI (run via `npm run memory`).
//
//   node --expose-gc scripts/memory-check.mjs
//
// The sibling gate, leak-check.mjs, churns createRoot -> signal/memo/effect -> dispose and
// NOTHING else: no HTTP request, no WebSocket frame, no SSR render, no DOM. It is a good gate for
// the reactive graph and was repeatedly mistaken - by me - for a statement about the framework.
// This covers the lifecycles it never touches.
//
// Two deliberate differences from that gate:
//
//   - It watches RSS as well as heapUsed. `heapUsed` cannot see ArrayBuffers, sockets or native
//     handles, which is exactly where the ws and HTTP paths keep their memory, so a heap-only
//     gate is blind on the two subsystems most likely to hold bytes.
//   - It asserts a TREND, not a single before/after delta. Sampling across the churn and
//     comparing the first third against the last distinguishes a leak from a heap that simply had
//     not settled yet - a pair of readings cannot.

import { App, json } from '@azerothjs/http';
import { FrameParser, ProtocolError, serializeFrame } from '@azerothjs/ws';
import { css, collectStyleSheet, h, renderToStaticMarkup } from 'azerothjs';

const gc = globalThis.gc;
if (typeof gc !== 'function')
{
    console.error('memory-check requires --expose-gc (run: node --expose-gc scripts/memory-check.mjs)');
    process.exit(2);
}

const settle = async () =>
{
    gc();
    await new Promise((resolve) => setTimeout(resolve, 50));
    gc();
};

const MB = 1024 * 1024;

/**
 * Runs `churn` in `samples` slices, recording heap and RSS after each, then reports whether the
 * last third sits meaningfully above the first. Growth is judged on the trend because a single
 * pair of readings cannot tell a leak from an unsettled heap.
 */
async function trend(name, samples, perSample, churn, limits)
{
    await churn(Math.min(perSample, 500)); // warm
    await settle();

    const heap = [];
    const rss = [];
    for (let i = 0; i < samples; i++)
    {
        await churn(perSample);
        await settle();
        heap.push(process.memoryUsage().heapUsed);
        rss.push(process.memoryUsage().rss);
    }

    const third = Math.max(1, Math.floor(samples / 3));
    const median = (list) =>
    {
        const s = [...list].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
    };
    const heapGrowth = (median(heap.slice(-third)) - median(heap.slice(0, third))) / MB;
    const rssGrowth = (median(rss.slice(-third)) - median(rss.slice(0, third))) / MB;

    const ok = heapGrowth < limits.heapMB && rssGrowth < limits.rssMB;
    const total = samples * perSample;
    console.log(`${ name.padEnd(34) } heap ${ heapGrowth >= 0 ? '+' : '' }${ heapGrowth.toFixed(1) } MB   rss ${ rssGrowth >= 0 ? '+' : '' }${ rssGrowth.toFixed(1) } MB   over ${ total.toLocaleString() } churns   => ${ ok ? 'STABLE' : 'GROWS' }`);
    if (!ok)
    {
        failures.push(`${ name }: heap +${ heapGrowth.toFixed(1) } MB (limit ${ limits.heapMB }), rss +${ rssGrowth.toFixed(1) } MB (limit ${ limits.rssMB })`);
    }
}

const failures = [];

// ---- 1. HTTP request lifecycle. Covers the per-request reactive root, the lazy url/path caches
// and the cleanup registry - none of which the reactive gate reaches.
const app = new App({ dev: false });
app.get('/', () => json({ ok: 1 }));
app.get('/users/:id', (context) => json({ id: context.params.id }));
app.get('/boom', () =>
{
    throw new Error('handler exploded');
});
app.get('/stream', () => new Response(new ReadableStream({
    start(controller)
    {
        controller.enqueue(new TextEncoder().encode('chunk'));
        controller.close();
    }
})));

const REQUESTS = ['/', '/users/42', '/boom', '/stream', '/nowhere'];

await trend('http request lifecycle', 9, 4000, async (n) =>
{
    for (let i = 0; i < n; i++)
    {
        const response = await app.handle(new Request(`http://local${ REQUESTS[i % REQUESTS.length] }`));
        await response.arrayBuffer(); // drain, as an adapter would
    }
}, { heapMB: 4, rssMB: 24 });

// ---- 2. ProtocolError.frames. The second audit made a thrown protocol error carry the frames
// that completed before it, so a connection dying on a violation now retains payloads until the
// error is dropped. Nothing tested that they ARE dropped.
const VIOLATION = (() =>
{
    const good = serializeFrame(0x1, new TextEncoder().encode('x'.repeat(512)), { mask: true });
    const bad = serializeFrame(0x1, new TextEncoder().encode('y'.repeat(512)), { mask: true });
    bad[0] |= 0x40; // RSV1 with no negotiated extension
    const bytes = new Uint8Array(good.length * 4 + bad.length);
    let offset = 0;
    for (let i = 0; i < 4; i++)
    {
        bytes.set(good, offset);
        offset += good.length;
    }
    bytes.set(bad, offset);
    return bytes;
})();

await trend('ws protocol-error retention', 9, 4000, (n) =>
{
    for (let i = 0; i < n; i++)
    {
        try
        {
            new FrameParser({ maxPayload: 1 << 20 }).push(VIOLATION);
        }
        catch (error)
        {
            if (!(error instanceof ProtocolError))
            {
                throw error;
            }
            // The frames ride on the error; dropping it here must drop them too.
        }
    }
}, { heapMB: 4, rssMB: 24 });

// ---- 3. SSR render churn. `registeredCss` and `injectedScopes` are module-level and live for the
// process; the per-render frame is deliberately kept out of them. If a per-render key ever reached
// the global registry it would serve one request's CSS to every later one AND grow forever.
const styles = css`
    .card { color: red; padding: 4px; }
    .card:hover { color: blue; }
`;

await trend('ssr render + scoped css', 9, 400, (n) =>
{
    for (let i = 0; i < n; i++)
    {
        renderToStaticMarkup(() => h('div', { class: styles.card, id: `n${ i }` },
            h('span', { class: styles.card, title: `t${ i }` }, `row ${ i }`)));
        collectStyleSheet();
    }
}, { heapMB: 4, rssMB: 24 });

console.log('');
if (failures.length > 0)
{
    for (const failure of failures)
    {
        console.error(`LEAK DETECTED: ${ failure }`);
    }
    process.exit(1);
}
console.log('every lifecycle settled.');
