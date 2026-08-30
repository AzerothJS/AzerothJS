// @vitest-environment happy-dom
//
// The SERVER half of the params invariant, kept in its own file on purpose: matchAndLoad
// latches server-data mode, after which getDataCache() returns null and the client's
// no-fetch path is disabled. A disclosure arm sharing a module with it would show two loader
// runs and no bug - a control that cannot fail. Here the latch is deliberate and
// resetDataCache() restores the client's world between the two halves.
//
// The seed arm is the one that matters most: SSR is the only production caller, its value is
// adopted WITHOUT fetching, and the client then never runs its loader - so narrowing only the
// client would have left the disclosure fully intact on the path that actually renders.
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter, createRoot, matchAndLoad } from 'azerothjs';
import type { LoaderHandoff, Route, Router } from 'azerothjs';
import { resetDataCache } from 'azerothjs/internal';

const leaf = (): HTMLElement => document.createElement('div');
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() =>
{
    resetDataCache();
});

function routesRecording(seen: string[]): Route[]
{
    return [{
        path: '/w/:workspaceId',
        component: leaf,
        loader: ({ params }) =>
        {
            seen.push(JSON.stringify(params));
            return Promise.resolve(`title-of-${ String((params as Record<string, string | undefined>).docId) }`);
        },
        children: [{ path: 'doc/:docId', component: leaf }]
    }];
}

describe('the server builds the same loader inputs as the client', () =>
{
    it('gives a layout loader the params at or above its level, not the whole chain', async () =>
    {
        const seen: string[] = [];
        await matchAndLoad(routesRecording(seen), '/w/1/doc/SECRET-A');
        expect(seen).toEqual(['{"workspaceId":"1"}']);
    });

    it('an adopted SSR seed cannot carry a descendant param into a sibling URL', async () =>
    {
        const serverSeen: string[] = [];
        const handoff = await matchAndLoad(routesRecording(serverSeen), '/w/1/doc/SECRET-A');
        expect(handoff).not.toBeNull();
        // The client's world again: the latch above would otherwise disable the very
        // no-fetch path this arm exercises.
        resetDataCache();

        const clientSeen: string[] = [];
        let dispose!: () => void;
        let router!: Router;
        createRoot((d) =>
        {
            dispose = d;
            router = createRouter({
                routes: routesRecording(clientSeen),
                history: createMemoryHistory('/w/1/doc/SECRET-A'),
                initialLoaderData: handoff as LoaderHandoff
            });
        });
        try
        {
            await flush();
            // The seed is adopted with no fetch - so whatever the SERVER put in it is what
            // gets served here and at every sibling URL sharing this key.
            router.navigate('/w/1/doc/PUBLIC-B');
            await flush();
            expect(String(router.loaders[0]!.data())).not.toContain('SECRET-A');
        }
        finally
        {
            dispose();
        }
    });
});
