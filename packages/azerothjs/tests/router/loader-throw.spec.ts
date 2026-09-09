// A loader has two ways to fail - return a rejected promise, or throw before returning - and
// they are one failure. `matchAndLoad` used to call the loader inside a non-async `.map`
// callback feeding `Promise.allSettled`, so the throwing spelling escaped the settle and left
// the renderer as an ordinary throw: a bare kernel 500 with no freshness headers, no error UI,
// a thrown sentinel answered as a fault, and every level below it never invoked. Each arm here
// drives the SAME failing value in both spellings and asserts one outcome.
import { describe, expect, it, vi } from 'vitest';
import { loaderFailures } from 'azerothjs/internal';
import { matchAndLoad, notFound, redirect, type LoaderHandoff, type Route } from 'azerothjs';

const leaf = (): HTMLElement => document.createElement('div');

type Loader = NonNullable<Route['loader']>;

/** One failing value, spelled as a synchronous throw and as a rejection. */
function spellings(fail: () => never): { thrown: Loader; rejected: Loader }
{
    return {
        thrown: () => fail(),
        rejected: async () =>
        {
            fail();
        }
    };
}

const single = (loader: Loader): Route[] => [{ path: '/item/:id', component: leaf, loader }];

async function both(fail: () => never): Promise<[unknown, unknown]>
{
    const { thrown, rejected } = spellings(fail);
    return [await matchAndLoad(single(thrown), '/item/42'), await matchAndLoad(single(rejected), '/item/42')];
}

describe('a loader that throws synchronously is judged like one that rejects', () =>
{
    it('a plain error: the level fails, the reason reaches the server and never the wire', async () =>
    {
        const [thrown, rejected] = await both(() =>
        {
            throw new Error('database is down');
        }) as [LoaderHandoff, LoaderHandoff];
        expect(thrown.failed).toEqual([0]);
        expect(thrown.missing).toBeUndefined();
        expect(loaderFailures(thrown)).toEqual([expect.objectContaining({ message: 'database is down' })]);
        expect(JSON.stringify(thrown)).not.toContain('database is down');
        expect(thrown).toEqual(rejected);
    });

    it('notFound(): the level is missing, not failed', async () =>
    {
        const [thrown, rejected] = await both(() =>
        {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- a not-found sentinel is a branded value, not an Error: throwing it IS the documented API
            throw notFound();
        }) as [LoaderHandoff, LoaderHandoff];
        expect(thrown.missing).toEqual([0]);
        expect(thrown.failed).toBeUndefined();
        expect(loaderFailures(thrown)).toEqual([]);
        expect(thrown).toEqual(rejected);
    });

    it('an on-origin redirect() ends the navigation with a real redirect', async () =>
    {
        const [thrown, rejected] = await both(() =>
        {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- a redirect sentinel is a branded value, not an Error: throwing it IS the documented API
            throw redirect('/login');
        });
        expect(thrown).toEqual({ redirect: '/login', replace: true });
        expect(thrown).toEqual(rejected);
    });

    it('an off-origin redirect() is refused, not answered as a fault', async () =>
    {
        const [thrown, rejected] = await both(() =>
        {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- a redirect sentinel is a branded value, not an Error: throwing it IS the documented API
            throw redirect('https://evil.example/x');
        });
        expect(thrown).toMatchObject({ refusedRedirect: true });
        expect(thrown).toEqual(rejected);
    });

    it('a thrown primitive is recorded as the reason, like any other value', async () =>
    {
        const [thrown, rejected] = await both(() =>
        {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- the arm is about a loader that throws a non-Error
            throw 'nope';
        }) as [LoaderHandoff, LoaderHandoff];
        expect(thrown.failed).toEqual([0]);
        expect(loaderFailures(thrown)).toEqual(['nope']);
        expect(thrown).toEqual(rejected);
    });

    it('a non-callable loader fails its level instead of failing the request', async () =>
    {
        const outcome = await matchAndLoad(single('not a function' as unknown as Loader), '/item/42') as LoaderHandoff;
        expect(outcome.failed).toEqual([0]);
        expect(loaderFailures(outcome)).toEqual([expect.any(TypeError)]);
    });

    it('every level below a throwing root still runs, and a child that awaits its parent inherits the rejection', async () =>
    {
        const root = new Error('root is down');
        const chain = async (rootLoader: Loader): Promise<{ outcome: LoaderHandoff; middle: number; leaf: number }> =>
        {
            // The middle level's `parent` is the root's own promise; the leaf's is the middle's.
            const middle = vi.fn(async ({ parent }: { parent: Promise<unknown> }) =>
            {
                await parent;
                return 'MIDDLE';
            });
            const leafLoader = vi.fn(async () => 'LEAF');
            const routes: Route[] = [{
                path: '/shop',
                component: leaf,
                loader: rootLoader,
                children: [{
                    path: 'section',
                    component: leaf,
                    loader: middle,
                    children: [{ path: 'item/:id', component: leaf, loader: leafLoader }]
                }]
            }];
            const outcome = await matchAndLoad(routes, '/shop/section/item/42') as LoaderHandoff;
            return { outcome, middle: middle.mock.calls.length, leaf: leafLoader.mock.calls.length };
        };
        const { thrown, rejected } = spellings(() =>
        {
            throw root;
        });
        const sync = await chain(thrown);
        const async = await chain(rejected);

        // With the bare call the root's throw aborted the whole map: nothing below it ever ran.
        expect(sync.middle).toBe(1);
        expect(sync.leaf).toBe(1);
        expect(sync.outcome.data).toEqual([undefined, undefined, 'LEAF']);
        expect(sync.outcome.failed).toEqual([0, 1]);
        // The middle's `parent` slot is the root's own promise, so its rejection IS the root's error.
        expect(loaderFailures(sync.outcome)).toEqual([root, root]);
        expect(sync).toEqual(async);
    });
});
