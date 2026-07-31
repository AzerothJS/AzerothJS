import { describe, it, expect } from 'vitest';

import { buildApp } from '../src/app.ts';

const app = buildApp({ dev: false });
const get = (path: string): Promise<Response> => app.handle(new Request(`http://local${ path }`));
const post = (path: string, body: unknown): Promise<Response> => app.handle(new Request(`http://local${ path }`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' }
}));

describe('{{name}} api', () =>
{
    it('answers the health probe', async () =>
    {
        const response = await get('/api/healthz');
        expect(response.status).toBe(200);
        expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
    });

    it('signs and lists guest-book entries through the registered feature', async () =>
    {
        const created = await post('/api/guestbook', { name: 'IntelligentQuantum', message: 'Well met!' });
        expect(created.status).toBe(200);

        const list = await get('/api/guestbook');
        const entries = (await list.json()) as Array<{ name: string; message: string }>;
        expect(entries[0]).toMatchObject({ name: 'IntelligentQuantum', message: 'Well met!' });
    });

    it('the shared schema rejects a forged request with the form-shaped field map', async () =>
    {
        const bad = await post('/api/guestbook', { name: 'J', message: '' });
        expect(bad.status).toBe(422);
        const wire = (await bad.json()) as { error: { details: { fields: Record<string, string> } } };
        expect(Object.keys(wire.error.details.fields)).toEqual(expect.arrayContaining(['name', 'message']));
    });

    it('404s cleanly outside /api when no client is mounted', async () =>
    {
        expect((await get('/nope')).status).toBe(404);
    });

    it('streams the declared stream route as server-sent events, terminator included', async () =>
    {
        // The stream route kind: declared beside the JSON routes, driven by the same app.handle -
        // no sockets, and the declaration (not a hand-mounted exception) owns the connection.
        const response = await get('/api/assistant?q=hello');
        expect(response.headers.get('content-type')).toContain('text/event-stream');

        const body = await response.text();
        expect(body).toContain('data: You asked: hello');
        expect(body).toContain('data: Streaming');
        expect(body).toContain('data: [DONE]');
    });
});
