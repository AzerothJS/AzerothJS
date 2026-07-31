// @vitest-environment node
//
// The four route kinds the old contract could not express - upload, webhook, 304, SSE - as
// first-class declarations: they inherit the feature guard, and the SSE route's anonymous
// request is refused by the SAME guard the JSON routes use (which previously required a
// hand-written call outside the system).
import { describe, it, expect } from 'vitest';
import { object, string } from '@azerothjs/schema';
import { App } from '../../src/app.ts';
import { conditional } from '../../src/conditional.ts';
import { feature } from '../../src/api/feature.ts';
import { register } from '../../src/api/register.ts';

const requireKey = (context: { request: Request }): Response | undefined =>
    context.request.headers.get('x-key') === 'secret' ? undefined : new Response(null, { status: 401 });

function build(): App
{
    const app = new App();
    register(app, {
        media: feature('/media', [requireKey], (routes) => ({
            upload: routes.form('/', { fields: object({ title: string() }), maxFileSize: 64 }, (context) => ({
                title: context.input.fields.title,
                files: context.input.files.length
            })),
            avatar: routes.raw('GET', '/avatar', {}, (context) =>
                conditional(context.request, { bytes: 'png-bytes' }, { scope: 'avatar' })),
            events: routes.stream('/events', {}, (_context, connection) =>
            {
                connection.send('hello', { event: 'greeting' });
                connection.close();
            })
        })),
        hooks: feature('/hooks', (routes) => ({
            stripe: routes.raw('POST', '/stripe', {}, async (context) =>
            {
                const raw = await context.request.text();
                return new Response(JSON.stringify({ bytes: raw.length }), { headers: { 'content-type': 'application/json' } });
            })
        }))
    });
    return app;
}

function multipartRequest(path: string, parts: Array<{ name: string; value: string; filename?: string }>, key = 'secret'): Request
{
    const boundary = 'x-test-boundary';
    let body = '';
    for (const part of parts)
    {
        body += `--${ boundary }\r\ncontent-disposition: form-data; name="${ part.name }"`;
        if (part.filename !== undefined)
        {
            body += `; filename="${ part.filename }"`;
        }
        body += '\r\n\r\n' + part.value + '\r\n';
    }
    body += `--${ boundary }--\r\n`;
    return new Request(`http://x${ path }`, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${ boundary }`, 'x-key': key },
        body
    });
}

describe('route kinds - all four inside the system', () =>
{
    it('a form route validates fields, buffers files, and inherits the guard', async () =>
    {
        const app = build();
        const good = await app.handle(multipartRequest('/api/media', [
            { name: 'title', value: 'hi' },
            { name: 'file', value: 'bytes', filename: 'a.txt' }
        ]));
        expect(good.status).toBe(200);
        expect(await good.json()).toEqual({ title: 'hi', files: 1 });

        const anonymous = await app.handle(multipartRequest('/api/media', [{ name: 'title', value: 'hi' }], 'wrong'));
        expect(anonymous.status).toBe(401);

        const badFields = await app.handle(multipartRequest('/api/media', [{ name: 'nope', value: 'x' }]));
        expect(badFields.status).toBe(422);
    });

    it('a JSON body posted to a form route is a 415', async () =>
    {
        const app = build();
        const response = await app.handle(new Request('http://x/api/media', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-key': 'secret' },
            body: JSON.stringify({ title: 'hi' })
        }));
        expect(response.status).toBe(415);
    });

    it('a file over the per-file cap is a 413', async () =>
    {
        const app = build();
        const response = await app.handle(multipartRequest('/api/media', [
            { name: 'title', value: 'hi' },
            { name: 'file', value: 'y'.repeat(100), filename: 'big.bin' }
        ]));
        expect(response.status).toBe(413);
    });

    it('a raw route serves a conditional 304 behind the guard', async () =>
    {
        const app = build();
        const first = await app.handle(new Request('http://x/api/media/avatar', { headers: { 'x-key': 'secret' } }));
        expect(first.status).toBe(200);
        const etag = first.headers.get('etag');
        expect(etag).not.toBeNull();

        const second = await app.handle(new Request('http://x/api/media/avatar', {
            headers: { 'x-key': 'secret', 'if-none-match': etag as string }
        }));
        expect(second.status).toBe(304);

        const anonymous = await app.handle(new Request('http://x/api/media/avatar'));
        expect(anonymous.status).toBe(401);
    });

    it('a webhook feature with no guard reads its raw bytes', async () =>
    {
        const app = build();
        const response = await app.handle(new Request('http://x/api/hooks/stripe', {
            method: 'POST', body: 'payload-bytes'
        }));
        expect(await response.json()).toEqual({ bytes: 13 });
    });

    it('the SSE route is refused by the SAME guard the JSON routes use', async () =>
    {
        const app = build();
        const anonymous = await app.handle(new Request('http://x/api/media/events'));
        expect(anonymous.status).toBe(401);

        const authed = await app.handle(new Request('http://x/api/media/events', { headers: { 'x-key': 'secret' } }));
        expect(authed.status).toBe(200);
        expect(authed.headers.get('content-type')).toContain('text/event-stream');
        const text = await authed.text();
        expect(text).toContain('event: greeting');
        expect(text).toContain('data: hello');
    });
});
