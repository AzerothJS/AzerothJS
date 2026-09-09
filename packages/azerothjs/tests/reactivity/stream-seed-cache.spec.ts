// @vitest-environment happy-dom
//
// A streamed page seeds its resources through the seed store, with no options at all. With
// the data cache live, a failure seed must stay this instance's own and a value seed must be
// the one the entry takes.
import { afterEach, describe, expect, it } from 'vitest';
import { cached, createResource, h, hydrate } from 'azerothjs';
import { getDataCache, resetDataCache } from 'azerothjs/internal';

const flush = async (): Promise<void> =>
{
    for (let i = 0; i < 4; i++)
    {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

interface SeedGlobal { __AZS_S?: Record<string, { d?: unknown; e?: string }> }

// The hydrate-side ordinal keeps ticking across hydrations in one file, so every id this file
// can mint carries the seed.
function seedStore(seed: { d?: unknown; e?: string }): void
{
    const store: Record<string, { d?: unknown; e?: string }> = {};
    for (let i = 0; i < 40; i++)
    {
        store[`:${ i }`] = seed;
    }
    (globalThis as SeedGlobal).__AZS_S = store;
}

afterEach(() =>
{
    document.body.innerHTML = '';
    delete (globalThis as SeedGlobal).__AZS_S;
});

function hydrateWith<T>(fetcher: () => Promise<T>): ReturnType<typeof createResource<T>>
{
    document.body.innerHTML = '<div id="root"><p>x</p></div>';
    let resource: ReturnType<typeof createResource<T>> | null = null;
    hydrate(() =>
    {
        resource = createResource<T>(fetcher);
        return h('p', {}, 'x');
    }, document.getElementById('root') as HTMLElement);
    return resource as unknown as ReturnType<typeof createResource<T>>;
}

describe('a streamed seed with the data cache live', () =>
{
    it('a failure seed keeps its error, publishes nothing, and starts no fetch', async () =>
    {
        resetDataCache();
        expect(getDataCache()).not.toBeNull();
        seedStore({ e: 'server fault' });
        let fetches = 0;
        const family = cached('stream-seed.failure', async (): Promise<string> =>
        {
            fetches++;
            return 'fetched';
        });
        const resource = hydrateWith<string>(family);
        await flush();
        expect(resource.error()).toBeInstanceOf(Error);
        expect((resource.error() as Error).message).toBe('server fault');
        expect(resource.data()).toBeUndefined();
        expect(fetches).toBe(0);
        const entry = getDataCache()?.allEntries().find((candidate) => candidate.key.startsWith('stream-seed.failure'));
        expect(entry?.hasValue).toBe(false);
        expect(entry?.hasError).toBe(false);
    });

    it('a value seed is the value the entry takes, so a second reader fetches nothing', async () =>
    {
        resetDataCache();
        seedStore({ d: 'streamed-value' });
        let fetches = 0;
        const family = cached('stream-seed.value', async (): Promise<string> =>
        {
            fetches++;
            return 'fetched';
        });
        const first = hydrateWith<string>(family);
        await flush();
        expect(first.data()).toBe('streamed-value');
        const entry = getDataCache()?.allEntries().find((candidate) => candidate.key.startsWith('stream-seed.value'));
        expect(entry?.hasValue).toBe(true);
        expect(entry?.value).toBe('streamed-value');

        delete (globalThis as SeedGlobal).__AZS_S;
        const second = hydrateWith<string>(family);
        await flush();
        expect(second.data()).toBe('streamed-value');
        expect(fetches).toBe(0);
    });
});
