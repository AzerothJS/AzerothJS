// @vitest-environment node
//
// Full behavioral coverage for createStream (create-stream.ts): incremental text
// accumulation, an `initial` seed, custom parse, fetcher-error capture, and cancel.
// Uses real web ReadableStream / Response (no mocked streaming primitive); only the
// network boundary (the fetcher) is supplied by the test.
import { describe, it, expect } from 'vitest';
import {
    batch,
    createStream,
    createRoot,
    createSignal,
    createEffect,
    catchError,
    h,
    renderToString,
    type Stream
} from 'azerothjs';

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

describe('createStream - text accumulation', () =>
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

    it('accepts the POSITIONAL (source, fetcher, options) form the `stream` keyword emits', async () =>
    {
        // The compiler lowers `stream x = (v) => fetch(v) with { source, parse }` to
        // createStream(source, fetcher, options) - positional, parallel to createResource.
        // The runtime must accept it (this was broken: only the options-object form existed).
        let stream!: Stream;
        let dispose!: () => void;
        let fetcherSaw: string | undefined;
        createRoot((d) =>
        {
            dispose = d;
            const [channel] = createSignal('room-1');
            const fetcher = (value: string): Promise<Response> =>
            {
                fetcherSaw = value;
                return Promise.resolve(responseOf(['a', 'b']));
            };
            stream = createStream(() => channel(), fetcher, { parse: 'text' });
        });
        await until(() => stream.done());
        expect(fetcherSaw).toBe('room-1'); // the fetcher received the resolved SOURCE VALUE
        expect(stream.partial()).toBe('ab');
        dispose();
    });

    it('accepts the positional form with no source: (fetcher, options)', async () =>
    {
        let stream!: Stream;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            stream = createStream(() => Promise.resolve(responseOf(['hi'])), { initial: '> ' });
        });
        await until(() => stream.done());
        expect(stream.partial()).toBe('> hi');
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

describe('createStream - custom parse', () =>
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

describe('createStream - error and cancellation', () =>
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
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
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
        controller!.enqueue(encoder.encode('partial-data'));
        await until(() => stream.partial() === 'partial-data');
        expect(stream.done()).toBe(false);

        stream.cancel();
        expect(stream.done()).toBe(true);
        expect(stream.partial()).toBe('partial-data');
        expect(stream.error()).toBeNull();
        dispose();
    });
});

describe('createStream - source identity and commands', () =>
{
    it('first samples the source when the batch flushes and never samples it during string rendering', async () =>
    {
        const trace: string[] = [];
        const source = () =>
        {
            trace.push('source');
            return 'A';
        };
        const fetcher = () =>
        {
            trace.push('fetch');
            return Promise.resolve(responseOf([]));
        };
        const html = renderToString(() => h('p', {}, createStream(source, fetcher, { initial: 'seed' }).partial()));
        expect(html).toBe('<p>seed</p>');
        expect(trace).toEqual([]);
        const dispose = createRoot(dispose =>
        {
            batch(() =>
            {
                createStream(source, fetcher);
                expect(trace).toEqual([]);
            });
            return dispose;
        });
        expect(trace).toEqual(['source']);
        await Promise.resolve();
        expect(trace).toEqual(['source', 'fetch']);
        dispose();
    });

    it('clears a cancelled partial on skip and accepts zero and empty-string keys', async () =>
    {
        const [key, setKey] = createSignal<string | number | false | null | undefined>(0);
        const starts: Array<string | number> = [];
        const { stream, dispose } = createRoot(dispose => ({
            dispose,
            stream: createStream<string | number>({
                source: key,
                initial: 'seed',
                fetcher: async ({ source }) =>
                {
                    starts.push(source);
                    return new Response(new ReadableStream({
                        start(controller)
                        {
                            controller.enqueue(encoder.encode('!'));
                        }
                    }));
                }
            })
        }));
        await until(() => stream.partial() === 'seed!');
        expect(stream.partial()).toBe('seed!');
        stream.cancel();
        for (const skip of [false, null, undefined] as const)
        {
            setKey(skip);
            expect(stream.done()).toBe(true);
            expect(stream.partial()).toBe('seed');
        }
        setKey('');
        await Promise.resolve();
        expect(starts).toEqual([0, '']);
        dispose();
    });

    it('keeps a custom-equal request alive, observes keys after cancellation and resamples on refetch', async () =>
    {
        const [version, setVersion] = createSignal(0);
        let id = 'first';
        let reads = 0;
        const starts: Array<{ id: string; version: number; signal: AbortSignal }> = [];
        const { stream, dispose } = createRoot(dispose => ({
            dispose,
            stream: createStream(() =>
            {
                reads++;
                return { id, version: version() };
            }, (key, signal) =>
            {
                starts.push({ ...key, signal });
                return new Promise<Response>(() => undefined);
            }, { equals: (previous, next) => previous.id === next.id })
        }));

        await Promise.resolve();
        setVersion(1);
        await Promise.resolve();
        expect(starts).toHaveLength(1);
        expect(starts[0]?.signal.aborted).toBe(false);
        const beforeCancel = reads;
        stream.cancel();
        expect(reads).toBe(beforeCancel);
        expect(starts[0]?.signal.aborted).toBe(true);
        setVersion(2);
        await Promise.resolve();
        expect(starts).toHaveLength(1);
        expect(stream.done()).toBe(true);
        stream.refetch();
        await Promise.resolve();
        expect(starts.map(call => call.version)).toEqual([0, 0]);
        stream.cancel();

        id = 'second';
        setVersion(3);
        await Promise.resolve();
        expect(starts.map(call => call.id)).toEqual(['first', 'first', 'second']);
        expect(stream.done()).toBe(false);
        id = 'third'; // No reactive write: an explicit fetch samples the source again.
        stream.refetch();
        await Promise.resolve();
        expect(starts.map(call => call.id)).toEqual(['first', 'first', 'second', 'third']);
        expect(starts[2]?.signal.aborted).toBe(true);
        dispose();
    });

    it.each(['cancel then key', 'key then cancel', 'cancel then refetch', 'refetch then cancel'])(
        'keeps observing the selected key when a batch contains %s', async order =>
        {
            const [key, setKey] = createSignal('A');
            const starts: string[] = [];
            const { stream, dispose } = createRoot(dispose => ({
                dispose,
                stream: createStream(key, value =>
                {
                    starts.push(value);
                    return new Promise<Response>(() => undefined);
                })
            }));
            await Promise.resolve();
            const otherCommand = order.includes('key') ? () => setKey('B') : stream.refetch;
            batch(() =>
            {
                if (order.startsWith('cancel'))
                {
                    stream.cancel();
                    otherCommand();
                }
                else
                {
                    otherCommand();
                    stream.cancel();
                }
            });
            await Promise.resolve();
            expect(starts).toEqual(['A']);
            expect(stream.done()).toBe(true);
            setKey('C');
            await Promise.resolve();
            expect(starts).toEqual(['A', 'C']);
            dispose();
        }
    );

    it('routes a source error in a cancellation batch once and recovers on the next valid key', async () =>
    {
        const failure = new Error('source');
        const caught: unknown[] = [];
        const [bad, setBad] = createSignal(false);
        const signals: AbortSignal[] = [];
        let stream!: Stream;
        const dispose = createRoot(dispose =>
        {
            catchError(() =>
            {
                stream = createStream(() =>
                {
                    if (bad())
                    {
                        throw failure;
                    }
                    return 'A';
                }, (_key, signal) =>
                {
                    signals.push(signal);
                    return new Promise<Response>(() => undefined);
                });
            }, error =>
            {
                caught.push(error);
            });
            return dispose;
        });
        await Promise.resolve();
        batch(() =>
        {
            setBad(true);
            stream.cancel();
        });
        expect(caught).toEqual([failure]);
        expect(caught[0]).toBe(failure);
        expect(stream.done()).toBe(true);
        expect(stream.error()).toBeNull();
        expect(signals[0]?.aborted).toBe(true);
        setBad(false);
        await Promise.resolve();
        expect(signals).toHaveLength(2);
        expect(stream.done()).toBe(false);
        dispose();
    });

    it('flushes only the current parser when a replaced reader closes with a buffered tail', async () =>
    {
        const [key, setKey] = createSignal('old');
        const bodies = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
        const { stream, dispose } = createRoot(dispose => ({
            dispose,
            stream: createStream(key, id => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
                start(controller)
                {
                    bodies.set(id, controller);
                    controller.enqueue(encoder.encode(`{"text":"${ id }:"}\n{"text":"${ id }-tail"}`));
                }
            }))), { parse: 'ndjson' })
        }));
        await until(() => stream.partial() === 'old:');
        expect(stream.partial()).toBe('old:');
        setKey('new');
        await until(() => stream.partial() === 'new:');
        expect(stream.partial()).toBe('new:');
        bodies.get('old')!.close();
        bodies.get('new')!.close();
        await until(() => stream.done());
        expect(stream.partial()).toBe('new:new-tail');
        dispose();
    });

    it('discards a custom parser result if the parser itself selects a new key', async () =>
    {
        const [key, setKey] = createSignal('old');
        const starts: string[] = [];
        const { stream, dispose } = createRoot(dispose => ({
            dispose,
            stream: createStream(key, id =>
            {
                starts.push(id);
                return id === 'old' ? Promise.resolve(responseOf(['old text'])) : new Promise<Response>(() => undefined);
            }, {
                initial: 'seed',
                parse(text)
                {
                    setKey('new');
                    return text;
                }
            })
        }));
        await until(() => starts.includes('new'));
        expect(starts).toEqual(['old', 'new']);
        expect(stream.partial()).toBe('seed');
        dispose();
    });

    it('does not request the first key when its source disposes the owner', async () =>
    {
        const starts: string[] = [];
        const stream = createRoot(dispose => createStream(() =>
        {
            dispose();
            return 'key';
        }, key =>
        {
            starts.push(key);
            return Promise.resolve(responseOf([]));
        }, { initial: 'seed' }));
        await Promise.resolve();
        expect(starts).toEqual([]);
        expect([stream.partial(), stream.done()]).toEqual(['seed', true]);
    });

    it.each([
        ['source', false], ['source', true], ['comparator', false], ['comparator', true]
    ] as const)('retains the stream snapshot when the %s disposes it (throws: %s)', async (callback, throws) =>
    {
        const [key, setKey] = createSignal('A');
        const starts: string[] = [];
        const caught: unknown[] = [];
        const failure = new Error('after disposal');
        let stream!: Stream;
        createRoot(dispose =>
        {
            function disposeOnB(from: 'source' | 'comparator', value: string): void
            {
                if (from === callback && value === 'B')
                {
                    dispose();
                    if (throws)
                    {
                        throw failure;
                    }
                }
            }
            catchError(() =>
            {
                stream = createStream(() =>
                {
                    const value = key();
                    disposeOnB('source', value);
                    return value;
                }, value =>
                {
                    starts.push(value);
                    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
                        start(controller)
                        {
                            controller.enqueue(encoder.encode(value));
                        }
                    })));
                }, {
                    equals(previous, next)
                    {
                        disposeOnB('comparator', next);
                        return previous === next;
                    }
                });
            }, error =>
            {
                caught.push(error);
            });
        });
        await until(() => stream.partial() === 'A');
        expect([stream.partial(), stream.done()]).toEqual(['A', false]);
        setKey('B');
        stream.refetch();
        await Promise.resolve();
        expect(starts).toEqual(['A']);
        expect([stream.partial(), stream.done(), stream.error()]).toEqual(['A', false, null]);
        expect(caught).toHaveLength(throws ? 1 : 0);
        if (throws)
        {
            expect(caught[0]).toBe(failure);
        }
    });
});

describe('createStream - settle error routing', () =>
{
    it('routes a subscriber that throws during settle to the enclosing catchError, not an unhandled rejection', async () =>
    {
        // The completion/error arms write signals (setDone / the error batch); a subscriber that
        // throws during that flush rethrows into a promise reaction. It must instead route to the
        // handler captured when the stream was created.
        let caught: unknown = null;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            let stream!: Stream;
            catchError(
                () =>
                {
                    stream = createStream({ fetcher: async () => responseOf(['tok']) });
                },
                (err) =>
                {
                    caught = err;
                }
            );
            createEffect(() =>
            {
                if (stream.done() && stream.partial().includes('tok'))
                {
                    throw new Error('stream-subscriber-boom');
                }
            });
        });

        await until(() => caught !== null);
        dispose();
        expect((caught as Error).message).toBe('stream-subscriber-boom');
    });
});
