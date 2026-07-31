// @vitest-environment happy-dom
//
// The SSE WIRE COMPATIBILITY weld. The server framer (@azerothjs/http's sse()) and the client
// parser (azerothjs' createStream({ parse: 'sse' })) each hardcode the grammar - `data:` lines,
// `:` comments, the [DONE] terminator - because sharing a constant would invert the dependency
// graph for bytes. This spec is the pin instead: the framer's output, consumed by the parser,
// end to end through both PUBLIC surfaces with `fetch` swapped for app.handle. If either side
// drifts, it fails HERE, not in a user's browser.
import { describe, it, expect } from 'vitest';
import { createRoot, createStream } from 'azerothjs';
import { App } from '../src/app.ts';
import { sse } from '../src/sse.ts';

function streamed(app: App, path: string): Promise<string>
{
    return new Promise((resolve, reject) =>
    {
        createRoot((dispose) =>
        {
            const reply = createStream((signal) => app.handle(new Request(`http://local${ path }`, { signal })), { parse: 'sse' });
            const poll = setInterval(() =>
            {
                if (reply.error() !== null)
                {
                    clearInterval(poll);
                    dispose();
                    reject(new Error(String(reply.error())));
                    return;
                }
                if (reply.done() && reply.partial() !== '')
                {
                    clearInterval(poll);
                    const text = reply.partial();
                    dispose();
                    resolve(text);
                }
            }, 5);
        });
    });
}

describe('sse() output through createStream({ parse: "sse" })', () =>
{
    it('events, comments, and the [DONE] terminator round-trip', async () =>
    {
        const app = new App();
        app.get('/tokens', (context) => sse(context.request, (connection) =>
        {
            connection.send('Hello ');
            connection.comment('keep-alive');   // invisible to the parser, by grammar
            connection.send('world');
            connection.close();                 // emits data: [DONE]
        }, { heartbeatMs: 0 }));

        const text = await streamed(app, '/tokens');
        expect(text).toBe('Hello world');
    });

    it('a multi-line payload survives framing and unframing byte-exact', async () =>
    {
        const app = new App();
        app.get('/multi', (context) => sse(context.request, (connection) =>
        {
            connection.send('line one\nline two');
            connection.close();
        }, { heartbeatMs: 0 }));

        const text = await streamed(app, '/multi');
        expect(text).toBe('line one\nline two');
    });
});
