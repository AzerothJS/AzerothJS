// @vitest-environment node
//
// A streamed response's isolation unit is the RESPONSE LIFETIME: every monitored pull
// re-enters the request context explicitly, because a pull's async context is whoever
// DISPATCHED it - a Node implementation detail that flips on consumer pace alone. These
// arms pin the seam through the real kernel path (App -> request root -> monitored
// stream), with a per-arm cached family's fetch count as the scope witness: a
// request-scoped read reuses its entry (one fetch per request), while a scope-lost read
// on a marked server refuses the cache and fetches again - and, in DEV, warns.
import { describe, expect, it, vi } from 'vitest';
import { cached, createStore } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';
import { App } from '../src/app.ts';
import { sse } from '../src/sse.ts';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function countingFamily(name: string): { family: (key: string) => Promise<string>; fetches: () => number }
{
    let count = 0;
    const family = cached(name, (key: string) =>
    {
        count++;
        return Promise.resolve(`${ name }:${ key }`);
    });
    return { family, fetches: () => count };
}

function syncProducerHandler(family: (key: string) => Promise<string>, pulls: number): () => Promise<Response>
{
    return async (): Promise<Response> =>
    {
        await family('k');
        let n = 0;
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller)
            {
                if (n >= pulls)
                {
                    controller.close();
                    return;
                }
                n++;
                const value = await family('k');
                controller.enqueue(ENCODER.encode(value));
            }
        });
        return new Response(stream);
    };
}

async function consume(response: Response, gapMs: number): Promise<string[]>
{
    const reader = response.body!.getReader();
    const chunks: string[] = [];
    for (;;)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            break;
        }
        chunks.push(DECODER.decode(value));
        if (gapMs > 0)
        {
            await sleep(gapMs);
        }
    }
    return chunks;
}

describe('streamed responses keep their request scope', () =>
{
    it('a synchronous producer keeps the request scope at every pull, at 0ms, 10ms and 60ms consumer gaps', async () =>
    {
        const app = new App();
        for (const gap of [0, 10, 60])
        {
            const { family, fetches } = countingFamily(`paced-${ gap }`);
            app.get(`/s${ gap }`, syncProducerHandler(family, 3));
            const response = await app.handle(new Request(`http://local/s${ gap }`));
            const chunks = await consume(response, gap);
            expect(chunks).toEqual([`paced-${ gap }:k`, `paced-${ gap }:k`, `paced-${ gap }:k`]);
            expect(fetches()).toBe(1);
        }
    });

    it('sequential alice-then-bob on one family fetches exactly TWICE - each request owns its scope end to end', async () =>
    {
        const { family, fetches } = countingFamily('two-requests');
        const app = new App();
        app.get('/s', syncProducerHandler(family, 3));
        await consume(await app.handle(new Request('http://local/s')), 10);
        await consume(await app.handle(new Request('http://local/s')), 10);
        expect(fetches()).toBe(2);
    });

    it('holds across a 40-run stability sweep at the pace that failed 40/40 before the fix', async () =>
    {
        const app = new App();
        for (let run = 0; run < 40; run++)
        {
            const { family, fetches } = countingFamily(`sweep-${ run }`);
            app.get(`/w${ run }`, syncProducerHandler(family, 3));
            await consume(await app.handle(new Request(`http://local/w${ run }`)), 10);
            expect(fetches()).toBe(1);
        }
    });

    it('a disconnect that releases the request mid-pull completes the read on the silent path: no throw, no diagnostic', async () =>
    {
        resetDataCache();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            const { family, fetches } = countingFamily('abort-settle');
            let releaseGate!: () => void;
            const gate = new Promise<void>((resolve) =>
            {
                releaseGate = resolve;
            });
            const app = new App();
            app.get('/s', async () =>
            {
                await family('k');
                // The gated read must sit in pull #2: pull #1 is dispatched inside the
                // handler frame and inherits the context with or without re-entry, so a
                // one-pull shape could not fail this arm.
                let phase = 0;
                const stream = new ReadableStream<Uint8Array>({
                    async pull(controller)
                    {
                        if (phase === 0)
                        {
                            phase = 1;
                            controller.enqueue(ENCODER.encode('first'));
                            return;
                        }
                        if (phase === 1)
                        {
                            phase = 2;
                            await gate;
                            const value = await family('k');
                            controller.enqueue(ENCODER.encode(value));
                            return;
                        }
                        controller.close();
                    }
                });
                return new Response(stream);
            });
            const abort = new AbortController();
            const response = await app.handle(new Request('http://local/s', { signal: abort.signal }));
            const reader = response.body!.getReader();
            const first = await reader.read();
            expect(DECODER.decode(first.value)).toBe('first');
            const pending = reader.read();
            await sleep(20);
            abort.abort();
            await sleep(20);
            releaseGate();
            const { done, value } = await pending;
            expect(done).toBe(false);
            expect(DECODER.decode(value)).toBe('abort-settle:k');
            expect(fetches()).toBe(2);
            expect(warn).not.toHaveBeenCalled();
        }
        finally
        {
            warn.mockRestore();
        }
    });

    it('an sse connection.signal teardown listener runs in the request scope it belongs to', async () =>
    {
        resetDataCache();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            const { family, fetches } = countingFamily('sse-abort');
            let teardownValue: string | null = null;
            let teardownDone!: () => void;
            const teardownSeen = new Promise<void>((resolve) =>
            {
                teardownDone = resolve;
            });
            const app = new App();
            app.get('/sse', (context) => sse(context.request, async (connection) =>
            {
                await family('k');
                connection.signal.addEventListener('abort', () =>
                {
                    void family('k').then((value) =>
                    {
                        teardownValue = value;
                        teardownDone();
                    });
                }, { once: true });
                connection.send('hi');
            }));
            const abort = new AbortController();
            const response = await app.handle(new Request('http://local/sse', { signal: abort.signal }));
            const reader = response.body!.getReader();
            await reader.read();
            abort.abort();
            await teardownSeen;
            expect(teardownValue).toBe('sse-abort:k');
            expect(fetches()).toBe(1);
            expect(warn).not.toHaveBeenCalled();
        }
        finally
        {
            warn.mockRestore();
        }
    });

    it('a pull DISPATCHED after release resolves the request-scoped store to the dead request instance', async () =>
    {
        // The dispatch itself must be post-release, not just the read's completion: the
        // source stream runs at highWaterMark 0, so its pull fires only when a consumer
        // read finds the queue empty - which the test arranges to happen after the abort
        // settle released the request. A dispatch-time released-state gate (the design's
        // withdrawn v3 branch) fails HERE where the gated-read arm above cannot see it.
        resetDataCache();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            const slot = createStore(() => ({ owner: 'default' }));
            const { family, fetches } = countingFamily('straggler-store');
            let observedSame: boolean | null = null;
            let observedOwner: string | null = null;
            const app = new App();
            app.get('/s', async () =>
            {
                const mine = slot();
                mine.owner = 'request';
                await family('k');
                const stream = new ReadableStream<Uint8Array>({
                    start(controller)
                    {
                        controller.enqueue(ENCODER.encode('a'));
                        controller.enqueue(ENCODER.encode('b'));
                    },
                    async pull(controller)
                    {
                        const current = slot();
                        observedSame = current === mine;
                        observedOwner = current.owner;
                        await family('k');
                        controller.enqueue(ENCODER.encode('straggler'));
                        controller.close();
                    }
                }, new CountQueuingStrategy({ highWaterMark: 0 }));
                return new Response(stream);
            });
            const abort = new AbortController();
            const response = await app.handle(new Request('http://local/s', { signal: abort.signal }));
            const reader = response.body!.getReader();
            expect(DECODER.decode((await reader.read()).value)).toBe('a');
            abort.abort();
            await sleep(20);
            expect(DECODER.decode((await reader.read()).value)).toBe('b');
            expect(DECODER.decode((await reader.read()).value)).toBe('straggler');
            expect(observedSame).toBe(true);
            expect(observedOwner).toBe('request');
            expect(fetches()).toBe(2);
            expect(warn).not.toHaveBeenCalled();
        }
        finally
        {
            warn.mockRestore();
        }
    });

    it('a straggler whose scope never materialized a cache cannot create a live one after release', async () =>
    {
        resetDataCache();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            const { family, fetches } = countingFamily('straggler-first-read');
            const app = new App();
            app.get('/s', async () =>
            {
                const stream = new ReadableStream<Uint8Array>({
                    start(controller)
                    {
                        controller.enqueue(ENCODER.encode('a'));
                        controller.enqueue(ENCODER.encode('b'));
                    },
                    async pull(controller)
                    {
                        await family('k');
                        await family('k');
                        controller.enqueue(ENCODER.encode('straggler'));
                        controller.close();
                    }
                }, new CountQueuingStrategy({ highWaterMark: 0 }));
                return new Response(stream);
            });
            const abort = new AbortController();
            const response = await app.handle(new Request('http://local/s', { signal: abort.signal }));
            const reader = response.body!.getReader();
            expect(DECODER.decode((await reader.read()).value)).toBe('a');
            abort.abort();
            await sleep(20);
            expect(DECODER.decode((await reader.read()).value)).toBe('b');
            expect(DECODER.decode((await reader.read()).value)).toBe('straggler');
            expect(fetches()).toBe(2);
            expect(warn).not.toHaveBeenCalled();
        }
        finally
        {
            warn.mockRestore();
        }
    });

    it('an async push producer inherits the scope as before - the re-entry does not disturb it', async () =>
    {
        const { family, fetches } = countingFamily('async-producer');
        const app = new App();
        app.get('/s', async () =>
        {
            let push!: ReadableStreamDefaultController<Uint8Array>;
            const stream = new ReadableStream<Uint8Array>({
                start(controller)
                {
                    push = controller;
                }
            });
            void (async () =>
            {
                for (let n = 0; n < 3; n++)
                {
                    await sleep(5);
                    const value = await family('k');
                    push.enqueue(ENCODER.encode(value));
                }
                push.close();
            })();
            return new Response(stream);
        });
        const chunks = await consume(await app.handle(new Request('http://local/s')), 10);
        expect(chunks).toHaveLength(3);
        expect(fetches()).toBe(1);
    });
});
