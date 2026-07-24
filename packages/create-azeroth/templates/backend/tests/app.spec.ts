// The framework's whole integration-testing story in one line:
// `app.handle(new Request(...))` - no sockets, no test server, no inject shim.
import { describe, it, expect } from 'vitest';

import { buildApp } from '../src/app.ts';

const app = buildApp({ dev: false });
const get = (path: string): Promise<Response> => app.handle(new Request(`http://local${ path }`));

describe('{{name}}', () =>
{
    it('answers the health probe', async () =>
    {
        const response = await get('/healthz');
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
    });

    it('types params from the route pattern', async () =>
    {
        const response = await get('/hello/world');
        expect(await response.json()).toEqual({ hello: 'world' });
    });

    it('speaks the error envelope even for unknown routes', async () =>
    {
        const response = await get('/nope');
        expect(response.status).toBe(404);
        const body = await response.json() as { ok: boolean; error: { code: string } };
        expect(body.ok).toBe(false);
        expect(body.error.code).toBe('not-found');
    });
});
