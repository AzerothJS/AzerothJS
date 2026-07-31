// @vitest-environment node
//
// The typed client validates input locally before sending - deliberately, since the failure then
// costs no network. But it threw `SchemaError` for that case and `ApiError` for a server refusal,
// so ONE logical failure ("validation failed") arrived as two types with different shapes, and
// only the server one carried `status`/`code`.
//
// That is why a real application ends up with a dozen copies of
// `err instanceof Error && err.message !== '' ? err.message : 'fallback'`: `instanceof ApiError`
// genuinely does not catch client-side validation, so reaching for the typed error does not work
// and duck-typing is the rational response. The typed error was unreachable in the exact case it
// was designed for.
//
// The client now always throws `ApiError`. Local validation reports `status: 422` and
// `code: 'validation-failed'` - the same pair the server sends for the same failure - and keeps
// the form-ready `fields` map that made SchemaError useful.
import { describe, expect, it } from 'vitest';

import { App } from '../../src/index.ts';
import { ApiError, createClient, defineContract, post } from '../../src/api/index.ts';
import { number, object, string } from '@azerothjs/schema';

const contract = defineContract({
    users: {
        create: post('/users', {
            input: object({ name: string({ min: 2 }), age: number({ int: true, min: 0 }) }),
            output: object({ id: number({ int: true }) })
        })
    }
});

function clientFor(app: App)
{
    return createClient(contract, { baseUrl: '/api', fetch: (request: Request) => app.handle(request) });
}

describe('the typed client reports one error type', () =>
{
    it('throws ApiError for a LOCAL validation failure, with status and code', async () =>
    {
        const app = new App({ dev: false });
        const client = clientFor(app);

        const failure = await client.users.create({ input: { name: 'x', age: -1 } }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ApiError);
        const api = failure as ApiError;
        expect(api.status).toBe(422);
        expect(api.code).toBe('validation-failed');
        expect(api.fields.name).toContain('at least 2');
        expect(api.fields.age).toBeDefined();
    });

    it('throws ApiError for a SERVER refusal too, so one catch covers both', async () =>
    {
        const app = new App({ dev: false });
        // No route mounted, so the server answers 404 - a different failure, same error type.
        const client = clientFor(app);

        const failure = await client.users.create({ input: { name: 'valid', age: 30 } }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as ApiError).status).toBe(404);
    });

    it('never reaches the network when input is invalid', async () =>
    {
        let sent = 0;
        const client = createClient(contract, {
            baseUrl: '/api',
            fetch: (_request: Request) =>
            {
                sent++;
                return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
            }
        });

        await client.users.create({ input: { name: 'x', age: -1 } }).catch(() => undefined);

        // The whole point of validating locally: a bad body costs nothing.
        expect(sent).toBe(0);
    });
});
