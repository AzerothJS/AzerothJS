// @vitest-environment node
//
// Full behavioral coverage for createStream (create-stream.ts): incremental text
// accumulation, an `initial` seed, custom parse, fetcher-error capture, and cancel.
// Uses real web ReadableStream / Response (no mocked streaming primitive); only the
// network boundary (the fetcher) is supplied by the test.
import { describe, it, expect } from 'vitest';
import {
    createStream,
    createRoot,
    type Stream
} from '@azerothjs/reactivity';

const encoder = new TextEncoder();

function responseOf(chunks: string[]): Response
{
    const body = new ReadableStream<Uint8Array>({
        start(controller)
        {
            for (const chunk of chunks)
            {
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        }
    });
    return new Response(body);
}

async function until(predicate: () => boolean, max = 100): Promise<void>
{
    for (let i = 0; i < max && !predicate(); i++)
    {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

describe('createStream — text accumulation', () =>
{
    it('accumulates chunks into partial and flips done at the end', async () =>
    {
        let stream!: Stream;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            stream = createStream({ fetcher: async () => responseOf(['Hello ', 'world']) });
        });
        await until(() => stream.done());
        expect(stream.partial()).toBe('Hello world');
        expect(stream.done()).toBe(true);
        expect(stream.error()).toBeNull();
        dispose();
    });

    it('seeds partial with the initial value before chunks arrive', async () =>
    {
        let stream!: Stream;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            stream = createStream({ initial: '> ', fetcher: async () => responseOf(['x']) });
        });
        expect(stream.partial()).toBe('> ');
        await until(() => stream.done());
        expect(stream.partial()).toBe('> x');
        dispose();
    });
});

describe('createStream — custom parse', () =>
{
    it('routes each decoded chunk through the parse function', async () =>
    {
        let stream!: Stream;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            stream = createStream({
                parse: (chunk) => chunk.toUpperCase(),
                fetcher: async () => responseOf(['ab', 'cd'])
            });
        });
        await until(() => stream.done());
        expect(stream.partial()).toBe('ABCD');
        dispose();
    });
});

describe('createStream — error and cancellation', () =>
{
    it('captures a fetcher rejection in error() and finishes', async () =>
    {
        let stream!: Stream;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            stream = createStream({
                fetcher: async () =>
                {
                    throw new Error('net');
                }
            });
        });
        await until(() => stream.done());
        expect((stream.error() as Error).message).toBe('net');
        expect(stream.done()).toBe(true);
        dispose();
    });

    it('cancel() ends the stream and preserves the partial text', async () =>
    {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
            start(c)
            {
                controller = c;
            }
        });
        let stream!: Stream;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            stream = createStream({ fetcher: async () => new Response(body) });
        });

        await until(() => controller !== undefined);
        controller.enqueue(encoder.encode('partial-data'));
        await until(() => stream.partial() === 'partial-data');
        expect(stream.done()).toBe(false);

        stream.cancel();
        expect(stream.done()).toBe(true);
        expect(stream.partial()).toBe('partial-data');
        expect(stream.error()).toBeNull();
        dispose();
    });
});
