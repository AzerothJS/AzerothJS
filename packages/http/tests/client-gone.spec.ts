// @vitest-environment node
//
// A client hanging up is not a server fault - but it is also not nothing.
//
// A handler that honours `request.signal` REJECTS when the client disconnects, and that
// rejection maps to a 500 like any other, so an abandoned navigation is indistinguishable from
// a server error at the observability seams. The kernel now reports the FACT (`clientGone`)
// rather than acting on it: nothing is suppressed, no status changes, and `logRequests`
// de-escalates a 5xx whose client had already gone.
//
// The deliberate non-suppression is the load-bearing part, and the last arm pins it. "Aborted"
// does not prove the abort CAUSED the error: a handler's own timeout controller, a mutating
// call handed `request.signal`, and a graceful-shutdown drain all raise AbortError on an
// aborted request while being real faults worth seeing. So the report still fires.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { App } from '../src/app.ts';
import { HttpError, type ErrorContext } from '../src/errors.ts';

function abortedRequest(url = 'http://local/x'): Request
{
    const controller = new AbortController();
    const request = new Request(url, { signal: controller.signal });
    controller.abort();
    return request;
}

describe('the error seam reports whether the client was already gone', () =>
{
    it('flags clientGone when the request was abandoned', async () =>
    {
        const seen: Array<ErrorContext | undefined> = [];
        const app = new App({ onError: (_error, _mapped, context) => void seen.push(context) });
        app.get('/x', () =>
        {
            throw new HttpError(500, 'upstream exploded');
        });

        const response = await app.handle(abortedRequest());
        expect(response.status).toBe(500);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.clientGone).toBe(true);
    });

    it('CONTROL: a live client\'s failure is not flagged', async () =>
    {
        const seen: Array<ErrorContext | undefined> = [];
        const app = new App({ onError: (_error, _mapped, context) => void seen.push(context) });
        app.get('/x', () =>
        {
            throw new HttpError(500, 'upstream exploded');
        });

        const response = await app.handle(new Request('http://local/x'));
        expect(response.status).toBe(500);
        expect(seen[0]?.clientGone).toBe(false);
    });

    it('STILL REPORTS an abort-shaped failure - the flag classifies, it does not silence', async () =>
    {
        // The case the design refused to suppress: this could equally be a handler's own
        // timeout, or a half-applied write that took the request signal.
        const seen: unknown[] = [];
        const app = new App({ onError: (error) => void seen.push((error as { name?: string }).name) });
        app.get('/x', () =>
        {
            throw new DOMException('The operation was aborted.', 'AbortError');
        });

        const response = await app.handle(abortedRequest());
        expect(response.status).toBe(500);
        // Reported, not swallowed.
        expect(seen).toEqual(['AbortError']);
    });

    it('the status contract is unchanged - no new code reaches the wire', async () =>
    {
        const app = new App();
        app.get('/x', () =>
        {
            throw new HttpError(503, 'nope');
        });
        expect((await app.handle(abortedRequest())).status).toBe(503);
    });
});

describe('a handler that abandons an upload it started reading', () =>
{
    // The mirror of a cancelled download, and the crossing that was missed when the download
    // side was fixed: a request body is a Node stream turned into a web stream too. Node's own
    // adapter keeps its `data` listener attached after a cancel and enqueues onto a controller
    // it has already closed, which throws inside the emitter where no framework catch can reach
    // it - so the process dies rather than the request failing.
    //
    // The trigger is ordinary handler code: issue a read, decide the upload is unwanted, and
    // cancel in the SAME turn while the client is still sending. A size guard, a content sniff
    // and a deadline all have this shape. Awaiting the read first does NOT reproduce it, which
    // is why a weaker probe reports a false all-clear.
    it('cannot kill the process', async () =>
    {
        const here = path.dirname(fileURLToPath(import.meta.url));
        const appUrl = pathToFileURL(path.join(here, '..', 'src', 'app.ts')).href;
        const nodeUrl = pathToFileURL(path.join(here, '..', 'src', 'node.ts')).href;
        const source = `
import { connect } from 'node:net';
import { App } from ${ JSON.stringify(appUrl) };
import { serve } from ${ JSON.stringify(nodeUrl) };

const app = new App({ onError: () => undefined });
app.post('/sniff', async (context) =>
{
    const reader = context.request.body.getReader();
    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pending = reader.read();
    await reader.cancel(new Error('rejected by sniff'));
    void pending.catch(() => undefined);
    return new Response('rejected', { status: 413 });
});
const served = await serve(app, { port: 0, banner: false });

const socket = connect(served.port, '127.0.0.1', () =>
{
    socket.write('POST /sniff HTTP/1.1\\r\\nHost: x\\r\\nContent-Length: 33554432\\r\\nConnection: close\\r\\n\\r\\n');
    const chunk = Buffer.alloc(65536, 3);
    let sent = 0;
    const pump = () =>
    {
        while (sent < 33554432)
        {
            sent += chunk.length;
            if (!socket.write(chunk)) { socket.once('drain', pump); return; }
        }
    };
    pump();
});
socket.on('error', () => undefined);
socket.on('data', () => undefined);
await new Promise((resolve) => setTimeout(resolve, 900));
console.log('SURVIVED');
await served.shutdown({ gracePeriodMs: 200 }).catch(() => undefined);
`;
        const dir = await mkdtemp(path.join(tmpdir(), 'azeroth-upload-cancel-'));
        try
        {
            const script = path.join(dir, 'abandon-upload.mjs');
            await writeFile(script, source);
            const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
            expect(run.stdout.trim().split('\n').pop()).toBe('SURVIVED');
            expect(run.status).toBe(0);
        }
        finally
        {
            await rm(dir, { recursive: true, force: true });
        }
    }, 60_000);
});
