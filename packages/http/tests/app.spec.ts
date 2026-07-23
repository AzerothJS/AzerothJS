// @vitest-environment node
//
// The kernel dispatcher, driven exactly the way integration tests will drive real apps:
// `app.handle(new Request(...))` - no sockets. Pins the never-throws guarantee, 404 vs
// 405+Allow, typed params, HEAD semantics, and the response-helper round trip.

import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { App, type RequestContext } from '../src/app.ts';
import { json, text, redirect, noContent, created } from '../src/respond.ts';
import { readJson } from '../src/body.ts';
import { UnauthorizedError } from '../src/errors.ts';

function get(app: App, path: string, init: RequestInit = {}): Promise<Response>
{
    return app.handle(new Request(`http://local${ path }`, init));
}

describe('dispatch', () =>
{
    it('routes to the handler with typed params', async () =>
    {
        const app = new App();
        app.get('/users/:id', (_request, ctx) =>
        {
            expectTypeOf(ctx.params.id).toEqualTypeOf<string>();
            return json({ id: ctx.params.id });
        });
        const response = await get(app, '/users/42');
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: '42' });
    });

    it('hands every handler the parsed URL (query included)', async () =>
    {
        const app = new App();
        app.get('/search', (_request, ctx: RequestContext) => text(ctx.url.searchParams.get('q') ?? ''));
        expect(await (await get(app, '/search?q=azeroth')).text()).toBe('azeroth');
    });

    it('a miss is a 404 with the wire shape', async () =>
    {
        const app = new App();
        app.get('/exists', () => noContent());
        const response = await get(app, '/absent');
        expect(response.status).toBe(404);
        expect(((await response.json()) as { error: { code: string; message: string } }).error.code).toBe('not-found');
    });

    it('serializeError makes every error speak the app envelope - route-miss 404 included', async () =>
    {
        const app = new App({
            serializeError: ({ error, request }) => ({ success: false, code: error.code, path: new URL(request.url).pathname })
        });
        app.get('/boom', () =>
        {
            throw new UnauthorizedError('nope');
        });

        const thrown = await get(app, '/boom');
        expect(thrown.status).toBe(401);
        expect(await thrown.json()).toEqual({ success: false, code: 'unauthorized', path: '/boom' });

        // The route-miss 404 takes the same envelope, not the cached default shape.
        const miss = await get(app, '/absent');
        expect(miss.status).toBe(404);
        expect(await miss.json()).toEqual({ success: false, code: 'not-found', path: '/absent' });
    });

    it('a method mismatch is a 405 with Allow, not a 404', async () =>
    {
        const app = new App();
        app.get('/thing', () => noContent());
        app.put('/thing', () => noContent());
        const response = await get(app, '/thing', { method: 'DELETE' });
        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('GET, PUT');
    });

    it('a full round trip: POST body in, created() out', async () =>
    {
        const app = new App();
        app.post('/users', async (request) =>
        {
            const body = await readJson<{ name: string }>(request);
            return created('/users/7', { id: 7, name: body.name });
        });
        const response = await get(app, '/users', {
            method: 'POST',
            body: JSON.stringify({ name: 'Jaina' }),
            headers: { 'content-type': 'application/json' }
        });
        expect(response.status).toBe(201);
        expect(response.headers.get('location')).toBe('/users/7');
        expect(await response.json()).toEqual({ id: 7, name: 'Jaina' });
    });
});

describe('the never-throws guarantee', () =>
{
    it('a thrown HttpError maps to its status', async () =>
    {
        const app = new App();
        app.get('/private', () =>
        {
            throw new UnauthorizedError();
        });
        expect((await get(app, '/private')).status).toBe(401);
    });

    it('a SYNC throw of a plain Error becomes a hidden 500', async () =>
    {
        const app = new App();
        app.get('/boom', () =>
        {
            throw new Error('internal detail');
        });
        const response = await get(app, '/boom');
        expect(response.status).toBe(500);
        expect(JSON.stringify(await response.json())).not.toContain('internal detail');
    });

    it('an ASYNC rejection is caught identically (the classic Express process-killer)', async () =>
    {
        const app = new App();
        app.get('/boom', async () =>
        {
            await Promise.resolve();
            throw new Error('async detail');
        });
        expect((await get(app, '/boom')).status).toBe(500);
    });

    it('a body-reader failure inside a handler maps through the same path (413)', async () =>
    {
        const app = new App();
        app.post('/upload', async (request) =>
        {
            await readJson(request, { limit: 8 });
            return noContent();
        });
        const response = await get(app, '/upload', {
            method: 'POST',
            body: JSON.stringify({ big: 'x'.repeat(64) }),
            headers: { 'content-type': 'application/json' }
        });
        expect(response.status).toBe(413);
    });

    it('the onError observer sees every mapped failure', async () =>
    {
        const onError = vi.fn();
        const app = new App({ onError });
        app.get('/boom', () =>
        {
            throw new Error('x');
        });
        await get(app, '/boom');
        await get(app, '/never-registered');
        expect(onError).toHaveBeenCalledTimes(2);
    });

    it('dev mode surfaces the real message', async () =>
    {
        const app = new App({ dev: true });
        app.get('/boom', () =>
        {
            throw new Error('the real reason');
        });
        expect(((await (await get(app, '/boom')).json()) as { error: { code: string; message: string } }).error.message).toBe('the real reason');
    });
});

describe('HEAD semantics', () =>
{
    it('serves HEAD from GET with entity headers and no body', async () =>
    {
        const app = new App();
        app.get('/doc', () => text('hello world'));
        const response = await get(app, '/doc', { method: 'HEAD' });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/plain');
        expect(response.body).toBeNull();
    });

    it('cancels a streaming body instead of leaking its producer', async () =>
    {
        let cancelled = false;
        const app = new App();
        app.get('/stream', () => new Response(new ReadableStream({
            cancel()
            {
                cancelled = true;
            }
        })));
        await get(app, '/stream', { method: 'HEAD' });
        expect(cancelled).toBe(true);
    });
});

describe('response helpers', () =>
{
    it('json/text set charset-bearing content types', () =>
    {
        expect(json({}).headers.get('content-type')).toBe('application/json; charset=utf-8');
        expect(text('x').headers.get('content-type')).toBe('text/plain; charset=utf-8');
    });

    it('redirect defaults to 303 (post/redirect/get works everywhere)', () =>
    {
        const response = redirect('/next');
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('/next');
    });

    it('route registration conflicts throw at boot through the App surface too', () =>
    {
        const app = new App();
        app.get('/a', () => noContent());
        expect(() => app.get('/a', () => noContent())).toThrow(/already registered/);
    });
});
