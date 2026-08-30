// @vitest-environment node
//
// A streaming producer that fails AFTER the headers are sent cannot become a status, so without
// a dedicated seam it reaches nobody: the consumer gets a truncated body and the server records
// the 2xx it already sent. Over h2c that truncation is byte-identical to a clean end, so neither
// side can see it.
//
// `onStreamError` is deliberately separate from `onError`. That seam hands over a mapped
// HttpError carrying a status, and a committed stream has none left to map - routing through it
// would mean fabricating a response that never existed.
//
// This is reachable as a REAL-fault-only path because the cancel latch in deferCleanupsToBody
// returns before the pull's catch on a consumer cancel; the second arm below is what keeps that
// true, since a regression there would turn every disconnect into a reported server fault.
import { describe, expect, it } from 'vitest';

import { App } from '../src/app.ts';

interface Seen
{
    message: string;
    sameRequest: boolean;
}

function failingStreamApp(seen: Seen[]): App
{
    const app = new App({
        onStreamError: (error, request) => void seen.push({
            message: (error as Error).message,
            sameRequest: request instanceof Request && new URL(request.url).pathname === '/feed'
        })
    });
    app.get('/feed', () =>
    {
        let sent = false;
        return new Response(new ReadableStream<Uint8Array>({
            pull(controller)
            {
                if (sent)
                {
                    throw new Error('upstream died mid-stream');
                }
                sent = true;
                controller.enqueue(new TextEncoder().encode('first chunk;'));
            }
        }), { headers: { 'content-type': 'text/plain' } });
    });
    return app;
}

describe('a producer failure after the headers are sent', () =>
{
    it('reaches onStreamError with the failing request, and still errors the consumer', async () =>
    {
        const seen: Seen[] = [];
        const response = await failingStreamApp(seen).handle(new Request('http://local/feed'));
        expect(response.status).toBe(200);

        await expect(response.text()).rejects.toThrow('upstream died mid-stream');
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(seen).toEqual([{ message: 'upstream died mid-stream', sameRequest: true }]);
    });

    it('CONTROL: an ordinary consumer cancel reports NOTHING', async () =>
    {
        // The regression that would matter most: a disconnect wakes the pull, and before the
        // cancel latch that manufactured a TypeError into this very catch. If this arm ever
        // fails, every disconnected streaming client is being reported as a server fault.
        const seen: Seen[] = [];
        const app = new App({ onStreamError: (error) => void seen.push({ message: String(error), sameRequest: false }) });
        app.get('/live', () => new Response(new ReadableStream<Uint8Array>({
            pull(controller)
            {
                controller.enqueue(new TextEncoder().encode('x'));
                return new Promise<void>(() =>
                {
                    // Held open: only the consumer's cancel ends this.
                });
            }
        })));

        const response = await app.handle(new Request('http://local/live'));
        const reader = response.body!.getReader();
        await reader.read();
        await reader.cancel();
        await new Promise((resolve) => setTimeout(resolve, 60));

        expect(seen).toEqual([]);
    });

    it('a throwing reporter takes down neither the consumer\'s error nor the teardown', async () =>
    {
        // onCleanupError isolates its sink's failures; this one must too. Unguarded, the
        // consumer would receive the REPORTER's error instead of the producer's, and the
        // request's cleanups would never run.
        const app = new App({
            onStreamError: () =>
            {
                throw new Error('the reporter itself exploded');
            }
        });
        app.get('/feed', () =>
        {
            let sent = false;
            return new Response(new ReadableStream<Uint8Array>({
                pull(controller)
                {
                    if (sent)
                    {
                        throw new Error('upstream died mid-stream');
                    }
                    sent = true;
                    controller.enqueue(new TextEncoder().encode('first'));
                }
            }));
        });

        const response = await app.handle(new Request('http://local/feed'));
        // The PRODUCER's error, not the reporter's.
        await expect(response.text()).rejects.toThrow('upstream died mid-stream');
    });

    it('CONTROL: with no observer configured nothing changes', async () =>
    {
        const app = new App();
        app.get('/feed', () =>
        {
            let sent = false;
            return new Response(new ReadableStream<Uint8Array>({
                pull(controller)
                {
                    if (sent)
                    {
                        throw new Error('upstream died mid-stream');
                    }
                    sent = true;
                    controller.enqueue(new TextEncoder().encode('first'));
                }
            }));
        });
        const response = await app.handle(new Request('http://local/feed'));
        await expect(response.text()).rejects.toThrow('upstream died mid-stream');
    });
});
