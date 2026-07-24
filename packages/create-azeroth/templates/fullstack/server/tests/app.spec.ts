// `app.handle(new Request(...))` is the whole integration story - no server needed.
import { describe, it, expect } from 'vitest';

import { buildApp } from '../src/app.ts';

const app = buildApp({ dev: false });
const get = (path: string): Promise<Response> => app.handle(new Request(`http://local${ path }`));

describe('{{name}} api', () =>
{
    it('answers the health probe', async () =>
    {
        const response = await get('/api/healthz');
        expect(response.status).toBe(200);
        expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
    });

    it('404s cleanly outside /api when no client is mounted', async () =>
    {
        expect((await get('/nope')).status).toBe(404);
    });
});
