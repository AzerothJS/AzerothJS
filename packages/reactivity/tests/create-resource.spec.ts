// @vitest-environment node
//
// Full behavioral coverage for createResource (create-resource.ts): the data/loading/
// error/refetch state machine, the standalone and source-driven forms, falsy-source
// skipping, and re-fetching. Uses real promises (no mocked async).
import { describe, it, expect, vi } from 'vitest';
import {
    createSignal,
    createResource,
    createRoot,
    type Resource
} from '@azerothjs/reactivity';

// Flush pending microtasks + a macrotask so the fetcher promise settles.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createResource - standalone', () =>
{
    it('starts loading, then resolves to data with no error', async () =>
    {
        let resource!: Resource<string>;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            resource = createResource(async () => 'value');
        });
        expect(resource.loading()).toBe(true);
        expect(resource.data()).toBeUndefined();

        await flush();

        expect(resource.loading()).toBe(false);
        expect(resource.data()).toBe('value');
        expect(resource.error()).toBeNull();
        dispose();
    });

    it('captures a rejected fetch in error() and clears loading', async () =>
    {
        let resource!: Resource<string>;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            resource = createResource(async () =>
            {
                throw new Error('fail');
            });
        });

        await flush();

        expect(resource.loading()).toBe(false);
        expect((resource.error() as Error).message).toBe('fail');
        expect(resource.data()).toBeUndefined();
        dispose();
    });

    it('a fetcher that throws SYNCHRONOUSLY surfaces the error and clears loading (not stuck true)', async () =>
    {
        let resource!: Resource<string>;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            // A non-async fetcher that throws BEFORE returning a promise. This must be handled exactly
            // like a rejection - regression for loading wedged at true forever.
            resource = createResource((): Promise<string> =>
            {
                throw new Error('sync-fail');
            });
        });
        expect(resource.loading()).toBe(true);

        await flush();

        expect(resource.loading()).toBe(false);
        expect((resource.error() as Error).message).toBe('sync-fail');
        expect(resource.data()).toBeUndefined();
        dispose();
    });

    it('refetch() re-runs the fetcher', async () =>
    {
        const calls: number[] = [];
        let resource!: Resource<string>;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            resource = createResource(async () =>
            {
                calls.push(1);
                return 'v';
            });
        });
        await flush();
        expect(calls).toEqual([1]);

        resource.refetch();
        expect(resource.loading()).toBe(true);
        await flush();
        expect(calls).toEqual([1, 1]);
        expect(resource.data()).toBe('v');
        dispose();
    });
});

describe('createResource - source-driven', () =>
{
    it('re-runs the fetcher when the source signal changes', async () =>
    {
        const calls: number[] = [];
        let resource!: Resource<string>;
        let setId!: (n: number) => void;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            const [id, set] = createSignal(1);
            setId = set;
            resource = createResource(id, async (key) =>
            {
                calls.push(key);
                return `user-${ key }`;
            });
        });

        await flush();
        expect(resource.data()).toBe('user-1');
        expect(calls).toEqual([1]);

        setId(2);
        expect(resource.loading()).toBe(true);
        await flush();
        expect(resource.data()).toBe('user-2');
        expect(calls).toEqual([1, 2]);
        dispose();
    });

    it('skips fetching while the source is falsy', async () =>
    {
        const calls: unknown[] = [];
        let resource!: Resource<string>;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            const [id] = createSignal<number | null>(null);
            resource = createResource(id, async (key) =>
            {
                calls.push(key);
                return 'x';
            });
        });

        await flush();
        expect(calls).toEqual([]);
        expect(resource.loading()).toBe(false);
        expect(resource.data()).toBeUndefined();
        dispose();
    });
});

describe('initialValue: the SSR/hydration adoption seam', () =>
{
    it('serves the seed synchronously with loading false and SKIPS the first fetch', async () =>
    {
        const fetcher = vi.fn(async () => 'fetched');
        let resource!: Resource<string>;
        createRoot(() =>
        {
            resource = createResource(() => 'key-1', fetcher, { initialValue: 'seeded' });
            // Synchronous availability - a server render reads this immediately.
            expect(resource.data()).toBe('seeded');
            expect(resource.loading()).toBe(false);
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(fetcher).not.toHaveBeenCalled(); // adoption, not a refetch
        expect(resource.data()).toBe('seeded');
    });

    it('a SOURCE CHANGE after adoption fetches normally', async () =>
    {
        const fetcher = vi.fn(async (key: string) => `fetched:${ key }`);
        let resource!: Resource<string>;
        let setKey!: (value: string) => void;
        createRoot(() =>
        {
            const [key, set] = createSignal('first');
            setKey = set;
            resource = createResource(key, fetcher, { initialValue: 'seeded' });
        });
        setKey('second');
        await vi.waitFor(() => expect(resource.data()).toBe('fetched:second'));
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher).toHaveBeenCalledWith('second', expect.anything());
    });

    it('refetch() after adoption performs a real fetch', async () =>
    {
        const fetcher = vi.fn(async () => 'fresh');
        let resource!: Resource<string>;
        createRoot(() =>
        {
            resource = createResource(() => 'k', fetcher, { initialValue: 'seeded' });
        });
        resource.refetch();
        await vi.waitFor(() => expect(resource.data()).toBe('fresh'));
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('a skip-key start discards the seed along with the data it resets', async () =>
    {
        const fetcher = vi.fn(async (key: string) => `fetched:${ key }`);
        let resource!: Resource<string>;
        let setKey!: (value: string | null) => void;
        createRoot(() =>
        {
            const [key, set] = createSignal<string | null>(null);
            setKey = set;
            resource = createResource(key, fetcher, { initialValue: 'seeded' });
            expect(resource.data()).toBeUndefined(); // the skip reset already ran
        });
        setKey('real');
        await vi.waitFor(() => expect(resource.data()).toBe('fetched:real'));
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('the standalone overload accepts options too', async () =>
    {
        const fetcher = vi.fn(async () => 'fetched');
        let resource!: Resource<string>;
        createRoot(() =>
        {
            resource = createResource(fetcher, { initialValue: 'seeded' });
        });
        await Promise.resolve();
        expect(resource.data()).toBe('seeded');
        expect(fetcher).not.toHaveBeenCalled();
    });
});
