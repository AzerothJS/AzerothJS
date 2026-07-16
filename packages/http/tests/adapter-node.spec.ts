// @vitest-environment node
//
// The Node adapter, tested over REAL sockets: serve() on an ephemeral port, global fetch as
// the client. This is the one suite allowed to open connections - everything above the
// adapter tests through app.handle(). Covers the translation fidelity (methods, headers,
// bodies, Set-Cookie multiplicity), the disconnect AbortSignal, streaming with backpressure,
// graceful shutdown semantics, and the same app served over cleartext HTTP/2.

import { describe, it, expect, vi } from 'vitest';
import { connect as h2connect } from 'node:http2';
import { App } from '../src/app.ts';
import { json, text, noContent } from '../src/respond.ts';
import { readJson } from '../src/body.ts';
import { serve, serveH2c, type Served } from '../src/adapter-node.ts';

async function withServer(app: App, run: (base: string, served: Served) => Promise<void>): Promise<void>
{
    const served = await serve(app);
    try
    {
        await run(`http://127.0.0.1:${ served.port }`, served);
    }
    finally
    {
        await served.shutdown({ gracePeriodMs: 1000 });
    }
}

describe('request/response translation over a real socket', () =>
{
    it('round-trips a JSON POST end to end', async () =>
    {
        const app = new App();
        app.post('/echo/:tag', async (request, ctx) =>
        {
            const body = await readJson<{ n: number }>(request);
            return json({ tag: ctx.params.tag, doubled: body.n * 2, query: ctx.url.searchParams.get('q') });
        });
        await withServer(app, async (base) =>
        {
            const response = await fetch(`${ base }/echo/x?q=1`, {
                method: 'POST',
                body: JSON.stringify({ n: 21 }),
                headers: { 'content-type': 'application/json' }
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ tag: 'x', doubled: 42, query: '1' });
        });
    });

    it('writes multiple Set-Cookie headers separately (the header that must never be joined)', async () =>
    {
        const app = new App();
        app.get('/login', () =>
        {
            const headers = new Headers();
            headers.append('set-cookie', 'a=1; HttpOnly');
            headers.append('set-cookie', 'b=2; Path=/');
            return new Response(null, { status: 204, headers });
        });
        await withServer(app, async (base) =>
        {
            const response = await fetch(`${ base }/login`);
            expect(response.headers.getSetCookie()).toEqual(['a=1; HttpOnly', 'b=2; Path=/']);
        });
    });

    it('kernel errors cross the wire with their shape intact (404, 405+Allow)', async () =>
    {
        const app = new App();
        app.get('/only-get', () => noContent());
        await withServer(app, async (base) =>
        {
            const miss = await fetch(`${ base }/nope`);
            expect(miss.status).toBe(404);
            expect(((await miss.json()) as { error: { code: string; message: string } }).error.code).toBe('not-found');

            const mismatch = await fetch(`${ base }/only-get`, { method: 'DELETE' });
            expect(mismatch.status).toBe(405);
            expect(mismatch.headers.get('allow')).toBe('GET');
        });
    });

    it('streams a response body chunk by chunk', async () =>
    {
        const app = new App();
        app.get('/stream', () =>
        {
            const encoder = new TextEncoder();
            let i = 0;
            return new Response(new ReadableStream({
                pull(controller)
                {
                    if (i === 3)
                    {
                        controller.close();
                        return;
                    }
                    controller.enqueue(encoder.encode(`chunk-${ i++ };`));
                }
            }), { headers: { 'content-type': 'text/plain' } });
        });
        await withServer(app, async (base) =>
        {
            expect(await (await fetch(`${ base }/stream`)).text()).toBe('chunk-0;chunk-1;chunk-2;');
        });
    });
});

describe('the disconnect AbortSignal', () =>
{
    it('fires request.signal when the client goes away mid-response', async () =>
    {
        const aborted = vi.fn();
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) =>
        {
            release = resolve;
        });

        const app = new App();
        app.get('/slow', async (request) =>
        {
            request.signal.addEventListener('abort', () =>
            {
                aborted();
                release();
            });
            await gate; // hold the response open until the abort proves itself
            return text('finally');
        });

        await withServer(app, async (base) =>
        {
            const client = new AbortController();
            const attempt = fetch(`${ base }/slow`, { signal: client.signal }).catch(() => null);
            await new Promise((r) => setTimeout(r, 50)); // let the request reach the handler
            client.abort();
            await attempt;
            await gate;
            expect(aborted).toHaveBeenCalledTimes(1);
        });
    });
});

describe('graceful shutdown', () =>
{
    it('lets an in-flight response finish before closing', async () =>
    {
        const app = new App();
        app.get('/work', async () =>
        {
            await new Promise((r) => setTimeout(r, 120));
            return text('done');
        });
        const served = await serve(app);
        const base = `http://127.0.0.1:${ served.port }`;

        const inFlight = fetch(`${ base }/work`);
        await new Promise((r) => setTimeout(r, 30)); // the request is on the server now
        const closing = served.shutdown({ gracePeriodMs: 2000 });

        const response = await inFlight;
        expect(await response.text()).toBe('done');
        await closing;

        // The server is really gone: a new connection must be refused.
        await expect(fetch(`${ base }/work`)).rejects.toThrow();
    });

    it('the grace deadline caps how long a stuck response can hold shutdown', async () =>
    {
        const app = new App();
        app.get('/stuck', () => new Promise<Response>(() => undefined)); // never resolves
        const served = await serve(app);
        const base = `http://127.0.0.1:${ served.port }`;

        void fetch(`${ base }/stuck`).catch(() => null);
        await new Promise((r) => setTimeout(r, 30));

        const started = Date.now();
        await served.shutdown({ gracePeriodMs: 150 });
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(100);
        expect(elapsed).toBeLessThan(2000); // destroyed at the deadline, not hung forever
    });
});

describe('the same app over cleartext HTTP/2', () =>
{
    it('serves an h2c request through the identical listener', async () =>
    {
        const app = new App();
        app.get('/h2', (_request, ctx) => json({ proto: 'h2c', path: ctx.url.pathname }));
        const served = await serveH2c(app);

        const session = h2connect(`http://127.0.0.1:${ served.port }`);
        try
        {
            const body = await new Promise<string>((resolve, reject) =>
            {
                const stream = session.request({ ':path': '/h2', ':method': 'GET' });
                let data = '';
                stream.setEncoding('utf8');
                stream.on('data', (chunk: string) =>
                {
                    data += chunk;
                });
                stream.on('end', () => resolve(data));
                stream.on('error', reject);
            });
            expect(JSON.parse(body)).toEqual({ proto: 'h2c', path: '/h2' });
        }
        finally
        {
            session.close();
            await served.shutdown({ gracePeriodMs: 500 });
        }
    });
});

describe('the connect `before` seam (dev tooling ahead of the app)', () =>
{
    it('the middleware answers its own paths and nexts through to app routes', async () =>
    {
        const app = new App();
        app.get('/page', () => text('from the app'));

        const served = await serve(app, { before: (req, res, next) =>
        {
            if (req.url?.startsWith('/@vite') === true)
            {
                res.writeHead(200, { 'content-type': 'text/javascript' });
                res.end('// vite client');
                return;
            }
            next();
        } });
        const base = `http://127.0.0.1:${ served.port }`;
        try
        {
            expect(await (await fetch(`${ base }/@vite/client`)).text()).toBe('// vite client');
            expect(await (await fetch(`${ base }/page`)).text()).toBe('from the app');
            expect((await fetch(`${ base }/missing`)).status).toBe(404); // the app's 404, through next()
        }
        finally
        {
            await served.shutdown({ gracePeriodMs: 500 });
        }
    });

    it('a middleware error becomes a 500 without killing the server', async () =>
    {
        const app = new App();
        app.get('/ok', () => text('still alive'));
        const served = await serve(app, { before: (req, _res, next) =>
        {
            if (req.url === '/explode')
            {
                next(new Error('dev tooling crashed'));
                return;
            }
            next();
        } });
        const base = `http://127.0.0.1:${ served.port }`;
        try
        {
            expect((await fetch(`${ base }/explode`)).status).toBe(500);
            expect(await (await fetch(`${ base }/ok`)).text()).toBe('still alive');
        }
        finally
        {
            await served.shutdown({ gracePeriodMs: 500 });
        }
    });
});
