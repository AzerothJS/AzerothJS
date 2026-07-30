// @vitest-environment node
//
// RFC 9112 3.2.2: "A server MUST accept the absolute-form in requests". RFC 9112 3.3: when the
// request-target is in absolute-form, the target URI IS the request-target - its path is the
// path, not something to append to an authority we composed ourselves.
//
// The adapter composed `${scheme}://${authority}${req.url}` unconditionally. Node hands
// `req.url` the WHOLE absolute URI for absolute-form, so that concatenated twice:
// `GET http://evil.com/admin` became `http://thttp://evil.com/admin`, whose pathname is
// `//evil.com/admin` and whose host is the fabricated `thttp`. Three consequences: the request
// routes to the wrong resource, `request.url` is not a legal URL, and `context.url.host` reports
// an authority no client ever sent - so a host check written on it compares against garbage.
//
// The path is taken from the absolute-form target; the AUTHORITY deliberately is not. Letting
// the request line choose the origin would hand an attacker direct control of `context.url.host`,
// which is worse than the bug being fixed. Express and Koa make the same choice.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';

import { App, json } from '../src/index.ts';
import { serve } from '../src/node.ts';

const app = new App({ dev: false });
const describeTarget = (context: { path: string; url: URL }): Response =>
    json({ path: context.path, host: context.url.host, pathname: context.url.pathname });

app.get('/admin', () => json({ reached: 'admin' }));
app.get('/', describeTarget);
app.get('/*rest', describeTarget);

let served: Awaited<ReturnType<typeof serve>>;

beforeAll(async () =>
{
    served = await serve(app, { port: 0, banner: false });
});

afterAll(async () =>
{
    await served.shutdown();
});

/** Sends one raw request line; fetch() will not emit a non-origin-form target. */
function raw(requestLine: string): Promise<string>
{
    return new Promise((resolve, reject) =>
    {
        const socket = net.connect(served.port, '127.0.0.1', () =>
        {
            socket.write(`${ requestLine }\r\nHost: t\r\nConnection: close\r\n\r\n`);
        });
        let buffer = '';
        socket.on('data', (chunk) =>
        {
            buffer += String(chunk);
        });
        socket.on('error', reject);
        socket.on('close', () => resolve(buffer));
    });
}

function bodyOf(response: string): string
{
    return response.split('\r\n\r\n').slice(1).join('').trim();
}

describe('absolute-form request targets', () =>
{
    it('routes on the target URI path, not on a doubled URL', async () =>
    {
        expect(bodyOf(await raw('GET http://evil.com/admin HTTP/1.1'))).toContain('"reached":"admin"');
        expect(bodyOf(await raw('GET https://evil.com:8443/admin?q=1 HTTP/1.1'))).toContain('"reached":"admin"');
    });

    it('never lets the request line dictate the authority', async () =>
    {
        const body = JSON.parse(bodyOf(await raw('GET http://evil.com/nowhere HTTP/1.1'))) as { host: string; path: string };

        expect(body.host).toBe('t');
        expect(body.host).not.toContain('evil.com');
        expect(body.path).toBe('/nowhere');
    });

    it('produces a request.url that parses', async () =>
    {
        const body = JSON.parse(bodyOf(await raw('GET http://evil.com/nowhere HTTP/1.1'))) as { pathname: string };

        expect(body.pathname).toBe('/nowhere');
        expect(body.pathname.startsWith('//')).toBe(false);
    });

    it('leaves origin-form untouched', async () =>
    {
        expect(bodyOf(await raw('GET /admin HTTP/1.1'))).toContain('"reached":"admin"');

        const body = JSON.parse(bodyOf(await raw('GET /a/b?q=1 HTTP/1.1'))) as { path: string; host: string };
        expect(body.path).toBe('/a/b');
        expect(body.host).toBe('t');
    });

    it('treats an authority-only absolute target as the root', async () =>
    {
        const body = JSON.parse(bodyOf(await raw('GET http://evil.com HTTP/1.1'))) as { path: string };

        expect(body.path).toBe('/');
    });
});
