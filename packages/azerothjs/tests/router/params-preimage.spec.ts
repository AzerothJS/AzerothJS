// @vitest-environment happy-dom
//
// The PARAMS half of the loader-input invariant: a level's cache key must never be coarser
// than the argument its loader receives. A layout is keyed on the params at or above its own
// level, so handing it a DESCENDANT's param pinned its value to the first descendant it ever
// saw and kept serving that value under every sibling URL - permanently, because a navigation
// that leaves the key unchanged starts no fetch at all.
//
// THIS FILE MUST NOT IMPORT matchAndLoad. A server entry point latches server-data mode and
// getDataCache() then returns null, which disables the very no-fetch path the disclosure
// lives on - a probe that latches first shows two loader runs and no bug. The SSR parity arm
// lives in its own file for that reason.
import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter, createRoot } from 'azerothjs';
import type { Route, Router } from 'azerothjs';

const leaf = (): HTMLElement => document.createElement('div');
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function withRouter(routes: Route[], url: string, fn: (router: Router) => Promise<void>): Promise<void>
{
    let dispose!: () => void;
    let router!: Router;
    createRoot((d) =>
    {
        dispose = d;
        router = createRouter({ routes, history: createMemoryHistory(url) });
    });
    try
    {
        await fn(router);
    }
    finally
    {
        dispose();
    }
}

describe('a layout loader cannot observe a descendant param', () =>
{
    it('never receives it, so it cannot serve one document under another URL', async () =>
    {
        const seen: string[] = [];
        const routes: Route[] = [{
            path: '/w/:workspaceId',
            component: leaf,
            loader: ({ params }) =>
            {
                seen.push(JSON.stringify(params));
                return Promise.resolve(`title-of-${ String((params as Record<string, string | undefined>).docId) }`);
            },
            children: [{ path: 'doc/:docId', component: leaf }]
        }];

        await withRouter(routes, '/w/1/doc/SECRET-A', async (router) =>
        {
            await flush();
            router.navigate('/w/1/doc/PUBLIC-B');
            await flush();
            // The argument carries the workspace and nothing below it.
            expect(seen).toEqual(['{"workspaceId":"1"}']);
            // And therefore the value cannot be SECRET-A's, at either URL.
            expect(String(router.loaders[0]!.data())).not.toContain('SECRET-A');
        });
    });

    it('CONTROL: the blast-radius property is preserved - a leaf param change does not re-run the layout', async () =>
    {
        // The alternative fix (widening the KEY to the whole chain) would pass the arm above
        // while destroying this. Both must hold.
        let runs = 0;
        const routes: Route[] = [{
            path: '/w/:workspaceId',
            component: leaf,
            loader: () =>
            {
                runs += 1;
                return Promise.resolve('layout');
            },
            children: [{ path: 'doc/:docId', component: leaf }]
        }];
        await withRouter(routes, '/w/1/doc/A', async (router) =>
        {
            await flush();
            expect(runs).toBe(1);
            router.navigate('/w/1/doc/B');
            await flush();
            expect(runs).toBe(1);
            expect(router.loaders[0]!.data()).toBe('layout');
        });
    });

    it('CONTROL: a LEAF still receives its ancestors\' params', async () =>
    {
        // The likeliest wrong implementation is slicing to own-path-only, which would pass
        // the disclosure arm and break every nested loader in existence.
        let seen = '';
        const routes: Route[] = [{
            path: '/w/:workspaceId',
            component: leaf,
            children: [{
                path: 'doc/:docId',
                component: leaf,
                loader: ({ params }) =>
                {
                    seen = JSON.stringify(params);
                    return Promise.resolve('leaf');
                }
            }]
        }];
        await withRouter(routes, '/w/1/doc/A', async () =>
        {
            await flush();
            expect(JSON.parse(seen)).toEqual({ workspaceId: '1', docId: 'A' });
        });
    });

    it('CONTROL: a MIDDLE level sees its own and its grandparent\'s, not the leaf\'s', async () =>
    {
        // Catches an off-by-one in the prefix bound, which the two-level cases cannot.
        let seen = '';
        const routes: Route[] = [{
            path: '/a/:aId',
            component: leaf,
            children: [{
                path: 'b/:bId',
                component: leaf,
                loader: ({ params }) =>
                {
                    seen = JSON.stringify(params);
                    return Promise.resolve('middle');
                },
                children: [{ path: 'c/:cId', component: leaf }]
            }]
        }];
        await withRouter(routes, '/a/1/b/2/c/3', async () =>
        {
            await flush();
            expect(JSON.parse(seen)).toEqual({ aId: '1', bId: '2' });
        });
    });

    it('keeps a wildcard the level itself binds', async () =>
    {
        // paramNamesOf includes wildcards, so a slice built by scanning for ':' alone
        // would silently drop them.
        let seen = '';
        const routes: Route[] = [{
            path: '/files/*rest',
            component: leaf,
            loader: ({ params }) =>
            {
                seen = JSON.stringify(params);
                return Promise.resolve('files');
            }
        }];
        await withRouter(routes, '/files/deep/path.txt', async () =>
        {
            await flush();
            expect(JSON.parse(seen)).toHaveProperty('rest');
        });
    });

    it('hands GUARDS the whole chain, which key nothing', async () =>
    {
        // Pinned so a later consistency pass cannot narrow authorization inputs too.
        let guardParams = '';
        const routes: Route[] = [{
            path: '/w/:workspaceId',
            component: leaf,
            guard: ({ params }) =>
            {
                guardParams = JSON.stringify(params);
                return true;
            },
            children: [{ path: 'doc/:docId', component: leaf }]
        }];
        await withRouter(routes, '/w/1/doc/A', async () =>
        {
            await flush();
            expect(JSON.parse(guardParams)).toEqual({ workspaceId: '1', docId: 'A' });
        });
    });

    it('re-runs a layout loader on revalidate() with its OWN params, not a smuggled descendant', async () =>
    {
        let runs = 0;
        const seen: string[] = [];
        const routes: Route[] = [{
            path: '/w/:workspaceId',
            component: leaf,
            loader: ({ params }) =>
            {
                runs += 1;
                seen.push(JSON.stringify(params));
                return Promise.resolve('layout');
            },
            children: [{ path: 'doc/:docId', component: leaf }]
        }];
        await withRouter(routes, '/w/1/doc/A', async (router) =>
        {
            await flush();
            router.navigate('/w/1/doc/B');
            await flush();
            await router.revalidate();
            await flush();
            expect(runs).toBe(2);
            expect(seen.every((entry) => !entry.includes('doc'))).toBe(true);
        });
    });
});
