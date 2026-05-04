import { describe, it, expect, vi } from 'vitest';
import { createRoot, createSignal, createResource } from '@azerothjs/core';

// ── Test helpers ─────────────────────────────────────────────

/**
 * Build a manually-controlled deferred — a promise plus its
 * resolve/reject handles. Lets tests step through fetch timing
 * precisely instead of racing real microtasks.
 */
function makeDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (err: unknown) => void;
    }
{
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) =>
    {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/**
 * Drains the microtask queue several times. createResource's
 * promise chain is two `.then` handlers deep (the user's promise
 * + our internal handler), so 4 awaits is plenty of slack.
 */
async function flush(): Promise<void>
{
    for (let i = 0; i < 4; i++) await Promise.resolve();
}

// ─────────────────────────────────────────────────────────────

describe('createResource — standalone form', () =>
{
    it('runs the fetcher once, populates data, flips loading false', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const fetcher = vi.fn(async () => 'hello');
            const r = createResource(fetcher);

            expect(r.loading()).toBe(true);
            expect(r.data()).toBeUndefined();
            expect(r.error()).toBeNull();

            await flush();

            expect(r.data()).toBe('hello');
            expect(r.loading()).toBe(false);
            expect(r.error()).toBeNull();
            expect(fetcher).toHaveBeenCalledOnce();

            dispose();
        });
    });

    it('populates error when the fetcher rejects', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const failure = new Error('boom');
            const r = createResource(async () =>
            {
                throw failure;
            });

            await flush();

            expect(r.error()).toBe(failure);
            expect(r.loading()).toBe(false);
            expect(r.data()).toBeUndefined();

            dispose();
        });
    });

    it('reports loading = true synchronously, before the promise resolves', () =>
    {
        createRoot((dispose) =>
        {
            const r = createResource(() => makeDeferred<string>().promise);
            // No await — the very next read should see loading.
            expect(r.loading()).toBe(true);
            expect(r.data()).toBeUndefined();

            dispose();
        });
    });
});

describe('createResource — source form', () =>
{
    it('re-runs the fetcher when the source signal changes', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const fetcher = vi.fn(async (id: number) => `value-${ id }`);
            const [id, setId] = createSignal(1);

            const r = createResource(() => id(), fetcher);

            await flush();
            expect(r.data()).toBe('value-1');
            expect(fetcher).toHaveBeenCalledTimes(1);

            setId(2);
            await flush();
            expect(r.data()).toBe('value-2');
            expect(fetcher).toHaveBeenCalledTimes(2);

            dispose();
        });
    });

    it('skips the fetcher when source returns null / undefined / false', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const fetcher = vi.fn(async () => 'should not appear');
            const [src, setSrc] = createSignal<number | null | undefined | false>(null);

            const r = createResource(() => src(), fetcher);

            // null start — no fetch.
            expect(fetcher).not.toHaveBeenCalled();
            expect(r.loading()).toBe(false);

            setSrc(undefined);
            await flush();
            expect(fetcher).not.toHaveBeenCalled();

            setSrc(false);
            await flush();
            expect(fetcher).not.toHaveBeenCalled();

            // Truthy now — fetch fires.
            setSrc(7);
            await flush();
            expect(fetcher).toHaveBeenCalledOnce();
            expect(r.data()).toBe('should not appear');

            // Back to falsy — data resets, no new fetch.
            setSrc(null);
            await flush();
            expect(fetcher).toHaveBeenCalledOnce();
            expect(r.data()).toBeUndefined();
            expect(r.loading()).toBe(false);

            dispose();
        });
    });

    it('does NOT skip when source is 0 or empty string (those are valid keys)', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const fetcher = vi.fn(async (key: number | string) => `ok:${ key }`);
            const [src, setSrc] = createSignal<number | string>(0);

            createResource(() => src(), fetcher);

            await flush();
            expect(fetcher).toHaveBeenCalledOnce();
            expect(fetcher).toHaveBeenCalledWith(0, expect.any(AbortSignal));

            setSrc('');
            await flush();
            expect(fetcher).toHaveBeenCalledTimes(2);
            expect(fetcher).toHaveBeenLastCalledWith('', expect.any(AbortSignal));

            dispose();
        });
    });
});

describe('createResource — cancellation & race-condition guards', () =>
{
    it('aborts the previous controller when the source changes', () =>
    {
        createRoot((dispose) =>
        {
            const signals: AbortSignal[] = [];
            const fetcher = vi.fn((_id: number, signal: AbortSignal) =>
            {
                signals.push(signal);
                return new Promise<string>(() =>
                {});
            });

            const [id, setId] = createSignal(1);
            createResource(() => id(), fetcher);

            expect(signals[0].aborted).toBe(false);

            setId(2);
            expect(signals[0].aborted).toBe(true);
            expect(signals[1].aborted).toBe(false);

            setId(3);
            expect(signals[1].aborted).toBe(true);
            expect(signals[2].aborted).toBe(false);

            dispose();
        });
    });

    it('drops a superseded fetch that resolves AFTER a newer one', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const deferreds: Array<ReturnType<typeof makeDeferred<string>>> = [];
            const fetcher = vi.fn((_id: number) =>
            {
                const d = makeDeferred<string>();
                deferreds.push(d);
                return d.promise;
            });

            const [id, setId] = createSignal(1);
            const r = createResource(() => id(), fetcher);

            setId(2);

            // Resolve the NEWER fetch first.
            deferreds[1].resolve('value-2');
            await flush();
            expect(r.data()).toBe('value-2');

            // The older (aborted) fetch resolves late. Its result
            // must NOT clobber the newer data.
            deferreds[0].resolve('value-1');
            await flush();
            expect(r.data()).toBe('value-2');

            dispose();
        });
    });

    it('does NOT report an abort-triggered rejection in error()', async () =>
    {
        await createRoot(async (dispose) =>
        {
            // Fetcher rejects when its signal aborts — typical of a
            // real `fetch()` cancelled mid-flight.
            const fetcher = vi.fn((_id: number, signal: AbortSignal) =>
                new Promise<string>((_, reject) =>
                {
                    signal.addEventListener('abort', () =>
                    {
                        reject(new Error('aborted'));
                    });
                })
            );

            const [id, setId] = createSignal(1);
            const r = createResource(() => id(), fetcher);

            setId(2);

            // The abort triggers the inner reject for fetch #1.
            await flush();

            // error() should still be null — the abort error must
            // be swallowed because the result was superseded.
            expect(r.error()).toBeNull();

            dispose();
        });
    });
});

describe('createResource — refetch & cleanup', () =>
{
    it('refetch() re-runs the fetcher with the current source value', async () =>
    {
        await createRoot(async (dispose) =>
        {
            let n = 0;
            const fetcher = vi.fn(async (id: number) =>
            {
                n++;
                return `${ id }-attempt-${ n }`;
            });

            const r = createResource(() => 7, fetcher);

            await flush();
            expect(r.data()).toBe('7-attempt-1');
            expect(fetcher).toHaveBeenCalledTimes(1);

            r.refetch();
            await flush();
            expect(r.data()).toBe('7-attempt-2');
            expect(fetcher).toHaveBeenCalledTimes(2);

            dispose();
        });
    });

    it('aborts the in-flight fetch when the surrounding root is disposed', () =>
    {
        let captured!: AbortSignal;
        const fetcher = vi.fn((signal: AbortSignal) =>
        {
            captured = signal;
            return new Promise<string>(() =>
            {});
        });

        createRoot((dispose) =>
        {
            createResource(fetcher);
            expect(captured.aborted).toBe(false);

            dispose();

            expect(captured.aborted).toBe(true);
        });
    });
});
