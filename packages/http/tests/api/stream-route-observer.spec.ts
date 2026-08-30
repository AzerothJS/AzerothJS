// @vitest-environment node
//
// A declared `routes.stream` producer that fails cannot become a status - the event-stream
// headers left with the 200 - so `sse()` reports it through its own `onError`. But `register`
// constructed every stream route WITHOUT one, so the failure fell back to sse()'s stderr notice
// and never reached the observer the app already had configured. This pins the routing.
//
// The drop of a slow client deliberately does NOT arrive here: that path errors the stream
// directly and is branded client-caused, which the kernel reporter skips. Its own control lives
// in stream-fault-observer.spec.ts.
import { describe, expect, it } from 'vitest';

import { App } from '../../src/app.ts';
import { feature } from '../../src/api/feature.ts';
import { register } from '../../src/api/register.ts';

interface Seen
{
    message: string;
    path: string;
}

function build(seen: Seen[], observe: boolean): App
{
    const app = observe
        ? new App({
            onStreamError: (error, request) => void seen.push({
                message: (error as Error).message,
                path: new URL(request.url).pathname
            })
        })
        : new App();

    register(app, {
        live: feature('/live', (routes) => ({
            events: routes.stream('/events', {}, async () =>
            {
                // A real producer fault, after the stream is open.
                await Promise.resolve();
                throw new Error('feed backend died');
            })
        }))
    });
    return app;
}

async function drain(app: App): Promise<void>
{
    const response = await app.handle(new Request('http://local/api/live/events'));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try
    {
        for (let i = 0; i < 5; i++)
        {
            const { done } = await reader.read();
            if (done)
            {
                break;
            }
        }
    }
    catch
    {
        // However the stream ends for the consumer is not what this arm is about.
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
}

describe('a declared stream route\'s producer failure', () =>
{
    it('reaches the app\'s stream observer with the request that failed', async () =>
    {
        const seen: Seen[] = [];
        await drain(build(seen, true));
        expect(seen).toEqual([{ message: 'feed backend died', path: '/api/live/events' }]);
    });

    it('CONTROL: with no observer configured the route still works and nothing throws', async () =>
    {
        const seen: Seen[] = [];
        await drain(build(seen, false));
        expect(seen).toEqual([]);
    });
});
