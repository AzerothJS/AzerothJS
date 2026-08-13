// @vitest-environment node
//
// A declared `routes.stream` handler that rejects must end the stream and report the error.
//
// register.ts wrapped the handler as `(connection) => void handler(context, connection)`. The
// `void` discarded the promise, so sse()'s .catch() had nothing to attach to: an async handler
// that rejected ended NOTHING. The response body never terminated, no error hook fired, and
// heartbeats kept the dead connection alive while the rejection escaped as an unhandled
// rejection. A SYNCHRONOUS throw from the same handler was handled correctly, which is why this
// survived - the sync case is the natural thing to test.
//
// The oracle is whether the stream ENDS, not what it contains, and the sync-throw control runs
// the identical register.ts line so a harness that could never observe an end cannot pass.
import { describe, it, expect } from 'vitest';
import { App } from '@azerothjs/http';
import { feature, register } from '@azerothjs/http/api';

/** Reads a response body to completion or until the deadline, reporting whether it ended. */
async function drain(response: Response, ms = 1500): Promise<{ text: string; ended: boolean }>
{
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    let ended = false;
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, ms));
    const pump = (async (): Promise<void> =>
    {
        for (;;)
        {
            const { done, value } = await reader.read();
            if (done)
            {
                ended = true;
                return;
            }
            text += decoder.decode(value, { stream: true });
        }
    })();
    await Promise.race([pump, deadline]);
    void reader.cancel().catch(() => undefined);
    return { text, ended };
}

/** An app exposing one declared stream route whose handler is supplied per test. */
function serve(handler: (context: unknown, connection: { send(data: unknown): void }) => void | Promise<void>): App
{
    const app = new App();
    const api = {
        probe: feature('/probe', (routes) => ({
            events: routes.stream('/events', {}, handler as never)
        }))
    };
    register(app, api as never);
    return app;
}

describe('a declared stream handler that fails', () =>
{
    it('CONTROL: a synchronous throw ends the stream', async () =>
    {
        const app = serve((_context, connection) =>
        {
            connection.send('one');
            throw new Error('PROBE-SYNC-BOOM');
        });

        const response = await app.handle(new Request('http://local/api/probe/events'));
        const { ended } = await drain(response);

        expect(ended).toBe(true);
    });

    it('CONTROL: an async handler that SUCCEEDS keeps streaming and stays open', async () =>
    {
        // Deliberate contract, and the reason this test is a control rather than a mirror of the
        // failure case: sse() ends the stream only on rejection. A producer that returns normally
        // has merely finished its opening work - it may have handed the connection to an emitter -
        // so the connection stays open. This pins that the fix did not turn success into a close.
        const app = serve(async (_context, connection) =>
        {
            connection.send('one');
            await Promise.resolve();
            connection.send('two');
        });

        const response = await app.handle(new Request('http://local/api/probe/events'));
        const { text, ended } = await drain(response, 400);

        expect(text).toContain('one');
        expect(text).toContain('two');
        expect(ended).toBe(false);
    });

    it('an async REJECTION ends the stream instead of hanging forever', async () =>
    {
        // The case that used to leave the body open with no error anywhere.
        const app = serve(async (_context, connection) =>
        {
            connection.send('one');
            await Promise.resolve();
            throw new Error('PROBE-ASYNC-BOOM');
        });

        const response = await app.handle(new Request('http://local/api/probe/events'));
        const { text, ended } = await drain(response);

        expect(text).toContain('one');
        expect(ended).toBe(true);
    });

    it('a rejection BEFORE the first await also ends the stream', async () =>
    {
        // An async function that throws before awaiting still returns a rejected promise, so it
        // took the same dropped path despite looking synchronous.
        const app = serve(async (_context, connection) =>
        {
            connection.send('one');
            throw new Error('PROBE-PREAWAIT-BOOM');
        });

        const response = await app.handle(new Request('http://local/api/probe/events'));
        const { ended } = await drain(response);

        expect(ended).toBe(true);
    });
});
