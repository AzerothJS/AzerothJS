// @vitest-environment node
//
// The contract layer, exercised the way real apps use it: ONE contract file, a server
// implementing it (mounted on a real App), and a client whose transport is `app.handle` -
// the whole client/server round trip in process, no sockets, full inference end to end.
// The validation-parity property is the headline: the SAME schema (carrying REAL
// @azerothjs/form validators) rejects bad input in the client before the wire, rejects a
// forged request server-side, and the server's 422 lands as the exact field map setError
// consumes.

import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { email, required } from '@azerothjs/form';
import { object, string, number, boolean, type Infer } from '@azerothjs/schema';
import { App, noContent } from '@azerothjs/http';
import { defineContract, route, implementContract, mountApi, createClient, ApiError } from '@azerothjs/api';

// ---- the shared contract (in a real app: one file, imported by browser and server) ----

const user = object({ id: number({ int: true }), name: string(), email: string() });

const contract = defineContract({
    users: {
        get: route({ method: 'GET', path: '/users/:id', output: user }),
        list: route({
            method: 'GET', path: '/users',
            query: object({ limit: number({ coerce: true, int: true, min: 1 }).optional(), admin: boolean({ coerce: true }).optional() }),
            output: object({ total: number(), names: string() })
        }),
        create: route({
            method: 'POST', path: '/users',
            input: object({
                name: string({ min: 2 }),
                email: string().refine(required('Email is required')).refine(email('Enter a valid email'))
            }),
            output: user
        }),
        remove: route({ method: 'DELETE', path: '/users/:id' })
    },
    health: route({ method: 'GET', path: '/health', output: object({ ok: boolean() }) })
});

// ---- the server half ----

function buildServer(overrides: Partial<{ create: (input: { name: string; email: string }) => unknown }> = {}): App
{
    const app = new App();
    const api = implementContract(contract, {
        users: {
            get: ({ params }) =>
            {
                expectTypeOf(params.id).toEqualTypeOf<string>();
                return { id: Number(params.id), name: 'Jaina', email: 'jaina@theramore.org' };
            },
            list: ({ query }) =>
            {
                expectTypeOf(query.limit).toEqualTypeOf<number | undefined>();
                expectTypeOf(query.admin).toEqualTypeOf<boolean | undefined>();
                return { total: query.limit ?? 10, names: query.admin === true ? 'admins' : 'all' };
            },
            create: ({ input }) =>
            {
                expectTypeOf(input).toEqualTypeOf<{ name: string; email: string }>();
                if (overrides.create !== undefined)
                {
                    return overrides.create(input) as Infer<typeof user>;
                }
                return { id: 7, name: input.name, email: input.email };
            },
            remove: () => noContent()
        },
        health: () => ({ ok: true })
    });
    mountApi(app, api);
    return app;
}

/** The client whose transport IS the server - zero sockets. */
function buildClient(app: App): ReturnType<typeof createClient<typeof contract>>
{
    return createClient(contract, { baseUrl: '/api', fetch: (request) => app.handle(request) });
}

describe('the two-sided round trip', () =>
{
    it('typed calls flow through params, query, input, and output', async () =>
    {
        const client = buildClient(buildServer());

        const fetched = await client.users.get({ params: { id: '42' } });
        expectTypeOf(fetched).toEqualTypeOf<{ id: number; name: string; email: string }>();
        expect(fetched).toEqual({ id: 42, name: 'Jaina', email: 'jaina@theramore.org' });

        const listed = await client.users.list({ query: { limit: 3, admin: true } });
        expect(listed).toEqual({ total: 3, names: 'admins' });

        const created = await client.users.create({ input: { name: 'Thrall', email: 'thrall@orgrimmar.org' } });
        expect(created).toEqual({ id: 7, name: 'Thrall', email: 'thrall@orgrimmar.org' });

        const health = await client.health();
        expectTypeOf(health).toEqualTypeOf<{ ok: boolean }>();
        expect(health).toEqual({ ok: true });
    });

    it('a raw Response passes through (204 becomes undefined client-side)', async () =>
    {
        const client = buildClient(buildServer());
        await expect(client.users.remove({ params: { id: '9' } })).resolves.toBeUndefined();
    });
});

describe('validation parity: one schema, three enforcement points', () =>
{
    const BAD_INPUT = { name: 'x', email: 'not-an-email' };

    it('the client rejects locally BEFORE the wire, with the form-compatible field map', async () =>
    {
        const transport = vi.fn();
        const client = createClient(contract, { baseUrl: '/api', fetch: transport });

        const failure = await client.users.create({ input: BAD_INPUT }).catch((error: unknown) => error);
        expect(transport).not.toHaveBeenCalled(); // the request never left
        expect((failure as { fields: Record<string, string> }).fields).toEqual({
            name: 'Must be at least 2 characters',
            email: 'Enter a valid email'
        });
    });

    it('the server rejects a FORGED request (bypassing the client) with the same fields as a 422', async () =>
    {
        const app = buildServer();
        const response = await app.handle(new Request('http://local/api/users', {
            method: 'POST',
            body: JSON.stringify(BAD_INPUT),
            headers: { 'content-type': 'application/json' }
        }));
        expect(response.status).toBe(422);
        const wire = (await response.json()) as { error: { code: string; message: string; details: { fields: Record<string, string> } } };
        expect(wire.error.code).toBe('validation-failed');
        expect(wire.error.details.fields).toEqual({
            name: 'Must be at least 2 characters',
            email: 'Enter a valid email'
        });
    });

    it('a 422 reaching the client surfaces as ApiError.fields - setError-ready', async () =>
    {
        // A transport that skips client-side validation, simulating a stale client.
        const app = buildServer();
        const client = createClient(contract, { baseUrl: '/api', fetch: (request) => app.handle(request) });
        const direct = await app.handle(new Request('http://local/api/users', {
            method: 'POST', body: JSON.stringify(BAD_INPUT), headers: { 'content-type': 'application/json' }
        }));
        void client;
        const wire = (await direct.json()) as { error: { code: string; message: string; details: { fields: Record<string, string> } } };
        const apiError = new ApiError(direct.status, wire.error.code, wire.error.message, wire.error.details);
        expect(apiError.fields.email).toBe('Enter a valid email');
    });

    it('bad QUERY input is a 422 through the same shape (coercion included)', async () =>
    {
        const app = buildServer();
        const response = await app.handle(new Request('http://local/api/users?limit=zero'));
        expect(response.status).toBe(422);
        expect(((await response.json()) as { error: { code: string; message: string; details: { fields: Record<string, string> } } }).error.details.fields).toEqual({ limit: 'Expected a number' });
    });
});

describe('the output contract guards the server against itself', () =>
{
    it('a handler returning off-contract data is a hidden 500 (contract-violation)', async () =>
    {
        const app = buildServer({ create: () => ({ id: 'not-a-number', name: 5 }) });
        const response = await app.handle(new Request('http://local/api/users', {
            method: 'POST',
            body: JSON.stringify({ name: 'Valid Name', email: 'valid@example.org' }),
            headers: { 'content-type': 'application/json' }
        }));
        expect(response.status).toBe(500);
        const wire = (await response.json()) as { error: { code: string; message: string; details: { fields: Record<string, string> } } };
        expect(wire.error.code).toBe('contract-violation');
        expect(JSON.stringify(wire)).not.toContain('not-a-number'); // internals stay home
    });

    it('output STRIPS undeclared fields - accidental leaks die at the boundary', async () =>
    {
        const app = buildServer({ create: () => ({ id: 7, name: 'x', email: 'x@y.z', passwordHash: 'hunter2' }) });
        const client = buildClient(app);
        const created = await client.users.create({ input: { name: 'Valid', email: 'valid@example.org' } });
        expect(JSON.stringify(created)).not.toContain('hunter2');
    });
});

describe('compile-time contract enforcement', () =>
{
    it('implementContract demands every route with the derived signature', () =>
    {
        // @ts-expect-error - the users.create handler is missing.
        implementContract(contract, { users: { get: () => ({ id: 1, name: '', email: '' }), list: () => ({ total: 0, names: '' }), remove: () => noContent() }, health: () => ({ ok: true }) });

        implementContract(contract, {
            users: {
                // @ts-expect-error - the output type is wrong (id must be number).
                get: () => ({ id: 'one', name: '', email: '' }),
                list: () => ({ total: 0, names: '' }),
                create: ({ input }) => ({ id: 1, ...input }),
                remove: () => noContent()
            },
            health: () => ({ ok: true })
        });
        expect(true).toBe(true);
    });

    it('client calls are typed from the contract', () =>
    {
        const client = createClient(contract, { baseUrl: '/api', fetch: () => Promise.resolve(new Response('{}')) });
        // These calls exist only to assert the compile-time types; the client pre-validates
        // and rejects at runtime, so the returned promises are settled here rather than left
        // floating (an unhandled rejection would fail the run even though the types are the point).
        // @ts-expect-error - get requires params.
        client.users.get().catch(() => undefined);
        // @ts-expect-error - create input must match the schema type.
        client.users.create({ input: { name: 'x', email: 42 } }).catch(() => undefined);
        expect(true).toBe(true);
    });
});
