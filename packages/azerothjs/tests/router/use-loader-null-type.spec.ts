// @vitest-environment happy-dom
//
// useLoader types loader data that admits undefined as possibly null, as a server render reads it.
// The type rows are checked by the repo type check; the runtime rows read the values they describe.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { createMemoryHistory, createRouter, defineRoute, h, matchAndLoad, renderToString, useLoader } from 'azerothjs';
import type { LoaderHandoff, MountNode, Resource, Route, Router } from 'azerothjs';

interface Item
{
    name: string;
}

// void under another name, since lint refuses the keyword in a union or a type argument.
type Nothing = ReturnType<() => void>;

const items: Item[] = [{ name: 'a' }];
const page = (): MountNode => h('p', {});
const findRoute = defineRoute('/f', { component: page, loader: async () => items.find((item) => item.name === 'z') });
const itemRoute = defineRoute('/i', { component: page, loader: async (): Promise<Item> => ({ name: 'a' }) });
// A loader run only for its effect, as a guard is, has void data, which admits undefined.
const voidRoute = defineRoute('/v', { component: page, loader: () => Promise.resolve() });
const maybeRoute = defineRoute('/m', { component: page, loader: async (): Promise<Item | Nothing> => undefined });

const readFind = (router: Router) => useLoader(findRoute, router);
const readItem = (router: Router) => useLoader(itemRoute, router);
type FindResource = ReturnType<typeof readFind>;
type ItemResource = ReturnType<typeof readItem>;

const readBare = (router: Router) => useLoader<Item | undefined>(router);
const readBareItem = (router: Router) => useLoader<Item>(router);
const readBareUnknown = (router: Router) => useLoader(router);
type BareResource = ReturnType<typeof readBare>;

const readVoid = (router: Router) => useLoader(voidRoute, router);
const readMaybe = (router: Router) => useLoader(maybeRoute, router);
const readBareVoid = (router: Router) => useLoader<Nothing>(router);
const readBareMaybe = (router: Router) => useLoader<Item | Nothing>(router);
type MaybeResource = ReturnType<typeof readMaybe>;
type BareMaybeResource = ReturnType<typeof readBareMaybe>;

/** Server-renders `route` from its handoff, the way a host does, and returns what `read` saw. */
async function serverRead<T>(route: Route, path: string, read: (router: Router) => T): Promise<T | undefined>
{
    const handoff = await matchAndLoad([route], path) as LoaderHandoff;
    let seen: T | undefined;
    renderToString(() =>
    {
        seen = read(createRouter({ routes: [route], history: createMemoryHistory(path), initialLoaderData: handoff }));
        return h('p', {});
    });
    return seen;
}

/** What a server-rendered page reads for a find() miss. */
const missed: FindResource = { data: () => null, loading: () => false, refreshing: () => false, error: () => null, refetch: async () => undefined };

function narrowedOnUndefined(loader: FindResource): string
{
    const found = loader.data();
    // @ts-expect-error - found can be null after the check, so the dereference is refused
    return found === undefined ? 'missing' : found.name;
}

function bareNarrowedOnUndefined(loader: BareResource): string
{
    const found = loader.data();
    // @ts-expect-error - found can be null after the check, so the dereference is refused
    return found === undefined ? 'missing' : found.name;
}

function maybeNarrowedOnUndefined(loader: MaybeResource): string
{
    const found = loader.data();
    // @ts-expect-error - found can be null after the check, so the dereference is refused
    return found === undefined ? 'missing' : found.name;
}

function bareMaybeNarrowedOnUndefined(loader: BareMaybeResource): string
{
    const found = loader.data();
    // @ts-expect-error - found can be null after the check, so the dereference is refused
    return found === undefined ? 'missing' : found.name;
}

function chained(loader: FindResource): string
{
    return loader.data()?.name ?? 'missing';
}

describe('useLoader(handle) for a loader whose data admits undefined', () =>
{
    it('types the data as possibly null', () =>
    {
        expectTypeOf<FindResource>().toEqualTypeOf<Resource<Item | null | undefined>>();
    });

    it('reads null in a server render of a find() miss', async () =>
    {
        expect(await serverRead(findRoute, '/f', (router) => readFind(router).data())).toBeNull();
    });

    it('refuses a dereference after a check for undefined, which throws on that null', () =>
    {
        expect(() => narrowedOnUndefined(missed)).toThrow(TypeError);
    });

    it('CONTROL: accepts data()?.name ?? fallback, which reads both', () =>
    {
        expect(chained(missed)).toBe('missing');
    });

    it('CONTROL: keeps Resource<Item> for a loader typed without undefined', async () =>
    {
        expectTypeOf<ItemResource>().toEqualTypeOf<Resource<Item>>();
        expect(await serverRead(itemRoute, '/i', (router) => readItem(router).data())).toEqual({ name: 'a' });
    });
});

describe('useLoader<T>() for a T that admits undefined', () =>
{
    it('types the data as possibly null', () =>
    {
        expectTypeOf<BareResource>().toEqualTypeOf<Resource<Item | null | undefined>>();
    });

    it('reads null in a server render of a find() miss', async () =>
    {
        expect(await serverRead(findRoute, '/f', (router) => readBare(router).data())).toBeNull();
    });

    it('refuses a dereference after a check for undefined, which throws on that null', () =>
    {
        expect(() => bareNarrowedOnUndefined(missed)).toThrow(TypeError);
    });

    it('CONTROL: keeps Resource<Item> for useLoader<Item>(), and Resource<unknown> untyped', async () =>
    {
        expectTypeOf<ReturnType<typeof readBareItem>>().toEqualTypeOf<Resource<Item>>();
        expectTypeOf<ReturnType<typeof readBareUnknown>>().toEqualTypeOf<Resource<unknown>>();
        expect(await serverRead(itemRoute, '/i', (router) => readBareItem(router).data())).toEqual({ name: 'a' });
        expect(await serverRead(itemRoute, '/i', (router) => readBareUnknown(router).data())).toEqual({ name: 'a' });
    });
});

describe('useLoader for void loader data, which admits undefined', () =>
{
    it('types the data as possibly null, through the handle and through useLoader<T>()', () =>
    {
        expectTypeOf<ReturnType<typeof readVoid>>().toEqualTypeOf<Resource<Nothing | null>>();
        expectTypeOf<MaybeResource>().toEqualTypeOf<Resource<Item | Nothing | null>>();
        expectTypeOf<ReturnType<typeof readBareVoid>>().toEqualTypeOf<Resource<Nothing | null>>();
        expectTypeOf<BareMaybeResource>().toEqualTypeOf<Resource<Item | Nothing | null>>();
    });

    it('reads null in a server render of a loader that resolves nothing', async () =>
    {
        expect(await serverRead(voidRoute, '/v', (router) => readVoid(router).data())).toBeNull();
        expect(await serverRead(maybeRoute, '/m', (router) => readMaybe(router).data())).toBeNull();
        expect(await serverRead(voidRoute, '/v', (router) => readBareVoid(router).data())).toBeNull();
        expect(await serverRead(maybeRoute, '/m', (router) => readBareMaybe(router).data())).toBeNull();
    });

    it('refuses a dereference after a check for undefined, which throws on that null', () =>
    {
        expect(() => maybeNarrowedOnUndefined(missed)).toThrow(TypeError);
        expect(() => bareMaybeNarrowedOnUndefined(missed)).toThrow(TypeError);
    });
});
