// @vitest-environment node
//
// One error type, one wire shape, end to end: the server's 422 envelope
// `{ error: { code, message, details: { fields, issues } } }` lands in the client as
// `ApiError` with the form-ready `fields` map. This is now the ONLY path into a form's
// `setError` - client-side pre-validation left with the colocated design (input validation
// lives in `createForm({ schema })` and at the server boundary) - so the envelope's byte
// compatibility is pinned here, round-tripped through a real App with zero sockets.
import { describe, expect, it } from 'vitest';

import { App } from '../../src/app.ts';
import { feature } from '../../src/api/feature.ts';
import { register } from '../../src/api/register.ts';
import { manifestOf } from '../../src/api/feature.ts';
import { ApiError, createClient } from '../../src/api/client.ts';
import { number, object, string } from '@azerothjs/schema';

const users = feature('/users', (routes) => ({
    create: routes.post('/', {
        input: object({ name: string({ min: 2 }), age: number({ int: true, min: 0 }) }),
        output: object({ id: number({ int: true }) })
    }, () => ({ id: 1 }))
}));

const api = { users };

function clientFor(app: App)
{
    return createClient<typeof api>(manifestOf(api), { baseUrl: '/api', fetch: (request: Request) => app.handle(request) });
}

describe('the wire error shape survives the round trip', () =>
{
    it('a server 422 arrives as ApiError carrying the form-ready field map and the issues', async () =>
    {
        const app = new App({ dev: false });
        register(app, api);
        const client = clientFor(app);

        const failure = await client.users.create({ input: { name: 'x', age: -1 } }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ApiError);
        const apiError = failure as ApiError;
        expect(apiError.status).toBe(422);
        expect(apiError.code).toBe('validation-failed');
        expect(apiError.fields['name']).toContain('at least 2');
        expect(apiError.fields['age']).toBeDefined();
        expect(apiError.issues.length).toBeGreaterThan(0);
        expect(apiError.issues[0]).toHaveProperty('path');
        expect(apiError.issues[0]).toHaveProperty('code');
    });

    it('every failure is the SAME error type, so one catch covers all of them', async () =>
    {
        const app = new App({ dev: false });
        // Nothing registered: the server answers 404 - a different failure, same type.
        const client = clientFor(app);

        const failure = await client.users.create({ input: { name: 'valid', age: 30 } }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as ApiError).status).toBe(404);
    });
});
