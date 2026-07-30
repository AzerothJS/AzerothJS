// The framework's whole integration-testing story in one line:
// `app.handle(new Request(...))` - no sockets, no test server, no inject shim.
import { describe, it, expect } from 'vitest';

import { buildApp } from '../src/app.ts';

const app = buildApp({ dev: false });
const call = (path: string, init?: RequestInit): Promise<Response> =>
    app.handle(new Request(`http://local${ path }`, init));

const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    call(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

const AUTH = { authorization: 'Bearer tester' };

describe('{{name}}', () =>
{
    it('answers the health probe', async () =>
    {
        const response = await call('/healthz');
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
    });

    it('rejects a request the middleware does not authorize, before the handler runs', async () =>
    {
        const response = await post('/rooms/lobby/messages', { message: 'hi' });
        expect(response.status).toBe(401);
        const body = await response.json() as { ok: boolean; error: { code: string } };
        expect(body.ok).toBe(false);
        expect(body.error.code).toBe('unauthorized');
    });

    it('types the path param and what the middleware attached', async () =>
    {
        const response = await post('/rooms/lobby/messages', { message: 'hi' }, AUTH);
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({ room: 'lobby', from: 'tester', message: 'hi' });
    });

    it('turns a bad body into the envelope field map', async () =>
    {
        const response = await post('/rooms/lobby/messages', { message: '  ' }, AUTH);
        expect(response.status).toBe(422);
        const body = await response.json() as { error: { fields?: Record<string, string> } };
        expect(body.error.fields).toEqual({ message: 'A message is required.' });
    });

    it('speaks the error envelope even for unknown routes', async () =>
    {
        const response = await call('/nope');
        expect(response.status).toBe(404);
        const body = await response.json() as { ok: boolean; error: { code: string } };
        expect(body.ok).toBe(false);
        expect(body.error.code).toBe('not-found');
    });
});
