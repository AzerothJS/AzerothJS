import { describe, it, expect, vi } from 'vitest';
import { createRoot, createSignal, createStream } from '@azerothjs/core';

// ── Helpers ──────────────────────────────────────────────────

interface ControlledResponse
{
    response: Response;
    push: (text: string) => void;
    pushBytes: (bytes: Uint8Array) => void;
    close: () => void;
    error: (err: unknown) => void;
    /** The AbortSignal that the consumer passed to fetch — set by tests via the fetcher. */
    signal?: AbortSignal;
}

/**
 * Builds a Response whose body is a ReadableStream we can push
 * to manually. Lets tests step through streaming timing precisely
 * instead of racing real network or microtasks.
 */
function makeControlledResponse(): ControlledResponse
{
    let controller!: ReadableStreamDefaultController<Uint8Array>;

    const stream = new ReadableStream<Uint8Array>({
        start(c)
        {
            controller = c;
        }
    });

    const encoder = new TextEncoder();

    return {
        response: new Response(stream),
        push: (text: string): void => controller.enqueue(encoder.encode(text)),
        pushBytes: (bytes: Uint8Array): void => controller.enqueue(bytes),
        close: (): void => controller.close(),
        error: (err: unknown): void => controller.error(err)
    };
}

/**
 * Drains the microtask queue many times. createStream's pipeline
 * is several `.then` deep (fetcher → consume → reader.read), and
 * each chunk needs a fresh round of microtask flushes. 20 drains
 * is plenty of slack for any test in this file.
 */
async function flush(): Promise<void>
{
    for (let i = 0; i < 20; i++)
    {
        await Promise.resolve();
    }
}

// ─────────────────────────────────────────────────────────────

describe('createStream — text mode', () =>
{
    it('accumulates chunks into partial() and flips done() on close', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const ctrl = makeControlledResponse();
            const stream = createStream({
                fetcher: () => Promise.resolve(ctrl.response),
                parse: 'text'
            });

            // Initial state — fetch in flight.
            expect(stream.done()).toBe(false);
            expect(stream.partial()).toBe('');

            ctrl.push('Hello, ');
            await flush();
            expect(stream.partial()).toBe('Hello, ');
            expect(stream.done()).toBe(false);

            ctrl.push('world!');
            await flush();
            expect(stream.partial()).toBe('Hello, world!');

            ctrl.close();
            await flush();
            expect(stream.done()).toBe(true);
            expect(stream.error()).toBeNull();

            dispose();
        });
    });

    it('handles multi-byte UTF-8 sequences split across reads', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const ctrl = makeControlledResponse();
            const stream = createStream({
                fetcher: () => Promise.resolve(ctrl.response),
                parse: 'text'
            });

            // The character `é` is 0xC3 0xA9 in UTF-8. Splitting
            // it between two reads must NOT corrupt the output —
            // TextDecoder({ stream: true }) holds the partial
            // sequence until the continuation byte arrives.
            ctrl.pushBytes(new Uint8Array([0xC3]));
            await flush();
            // No complete character yet — partial may be empty
            // (decoder buffered the lead byte).
            expect(stream.partial()).toBe('');

            ctrl.pushBytes(new Uint8Array([0xA9]));
            await flush();
            expect(stream.partial()).toBe('é');

            ctrl.close();
            await flush();
            expect(stream.done()).toBe(true);

            dispose();
        });
    });
});

describe('createStream — SSE mode', () =>
{
    it('strips data: prefix and collapses events into partial()', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const ctrl = makeControlledResponse();
            const stream = createStream({
                fetcher: () => Promise.resolve(ctrl.response),
                parse: 'sse'
            });

            ctrl.push('data: hello\n\n');
            await flush();
            expect(stream.partial()).toBe('hello');

            ctrl.push('data:  world\n\n'); // extra space tolerated
            await flush();
            expect(stream.partial()).toBe('helloworld');

            ctrl.close();
            await flush();
            expect(stream.done()).toBe(true);

            dispose();
        });
    });

    it('terminates cleanly on the [DONE] sentinel', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const ctrl = makeControlledResponse();
            const stream = createStream({
                fetcher: () => Promise.resolve(ctrl.response),
                parse: 'sse'
            });

            ctrl.push('data: first\n\n');
            ctrl.push('data: [DONE]\n\n');
            // Server keeps the stream open — but we should stop
            // reading on [DONE].
            await flush();

            expect(stream.partial()).toBe('first');
            expect(stream.done()).toBe(true);
            expect(stream.error()).toBeNull();

            dispose();
        });
    });

    it('skips blank lines and SSE comment lines', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const ctrl = makeControlledResponse();
            const stream = createStream({
                fetcher: () => Promise.resolve(ctrl.response),
                parse: 'sse'
            });

            // SSE event with a comment, blank line, then data.
            ctrl.push(': heartbeat\n');
            ctrl.push('data: a\n\n');
            ctrl.push('\n\n'); // empty event — no data line
            ctrl.push(': another comment\ndata: b\n\n');
            await flush();

            expect(stream.partial()).toBe('ab');

            ctrl.close();
            await flush();
            dispose();
        });
    });

    it('buffers across reads when an event spans two chunks', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const ctrl = makeControlledResponse();
            const stream = createStream({
                fetcher: () => Promise.resolve(ctrl.response),
                parse: 'sse'
            });

            // First chunk has the start of `data: hello` but no
            // event terminator yet.
            ctrl.push('data: he');
            await flush();
            expect(stream.partial()).toBe('');  // event not complete

            // Second chunk completes the event.
            ctrl.push('llo\n\n');
            await flush();
            expect(stream.partial()).toBe('hello');

            ctrl.close();
            await flush();
            dispose();
        });
    });
});

describe('createStream — NDJSON mode', () =>
{
    it('parses JSON lines and extracts text/content/delta fields', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const ctrl = makeControlledResponse();
            const stream = createStream({
                fetcher: () => Promise.resolve(ctrl.response),
                parse: 'ndjson'
            });

            // Bare strings.
            ctrl.push('"hello"\n');
            await flush();
            expect(stream.partial()).toBe('hello');

            // Object with a `text` field.
            ctrl.push('{"text":" world"}\n');
            await flush();
            expect(stream.partial()).toBe('hello world');

            // Object with a `delta.content` shape (OpenAI-style).
            ctrl.push('{"delta":{"content":"!"}}\n');
            await flush();
            expect(stream.partial()).toBe('hello world!');

            // Malformed line — silently skipped.
            ctrl.push('not json at all\n');
            await flush();
            expect(stream.partial()).toBe('hello world!');

            ctrl.close();
            await flush();
            expect(stream.done()).toBe(true);

            dispose();
        });
    });
});

describe('createStream — lifecycle', () =>
{
    it('cancel() aborts the in-flight stream and preserves partial()', async () =>
    {
        await createRoot(async (dispose) =>
        {
            let capturedSignal!: AbortSignal;
            const ctrl = makeControlledResponse();

            const stream = createStream({
                fetcher: ({ signal }) =>
                {
                    capturedSignal = signal;
                    return Promise.resolve(ctrl.response);
                },
                parse: 'text'
            });

            ctrl.push('keep this');
            await flush();
            expect(stream.partial()).toBe('keep this');
            expect(capturedSignal.aborted).toBe(false);

            stream.cancel();
            await flush();

            // partial preserved; done flipped; signal aborted.
            expect(stream.partial()).toBe('keep this');
            expect(stream.done()).toBe(true);
            expect(stream.error()).toBeNull();
            expect(capturedSignal.aborted).toBe(true);

            dispose();
        });
    });

    it('captures fetcher errors in error() and flips done()', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const failure = new Error('network failed');
            const stream = createStream({
                fetcher: () => Promise.reject(failure),
                parse: 'text'
            });

            await flush();

            expect(stream.error()).toBe(failure);
            expect(stream.done()).toBe(true);
            expect(stream.partial()).toBe('');

            dispose();
        });
    });

    it('source change cancels the previous request and starts a new one', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const responses = [makeControlledResponse(), makeControlledResponse()];
            const signals: AbortSignal[] = [];
            let callCount = 0;

            const [topic, setTopic] = createSignal('weather');

            const stream = createStream({
                source: () => topic(),
                fetcher: ({ signal }) =>
                {
                    signals.push(signal);
                    const r = responses[callCount];
                    callCount++;
                    return Promise.resolve(r.response);
                },
                parse: 'text'
            });

            responses[0].push('weather data');
            await flush();
            expect(stream.partial()).toBe('weather data');
            expect(signals[0].aborted).toBe(false);

            // Change the source — should cancel the first stream
            // and start a fresh one with reset state.
            setTopic('news');
            await flush();

            expect(signals[0].aborted).toBe(true);
            expect(signals[1].aborted).toBe(false);
            expect(stream.partial()).toBe('');  // reset to initial

            responses[1].push('breaking news');
            await flush();
            expect(stream.partial()).toBe('breaking news');

            dispose();
        });
    });

    it('keeps done() false when a superseded stream rejects on abort', async () =>
    {
        await createRoot(async (dispose) =>
        {
            // Simulate a REAL fetch: aborting the signal errors the
            // response body, so the superseded stream's reader.read()
            // rejects (the controlled-response helper alone ignores
            // the signal, which is exactly why this race was invisible
            // to the other tests).
            const responses = [makeControlledResponse(), makeControlledResponse()];
            let callCount = 0;

            const [topic, setTopic] = createSignal('a');

            const stream = createStream({
                source: () => topic(),
                fetcher: ({ signal }) =>
                {
                    const r = responses[callCount];
                    callCount++;
                    signal.addEventListener('abort', () =>
                    {
                        r.error(new Error('aborted'));
                    });
                    return Promise.resolve(r.response);
                },
                parse: 'text'
            });

            responses[0].push('first');
            await flush();
            expect(stream.partial()).toBe('first');
            expect(stream.done()).toBe(false);

            // Source change: stream #0 is aborted (its reader now
            // rejects) and stream #1 starts.
            setTopic('b');
            await flush();

            // Stream #0's late rejection must NOT flip done() — stream
            // #1 is actively in flight.
            expect(stream.done()).toBe(false);
            expect(stream.partial()).toBe('');
            expect(stream.error()).toBeNull();

            responses[1].push('second');
            await flush();
            expect(stream.partial()).toBe('second');
            expect(stream.done()).toBe(false);

            responses[1].close();
            await flush();
            expect(stream.done()).toBe(true);

            dispose();
        });
    });
});

describe('createStream — custom parser', () =>
{
    it('routes raw chunks through a user function', async () =>
    {
        await createRoot(async (dispose) =>
        {
            // Custom protocol: `EVENT:foo|bar` — we extract the
            // pipe-separated payload, uppercase it.
            const parser = vi.fn((chunk: string) =>
                chunk.replace(/^EVENT:/g, '').replace(/\|/g, ' ').toUpperCase()
            );

            const ctrl = makeControlledResponse();
            const stream = createStream({
                fetcher: () => Promise.resolve(ctrl.response),
                parse: parser
            });

            ctrl.push('EVENT:hello|world');
            await flush();
            expect(parser).toHaveBeenCalledWith('EVENT:hello|world');
            expect(stream.partial()).toBe('HELLO WORLD');

            ctrl.close();
            await flush();
            dispose();
        });
    });
});
