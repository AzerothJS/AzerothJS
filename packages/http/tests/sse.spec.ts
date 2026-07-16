// @vitest-environment node
//
// Server-Sent Events. The wire-format tests pin the framing (multi-line data, event/id
// fields, comments, [DONE]); the headline test closes the fullstack loop: the FRONTEND's
// createStream({ parse: 'sse' }) - the runtime under the .azeroth `stream` keyword -
// consumes this server's sse() through app.handle, in process. One event protocol, both
// sides, zero sockets. Disconnect semantics then run over a real socket via serve().

import { describe, it, expect, vi } from 'vitest';
import { createRoot, createStream } from '@azerothjs/reactivity';
import { App } from '../src/app.ts';
import { sse } from '../src/sse.ts';
import { text } from '../src/respond.ts';
import { compressResponse } from '../src/compress.ts';
import { serve } from '../src/adapter-node.ts';

async function bodyText(response: Response): Promise<string>
{
    return await response.text();
}

function request(headers: Record<string, string> = {}): Request
{
    return new Request('http://local/events', { headers });
}

describe('the wire format', () =>
{
    it('frames events, multi-line data, names, and ids per spec', async () =>
    {
        const response = sse(request(), (connection) =>
        {
            connection.send('hello');
            connection.send('line1\nline2');                       // one event, two data: lines
            connection.send({ n: 42 });                             // JSON payload
            connection.send('tagged', { event: 'update', id: '7' });
            connection.close();
        }, { heartbeatMs: 0 });

        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(response.headers.get('cache-control')).toContain('no-transform');

        const wire = await bodyText(response);
        expect(wire).toContain('data: hello\n\n');
        expect(wire).toContain('data: line1\ndata: line2\n\n');    // newline framed, not terminating
        expect(wire).toContain('data: {"n":42}\n\n');
        expect(wire).toContain('event: update\nid: 7\ndata: tagged\n\n');
        expect(wire.endsWith('data: [DONE]\n\n')).toBe(true);
    });

    it('doneMarker: false ends without the terminator; retryMs emits the prologue', async () =>
    {
        const response = sse(request(), (connection) => connection.close(),
            { heartbeatMs: 0, doneMarker: false, retryMs: 3000 });
        const wire = await bodyText(response);
        expect(wire).toContain('retry: 3000\n\n');
        expect(wire).not.toContain('[DONE]');
    });

    it('surfaces Last-Event-ID for resume', async () =>
    {
        let seen: string | null = null;
        const response = sse(request({ 'last-event-id': '41' }), (connection) =>
        {
            seen = connection.lastEventId;
            connection.close();
        }, { heartbeatMs: 0 });
        await bodyText(response);
        expect(seen).toBe('41');
    });

    it('heartbeats flow as comments on the configured interval', async () =>
    {
        const response = sse(request(), (connection) =>
        {
            setTimeout(() => connection.close(), 90);
        }, { heartbeatMs: 20 });
        const wire = await bodyText(response);
        expect((wire.match(/: hb\n\n/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });

    it('sends after close are silent no-ops; a throwing producer ends the stream', async () =>
    {
        const late = sse(request(), (connection) =>
        {
            connection.close();
            connection.send('after'); // must not throw, must not appear
        }, { heartbeatMs: 0 });
        expect(await bodyText(late)).not.toContain('after');

        const throwing = sse(request(), () =>
        {
            throw new Error('producer exploded');
        }, { heartbeatMs: 0 });
        const wire = await bodyText(throwing); // resolves - the stream ENDED instead of hanging
        expect(wire).toContain('[DONE]');
    });
});

describe('the fullstack loop: the stream keyword runtime consumes sse()', () =>
{
    it('createStream({ parse: "sse" }) accumulates this server\'s events and terminates on [DONE]', async () =>
    {
        const app = new App();
        app.get('/live', (req) => sse(req, async (connection) =>
        {
            connection.send('alpha');
            connection.comment('keepalive between events');
            connection.send('beta');
            connection.close();
        }, { heartbeatMs: 0 }));

        let partial!: () => string;
        let done!: () => boolean;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            const stream = createStream({
                fetcher: () => app.handle(new Request('http://local/live')),
                parse: 'sse'
            });
            partial = stream.partial;
            done = stream.done;
        });

        await vi.waitFor(() => expect(done()).toBe(true));
        expect(partial()).toBe('alphabeta'); // data accumulated, comments skipped, [DONE] consumed
        dispose();
    });
});

describe('disconnect over a real socket', () =>
{
    it('a vanishing client fires the connection signal and stops the producer', async () =>
    {
        const producerStopped = vi.fn();
        let sending: ReturnType<typeof setInterval>;

        const app = new App();
        app.get('/live', (req) => sse(req, (connection) =>
        {
            sending = setInterval(() => connection.send('tick'), 10);
            connection.signal.addEventListener('abort', () =>
            {
                clearInterval(sending);
                producerStopped();
            });
        }, { heartbeatMs: 0 }));

        const served = await serve(app);
        const base = `http://127.0.0.1:${ served.port }`;
        try
        {
            const client = new AbortController();
            const response = await fetch(`${ base }/live`, { signal: client.signal });
            const reader = response.body!.getReader();
            await reader.read(); // at least one tick arrived - the stream is live
            client.abort();
            await vi.waitFor(() => expect(producerStopped).toHaveBeenCalledTimes(1));
        }
        finally
        {
            await served.shutdown({ gracePeriodMs: 500 });
        }
    });
});

describe('compression stays away from event streams', () =>
{
    it('compressResponse passes text/event-stream through untouched', () =>
    {
        const stream = sse(request(), (connection) => connection.close(), { heartbeatMs: 0 });
        const gzipCapable = new Request('http://local/', { headers: { 'accept-encoding': 'gzip, br' } });
        expect(compressResponse(gzipCapable, stream)).toBe(stream);
        // Sanity: ordinary text WOULD compress under the same request (brotli wins the negotiation).
        expect(compressResponse(gzipCapable, text('x'.repeat(4096))).headers.get('content-encoding')).toBe('br');
    });
});
