// @vitest-environment happy-dom
//
// THE INVARIANT: a loader's argument must be exactly the PREIMAGE of the key its entry is
// cached under. The client skips the fetch entirely when a navigation leaves the level key
// unchanged, so a value produced from inputs wider than its key gets served, unfetched, for
// every other URL sharing that key. Keying on the declared subset is what makes the key a
// complete description of the value - so the loader argument must be that same subset, on
// EVERY path that can produce the value. The server used to hand loaders the raw query while
// the client keyed on the declared one, which is the single incoherent combination.
//
// Guards are deliberately outside this: they key nothing, so both paths hand them the raw
// query, and the pin below exists so a later consistency pass does not "align" them and
// quietly change what authorization sees.
import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter, createRoot, matchAndLoad } from 'azerothjs';
import type { Route } from 'azerothjs';
import { object, string } from '@azerothjs/schema';

const leaf = (): HTMLElement => document.createElement('div');
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Seen
{
    loader: string | null;
    guard: string | null;
}

function routesFor(seen: Seen, declared: boolean): Route[]
{
    return [{
        path: '/list',
        component: leaf,
        ...(declared ? { search: object({ page: string() }) } : {}),
        guard: ({ query }) =>
        {
            seen.guard = JSON.stringify(query);
            return true;
        },
        loader: ({ query }) =>
        {
            seen.loader = JSON.stringify(query);
            return Promise.resolve('v');
        }
    }];
}

async function onServer(declared: boolean, url: string): Promise<Seen>
{
    const seen: Seen = { loader: null, guard: null };
    await matchAndLoad(routesFor(seen, declared), url);
    return seen;
}

async function onClient(declared: boolean, url: string): Promise<Seen>
{
    const seen: Seen = { loader: null, guard: null };
    let dispose!: () => void;
    createRoot((d) =>
    {
        dispose = d;
        createRouter({ routes: routesFor(seen, declared), history: createMemoryHistory(url) });
    });
    await flush();
    await flush();
    dispose();
    return seen;
}

describe('a loader receives the same query on both render paths', () =>
{
    it('strips an undeclared param on the SERVER exactly as the client does', async () =>
    {
        const server = await onServer(true, '/list?page=1&utm=junk');
        const client = await onClient(true, '/list?page=1&utm=junk');
        expect(server.loader).toBe('{"page":"1"}');
        expect(server.loader).toBe(client.loader);
    });

    it('CONTROL: a schema-less route still receives the WHOLE query on both paths', async () =>
    {
        // Without this a fix that over-strips - dropping every param everywhere - passes the
        // arm above while breaking every undeclared route in existence.
        const server = await onServer(false, '/list?page=1&utm=junk');
        const client = await onClient(false, '/list?page=1&utm=junk');
        expect(JSON.parse(server.loader ?? '{}')).toEqual({ page: '1', utm: 'junk' });
        expect(server.loader).toBe(client.loader);
    });

    it('degrades a query that FAILS its schema to {} on both paths', async () =>
    {
        // The branch the arm above cannot reach: parse failure, not parse success.
        const server = await onServer(true, '/list?page[]=oops&page[]=twice');
        const client = await onClient(true, '/list?page[]=oops&page[]=twice');
        expect(server.loader).toBe(client.loader);
    });
});

describe('guards keep the RAW query on both paths', () =>
{
    it('hands a guard the undeclared param, server and client alike', async () =>
    {
        // A guard keys nothing, so narrowing it would remove information an authorization
        // decision may legitimately use. Pinned so a later alignment pass cannot silently
        // change what guards see.
        const server = await onServer(true, '/list?page=1&utm=junk');
        const client = await onClient(true, '/list?page=1&utm=junk');
        expect(JSON.parse(server.guard ?? '{}')).toEqual({ page: '1', utm: 'junk' });
        expect(server.guard).toBe(client.guard);
    });
});
