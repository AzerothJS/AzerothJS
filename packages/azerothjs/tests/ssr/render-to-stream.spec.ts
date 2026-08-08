// @vitest-environment node
//
// Streaming SSR: the shell flushes synchronously with Suspense fallbacks in place, pending
// boundaries stream later as out-of-order template+swap chunks carrying resource seeds, and
// the render root stays alive until the stream completes. Runs in the node environment on
// purpose: streaming must need no DOM shim, exactly like renderToString.
import { describe, expect, it, vi } from 'vitest';
import { Suspense, createResource, h, onRootDispose, renderToStream, renderToString } from 'azerothjs';
import type { Resource } from 'azerothjs';

interface Deferred<T>
{
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T>
{
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) =>
    {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string[]>
{
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    const reader = stream.getReader();
    for (;;)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            break;
        }
        chunks.push(decoder.decode(value, { stream: true }));
    }
    return chunks;
}

async function readOne(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string>
{
    const { done, value } = await reader.read();
    expect(done).toBe(false);
    return new TextDecoder().decode(value);
}

function pendingPage(gate: Deferred<string>, signals?: AbortSignal[]): { app: () => HTMLElement; resource: () => Resource<string> | undefined }
{
    let resource: Resource<string> | undefined;
    const app = (): HTMLElement =>
    {
        resource = createResource<string>((signal) =>
        {
            signals?.push(signal);
            return gate.promise;
        });
        return h('main', {},
            h('h1', {}, 'shell'),
            Suspense({
                fallback: () => h('p', {}, 'loading'),
                on: [resource],
                children: () => h('section', {}, () => resource?.data() ?? '')
            }));
    };
    return { app, resource: () => resource };
}

describe('renderToStream - the synchronous shell', () =>
{
    it('a page with no pending boundary streams one chunk, byte-identical to renderToString', async () =>
    {
        const page = (): HTMLElement => h('main', {}, h('h1', {}, 'static'), h('p', {}, 'body'));
        const chunks = await readAll(renderToStream(page));
        expect(chunks.join('')).toBe(renderToString(page));
    });

    it('a settled Suspense streams inline with the bare marker, not an id-suffixed one', async () =>
    {
        const page = (): HTMLElement => Suspense({
            fallback: () => h('p', {}, 'loading'),
            on: [],
            children: () => h('div', {}, 'ready')
        }) as unknown as HTMLElement;
        const chunks = await readAll(renderToStream(page));
        expect(chunks.join('')).toContain('<!--azc:suspense--><div>ready</div><!--/azc-->');
    });

    it('a top-level component throw propagates from the call itself - zero bytes ever flush', () =>
    {
        expect(() => renderToStream(() =>
        {
            throw new Error('boom at the top');
        })).toThrow('boom at the top');
    });
});

describe('renderToStream - pending boundaries', () =>
{
    it('flushes the shell with the fallback BEFORE the data resolves, then streams the chunk', async () =>
    {
        const gate = deferred<string>();
        const { app } = pendingPage(gate);
        const reader = renderToStream(app).getReader();

        const first = await readOne(reader);
        expect(first).toContain('<h1>shell</h1>');
        expect(first).toContain('<!--azc:suspense:0--><p>loading</p><!--/azc-->');
        expect(first).not.toContain('data-azs');

        gate.resolve('streamed value');
        let rest = '';
        for (;;)
        {
            const { done, value } = await reader.read();
            if (done)
            {
                break;
            }
            rest += new TextDecoder().decode(value);
        }
        expect(rest).toContain('<template data-azs="0">');
        expect(rest).toContain('streamed value');
        expect(rest).toContain('data-azs-seed="0"');
        expect(rest).toContain('"d":"streamed value"');
        expect(rest).toContain('__AZS(0)');
    });

    it('two sibling boundaries stream in SETTLE order, ids in document order', async () =>
    {
        const first = deferred<string>();
        const second = deferred<string>();
        const page = (): HTMLElement =>
        {
            const a = createResource<string>(() => first.promise);
            const b = createResource<string>(() => second.promise);
            return h('main', {},
                Suspense({ fallback: () => h('i', {}, 'fa'), on: [a], children: () => h('b', {}, () => a.data() ?? '') }),
                Suspense({ fallback: () => h('i', {}, 'fb'), on: [b], children: () => h('b', {}, () => b.data() ?? '') }));
        };
        const reader = renderToStream(page).getReader();
        const shell = await readOne(reader);
        expect(shell).toContain('azc:suspense:0');
        expect(shell).toContain('azc:suspense:1');

        second.resolve('B');
        const chunkB = await readOne(reader);
        expect(chunkB).toContain('data-azs="1"');
        expect(chunkB).not.toContain('data-azs="0"');

        first.resolve('A');
        let rest = '';
        for (;;)
        {
            const { done, value } = await reader.read();
            if (done)
            {
                break;
            }
            rest += new TextDecoder().decode(value);
        }
        expect(rest).toContain('data-azs="0"');
    });

    it('a nested pending boundary rides inside its parent chunk and streams after it', async () =>
    {
        const outer = deferred<string>();
        const inner = deferred<string>();
        const page = (): HTMLElement =>
        {
            const a = createResource<string>(() => outer.promise);
            return h('main', {},
                Suspense({
                    fallback: () => h('i', {}, 'out-fallback'),
                    on: [a],
                    children: () =>
                    {
                        const b = createResource<string>(() => inner.promise);
                        return h('div', {},
                            h('span', {}, () => a.data() ?? ''),
                            Suspense({ fallback: () => h('i', {}, 'in-fallback'), on: [b], children: () => h('em', {}, () => b.data() ?? '') }));
                    }
                }));
        };
        const reader = renderToStream(page).getReader();
        await readOne(reader);

        outer.resolve('OUT');
        const outerChunk = await readOne(reader);
        expect(outerChunk).toContain('data-azs="0"');
        expect(outerChunk).toContain('azc:suspense:1');
        expect(outerChunk).toContain('in-fallback');

        inner.resolve('IN');
        let rest = '';
        for (;;)
        {
            const { done, value } = await reader.read();
            if (done)
            {
                break;
            }
            rest += new TextDecoder().decode(value);
        }
        expect(rest).toContain('data-azs="1"');
        expect(rest).toContain('IN');
    });

    it('a rejecting resource settles the boundary: children render the error state, the seed carries e', async () =>
    {
        const gate = deferred<string>();
        const page = (): HTMLElement =>
        {
            const a = createResource<string>(() => gate.promise);
            return Suspense({
                fallback: () => h('i', {}, 'loading'),
                on: [a],
                children: () => h('div', {}, () => (a.error() !== null ? 'failed' : a.data() ?? ''))
            }) as unknown as HTMLElement;
        };
        const reader = renderToStream(page).getReader();
        await readOne(reader);
        gate.reject(new Error('fetch died'));
        let rest = '';
        for (;;)
        {
            const { done, value } = await reader.read();
            if (done)
            {
                break;
            }
            rest += new TextDecoder().decode(value);
        }
        expect(rest).toContain('failed');
        expect(rest).toContain('"e":');
        expect(rest).toContain('fetch died');
    });

    it('a continuation that throws emits NO chunk, reports onError, and the stream still closes', async () =>
    {
        const gate = deferred<string>();
        const onError = vi.fn();
        const page = (): HTMLElement =>
        {
            const a = createResource<string>(() => gate.promise);
            return h('main', {},
                Suspense({
                    fallback: () => h('i', {}, 'loading'),
                    on: [a],
                    children: (): HTMLElement =>
                    {
                        throw new Error('render exploded');
                    }
                }));
        };
        const stream = renderToStream(page, { onError });
        const reader = stream.getReader();
        await readOne(reader);
        gate.resolve('never seen');
        let rest = '';
        for (;;)
        {
            const { done, value } = await reader.read();
            if (done)
            {
                break;
            }
            rest += new TextDecoder().decode(value);
        }
        expect(rest).not.toContain('data-azs="0">');
        expect(onError).toHaveBeenCalledOnce();
    });

    it('a boundary that never settles hits the timeout: fetch aborted, tail flushed, stream closed', async () =>
    {
        const gate = deferred<string>();
        const signals: AbortSignal[] = [];
        const { app } = pendingPage(gate, signals);
        const chunks = await readAll(renderToStream(app, { settleTimeoutMs: 30 }));
        expect(chunks.join('')).not.toContain('data-azs="0">');
        expect(signals[0]?.aborted).toBe(true);
    });

    it('aborting the signal finalizes: fetches aborted, stream ends', async () =>
    {
        const gate = deferred<string>();
        const signals: AbortSignal[] = [];
        const { app } = pendingPage(gate, signals);
        const controller = new AbortController();
        const reader = renderToStream(app, { signal: controller.signal }).getReader();
        await readOne(reader);
        controller.abort();
        for (;;)
        {
            const { done } = await reader.read();
            if (done)
            {
                break;
            }
        }
        expect(signals[0]?.aborted).toBe(true);
    });
});

describe('renderToStream - lifecycle and isolation', () =>
{
    it('root disposal is DEFERRED to stream completion', async () =>
    {
        const gate = deferred<string>();
        const disposed = vi.fn();
        const page = (): HTMLElement =>
        {
            onRootDispose(disposed);
            const a = createResource<string>(() => gate.promise);
            return Suspense({ fallback: () => h('i', {}, 'w'), on: [a], children: () => h('b', {}, () => a.data() ?? '') }) as unknown as HTMLElement;
        };
        const reader = renderToStream(page).getReader();
        await readOne(reader);
        expect(disposed).not.toHaveBeenCalled();
        gate.resolve('done');
        for (;;)
        {
            const { done } = await reader.read();
            if (done)
            {
                break;
            }
        }
        expect(disposed).toHaveBeenCalledOnce();
    });

    it('two interleaved streams keep independent boundary ids and close independently', async () =>
    {
        const gateOne = deferred<string>();
        const gateTwo = deferred<string>();
        const one = pendingPage(gateOne);
        const two = pendingPage(gateTwo);
        const readerOne = renderToStream(one.app).getReader();
        const readerTwo = renderToStream(two.app).getReader();

        const shellOne = await readOne(readerOne);
        const shellTwo = await readOne(readerTwo);
        expect(shellOne).toContain('azc:suspense:0');
        expect(shellTwo).toContain('azc:suspense:0');

        gateTwo.resolve('TWO');
        const chunkTwo = await readOne(readerTwo);
        expect(chunkTwo).toContain('TWO');
        expect(chunkTwo).not.toContain('ONE');

        gateOne.resolve('ONE');
        let restOne = '';
        for (;;)
        {
            const { done, value } = await readerOne.read();
            if (done)
            {
                break;
            }
            restOne += new TextDecoder().decode(value);
        }
        expect(restOne).toContain('ONE');
        expect(restOne).not.toContain('TWO');
    });

    it('seed data escapes the closing-script sequence like every other inline handoff', async () =>
    {
        const gate = deferred<string>();
        const { app } = pendingPage(gate);
        const reader = renderToStream(app).getReader();
        await readOne(reader);
        gate.resolve('</script><script>alert(1)</script>');
        let rest = '';
        for (;;)
        {
            const { done, value } = await reader.read();
            if (done)
            {
                break;
            }
            rest += new TextDecoder().decode(value);
        }
        expect(rest).not.toContain('</script><script>alert(1)');
        expect(rest).toContain('\\u003c/script');
    });
});
