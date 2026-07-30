// @vitest-environment node
//
// `App.handle` promises a Response for every request. Its docblock states it "cannot throw and
// cannot reject; every failure becomes an error Response", and its signature says
// `Promise<Response>`. The throw path honoured that from the start; the RETURN path did not.
//
// A handler that resolves with something that is not a Response - most realistically an async
// handler that forgets to return on one branch - had its value passed straight back to the
// caller. Nothing rejected, so `onError` never fired and an observer recorded the request as a
// success. What broke depended on who called `handle`: the node adapter reads `.status` off it
// and dies, an edge runtime returns it to the platform, and `pipeline()` middleware reads
// `.headers` off `undefined`. A framework whose kernel promises totality has to enforce it
// where the value is produced, not leave every caller to re-check.
import { describe, expect, it, vi } from 'vitest';

import { App, json, pipeline, securityHeaders } from '../src/index.ts';

describe('App.handle always resolves with a Response', () =>
{
    it('turns a handler that forgot to return into a 500', async () =>
    {
        const app = new App({ dev: false });
        app.get('/forgot', async (context) =>
        {
            if (context.url.searchParams.has('ok'))
            {
                return json({ ok: 1 });
            }
            // falls through: resolves undefined
            return undefined as unknown as Response;
        });

        const good = await app.handle(new Request('http://local/forgot?ok=1'));
        expect(good.status).toBe(200);

        const bad = await app.handle(new Request('http://local/forgot'));
        expect(bad).toBeInstanceOf(Response);
        expect(bad.status).toBe(500);
    });

    it.each([
        ['undefined', undefined],
        ['null', null],
        ['a plain object', { notAResponse: true }],
        ['a string', 'just a string'],
        ['a number', 42]
    ])('turns %s into a 500 rather than handing it back', async (_label, value) =>
    {
        const app = new App({ dev: false });
        app.get('/bad', () => value as unknown as Response);

        const response = await app.handle(new Request('http://local/bad'));
        expect(response).toBeInstanceOf(Response);
        expect(response.status).toBe(500);
    });

    it('reports the broken handler to onError instead of recording a success', async () =>
    {
        const onError = vi.fn();
        const app = new App({ dev: false, onError });
        app.get('/bad', () => undefined as unknown as Response);

        const response = await app.handle(new Request('http://local/bad'));

        expect(response.status).toBe(500);
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it('does not leak the handler return value to the client', async () =>
    {
        const app = new App({ dev: false });
        app.get('/bad', () => ({ internalSecret: 'do-not-ship' }) as unknown as Response);

        const response = await app.handle(new Request('http://local/bad'));
        const body = await response.text();

        expect(response.status).toBe(500);
        expect(body).not.toContain('do-not-ship');
        expect(body).not.toContain('internalSecret');
    });

    it('survives the same failure through pipeline()', async () =>
    {
        const app = new App({ dev: false });
        app.get('/bad', async () => undefined as unknown as Response);
        const handler = pipeline(app, securityHeaders());

        const response = await handler.handle(new Request('http://local/bad'));

        expect(response).toBeInstanceOf(Response);
        expect(response.status).toBe(500);
    });

    it('still returns a Response for every throwing shape', async () =>
    {
        const app = new App({ dev: false });
        app.get('/throw', () =>
        {
            throw new Error('boom');
        });
        app.get('/throw-null', () =>
        {
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw null;
        });
        app.get('/reject', () => Promise.reject(new Error('rejected')));

        for (const path of ['/throw', '/throw-null', '/reject', '/missing'])
        {
            const response = await app.handle(new Request(`http://local${ path }`));
            expect(response, path).toBeInstanceOf(Response);
        }
    });
});
