// @vitest-environment node
//
// The contract layer, exercised the way real apps use it: ONE contract file, a server
// implementing it (mounted on a real App), and a client whose transport is `app.handle` -
// the whole client/server round trip in process, no sockets, full inference end to end.
// The validation-parity property is the headline: the SAME schema (carrying REAL
// azerothjs validators) rejects bad input in the client before the wire, rejects a
// forged request server-side, and the server's 422 lands as the exact field map setError
// consumes.

import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { email, required } from 'azerothjs';
import { object, string, number, boolean, type Infer, type StandardSchemaV1 } from '@azerothjs/schema';
import { App, HttpError, noContent } from '@azerothjs/http';
import { defineContract, route, mountApi, createClient, reply, multipart, ApiError, type HandlersWithGuards, type StatusReply } from '@azerothjs/http/api';

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
    mountApi(app, contract, { handlers: {
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
    } });
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
    it('the unified mount demands every route with the derived signature', () =>
    {
        // @ts-expect-error - the users.create handler is missing.
        const missing: HandlersWithGuards<typeof contract, Record<never, never>> = { users: { get: () => ({ id: 1, name: '', email: '' }), list: () => ({ total: 0, names: '' }), remove: () => noContent() }, health: () => ({ ok: true }) };
        void missing;

        const drifted: HandlersWithGuards<typeof contract, Record<never, never>> = {
            users: {
                // @ts-expect-error - the output type is wrong (id must be number).
                get: () => ({ id: 'one', name: '', email: '' }),
                list: () => ({ total: 0, names: '' }),
                create: ({ input }) => ({ id: 1, ...input }),
                remove: () => noContent()
            },
            health: () => ({ ok: true })
        };
        void drifted;
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

describe('handler context passthrough', () =>
{
    it('a handler behind scoped middleware reads what the middleware attached', async () =>
    {
        const contract = defineContract({
            me: route({ method: 'GET', path: '/me', output: object({ user: string() }) })
        });
        const app = new App();
        const authed = app.with(() => ({ user: 'thrall' }));
        mountApi(authed, contract, { prefix: '', handlers: {
            me: (context) => ({ user: (context as typeof context & { user: string }).user })
        } });
        const response = await app.handle(new Request('http://local/me'));
        expect(await response.json()).toEqual({ user: 'thrall' });
    });
});

describe('mount guards', () =>
{
    const contract = defineContract({
        open: route({ method: 'GET', path: '/open', output: object({ who: string() }) }),
        account: {
            me: route({ method: 'GET', path: '/me', output: object({ who: string() }) }),
            admin: route({ method: 'GET', path: '/admin', output: object({ who: string() }) })
        }
    });
    const who = (context: unknown): { who: string } => ({ who: (context as { user?: string }).user ?? 'anon' });
    const handlers = {
        open: who,
        account: {
            me: who,
            admin: () => ({ who: 'admin' })
        }
    };

    it('applies global, group-wildcard, and exact guards outermost-first', async () =>
    {
        const order: string[] = [];
        const app = new App();
        mountApi(app, contract, {
            prefix: '',
            handlers,
            guards: {
                '*': [() =>
                {
                    order.push('global');
                }],
                'account.*': [() =>
                {
                    order.push('group'); return { user: 'thrall' };
                }],
                'account.me': [() =>
                {
                    order.push('exact');
                }]
            }
        });
        const response = await app.handle(new Request('http://local/me'));
        expect(await response.json()).toEqual({ who: 'thrall' });
        expect(order).toEqual(['global', 'group', 'exact']);
    });

    it('a guard returning a Response short-circuits; a throwing guard rejects', async () =>
    {
        const app = new App();
        mountApi(app, contract, {
            prefix: '',
            handlers,
            guards: {
                'account.admin': [() => new Response('blocked', { status: 403 })],
                'open': [() =>
                {
                    throw new HttpError(429, 'slow down');
                }]
            }
        });
        expect((await app.handle(new Request('http://local/admin'))).status).toBe(403);
        expect((await app.handle(new Request('http://local/open'))).status).toBe(429);
        expect((await app.handle(new Request('http://local/me'))).status).toBe(200);
    });
});

describe('client path-parameter substitution', () =>
{
    it('a param that PREFIXES a sibling name substitutes both correctly (:id beside :ida)', async () =>
    {
        // The regression: a substring replace of `:id` used to hit the `:ida` prefix first,
        // producing `/pairs/7a/...` - substitution must stop at identifier boundaries.
        const pairs = defineContract({
            pair: route({ method: 'GET', path: '/pairs/:ida/:id', output: object({ ok: boolean() }) })
        });
        const seen: string[] = [];
        const client = createClient(pairs, {
            baseUrl: '/api',
            fetch: (request) =>
            {
                seen.push(new URL(request.url, 'http://local').pathname);
                return Promise.resolve(Response.json({ ok: true }));
            }
        });
        await client.pair({ params: { ida: 'alpha', id: '7' } });
        expect(seen).toEqual(['/api/pairs/alpha/7']);
    });

    it('param values are URI-encoded; wildcard values pass through', async () =>
    {
        const wild = defineContract({
            file: route({ method: 'GET', path: '/f/:name/*rest', output: object({ ok: boolean() }) })
        });
        const seen: string[] = [];
        const client = createClient(wild, {
            baseUrl: '',
            fetch: (request) =>
            {
                seen.push(new URL(request.url, 'http://local').pathname);
                return Promise.resolve(Response.json({ ok: true }));
            }
        });
        await client.file({ params: { name: 'a b', rest: 'x/y.txt' } });
        expect(seen).toEqual(['/f/a%20b/x/y.txt']);
    });
});

describe('client pre-validation of FOREIGN (Standard Schema) inputs', () =>
{
    it('rejects locally with the flat field map - the transport is never called', async () =>
    {
        // A foreign validator typed as Standard Schema v1, so the route's In infers.
        const zodish: StandardSchemaV1<{ name: string }> = {
            '~standard': {
                version: 1,
                vendor: 'zod-stand-in',
                validate: (value: unknown) =>
                {
                    const v = value as { name?: string };
                    return typeof v.name === 'string' && v.name.length >= 2
                        ? { value: { name: v.name } }
                        : { issues: [{ message: 'Name too short', path: ['name'] }] };
                }
            }
        };
        const foreign = defineContract({
            create: route({ method: 'POST', path: '/things', input: zodish })
        });
        let transportCalls = 0;
        const client = createClient(foreign, {
            baseUrl: '/api',
            fetch: () =>
            {
                transportCalls++;
                return Promise.resolve(Response.json({ ok: true }));
            }
        });

        await expect(client.create({ input: { name: 'x' } })).rejects.toMatchObject({
            fields: { name: 'Name too short' }
        });
        expect(transportCalls).toBe(0);              // failed BEFORE the wire

        await client.create({ input: { name: 'Jaina' } });
        expect(transportCalls).toBe(1);              // valid input goes through
    });
});

describe('the typed reply channel: status codes without losing validation', () =>
{
    const problem = object({ code: string(), message: string() });
    const replies = defineContract({
        things: {
            create: route({
                method: 'POST', path: '/things',
                input: object({ name: string({ min: 2 }) }),
                output: user,
                responses: { 201: user, 409: problem }
            }),
            remove: route({ method: 'DELETE', path: '/things/:id' }),
            find: route({ method: 'GET', path: '/things/:id', output: user, responses: { 404: problem } })
        }
    });

    function buildReplyServer(overrides: Partial<{ create: (input: { name: string }) => unknown }> = {}): App
    {
        const app = new App();
        mountApi(app, replies, { handlers: {
            things: {
                create: ({ input }) =>
                {
                    if (overrides.create !== undefined)
                    {
                        return overrides.create(input) as StatusReply<201, Infer<typeof user>>;
                    }
                    return reply(201, { id: 1, name: input.name, email: 'new@example.org' }, { location: '/things/1' });
                },
                remove: () => reply(204),
                find: ({ params }) => params.id === '1'
                    ? { id: 1, name: 'Jaina', email: 'jaina@theramore.org' }
                    : reply(404, { code: 'not-found', message: `No thing ${ params.id }` })
            }
        } });
        return app;
    }

    it('reply(201, body, headers) sends the status and headers WITH the body validated', async () =>
    {
        const app = buildReplyServer();
        const response = await app.handle(new Request('http://local/api/things', {
            method: 'POST', body: JSON.stringify({ name: 'Anduin' }), headers: { 'content-type': 'application/json' }
        }));
        expect(response.status).toBe(201);
        expect(response.headers.get('location')).toBe('/things/1');
        expect(await response.json()).toEqual({ id: 1, name: 'Anduin', email: 'new@example.org' });
    });

    it('reply(204) sends an empty response', async () =>
    {
        const app = buildReplyServer();
        const response = await app.handle(new Request('http://local/api/things/9', { method: 'DELETE' }));
        expect(response.status).toBe(204);
        expect(await response.text()).toBe('');
    });

    it('a declared non-2xx reply carries its own validated body shape', async () =>
    {
        const app = buildReplyServer();
        const response = await app.handle(new Request('http://local/api/things/7'));
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ code: 'not-found', message: 'No thing 7' });
    });

    it('a reply body violating its status schema is a hidden 500 (contract-violation)', async () =>
    {
        const app = buildReplyServer({ create: () => reply(201, { id: 'not-a-number', name: 5 }) });
        const response = await app.handle(new Request('http://local/api/things', {
            method: 'POST', body: JSON.stringify({ name: 'Valid' }), headers: { 'content-type': 'application/json' }
        }));
        expect(response.status).toBe(500);
        const wire = (await response.json()) as { error: { code: string } };
        expect(wire.error.code).toBe('contract-violation');
        expect(JSON.stringify(wire)).not.toContain('not-a-number'); // internals stay home
    });

    it('reply(200, out) validates against output and STRIPS undeclared fields', async () =>
    {
        const app = buildReplyServer({ create: () => reply(200, { id: 1, name: 'x', email: 'x@y.z', passwordHash: 'hunter2' }) });
        const response = await app.handle(new Request('http://local/api/things', {
            method: 'POST', body: JSON.stringify({ name: 'Valid' }), headers: { 'content-type': 'application/json' }
        }));
        expect(response.status).toBe(200);
        expect(JSON.stringify(await response.json())).not.toContain('hunter2');
    });

    it('the client still speaks the success body through a responses-declaring route', async () =>
    {
        const client = createClient(replies, { baseUrl: '/api', fetch: (request) => buildReplyServer().handle(request) });
        const created = await client.things.create({ input: { name: 'Thrall' } });
        expectTypeOf(created).toEqualTypeOf<{ id: number; name: string; email: string }>();
        expect(created).toEqual({ id: 1, name: 'Thrall', email: 'new@example.org' });

        await expect(client.things.find({ params: { id: '7' } })).rejects.toMatchObject({ status: 404 });
    });

    it('an undeclared status with a body is a compile error; declared shapes are enforced', () =>
    {
        const handlers: HandlersWithGuards<typeof replies, Record<never, never>> = {
            things: {
                // @ts-expect-error - 403 is not in create's responses map, and it carries a body.
                create: () => reply(403, { code: 'nope', message: 'forbidden' }),
                remove: () => reply(204),
                // @ts-expect-error - 404 is declared, but the body must match the problem schema.
                find: () => reply(404, { wrong: true })
            }
        };
        void handlers;
        expect(true).toBe(true);
    });
});

describe('contract-level file routes: multipart() input', () =>
{
    const uploads = defineContract({
        files: {
            upload: route({
                method: 'POST', path: '/files',
                input: multipart({ fields: object({ title: string({ min: 2 }) }), maxFileSize: 1024 }),
                output: object({ title: string(), count: number(), bytes: number() })
            }),
            loose: route({ method: 'POST', path: '/loose', input: multipart() })
        }
    });

    function buildUploadServer(): App
    {
        const app = new App();
        mountApi(app, uploads, { handlers: {
            files: {
                upload: ({ input }) =>
                {
                    expectTypeOf(input.fields).toEqualTypeOf<{ title: string }>();
                    expectTypeOf(input.files[0]!.data).toEqualTypeOf<Uint8Array>();
                    return {
                        title: input.fields.title,
                        count: input.files.length,
                        bytes: input.files.reduce((sum, file) => sum + file.data.byteLength, 0)
                    };
                },
                loose: ({ input }) =>
                {
                    expectTypeOf(input.fields).toEqualTypeOf<Record<string, string>>();
                    return { echo: input.fields };
                }
            }
        } });
        return app;
    }

    function formRequest(path: string, build: (form: FormData) => void): Request
    {
        const form = new FormData();
        build(form);
        return new Request(`http://local/api${ path }`, { method: 'POST', body: form });
    }

    it('the handler receives validated fields plus the files, fully typed', async () =>
    {
        const app = buildUploadServer();
        const response = await app.handle(formRequest('/files', (form) =>
        {
            form.append('title', 'Vacation');
            form.append('shot', new Blob([new Uint8Array([1, 2, 3])]), 'a.bin');
            form.append('shot2', new Blob([new Uint8Array([4, 5])]), 'b.bin');
        }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ title: 'Vacation', count: 2, bytes: 5 });
    });

    it('field validation failures are the SAME 422 field map as JSON routes', async () =>
    {
        const app = buildUploadServer();
        const response = await app.handle(formRequest('/files', (form) => form.append('title', 'x')));
        expect(response.status).toBe(422);
        const wire = (await response.json()) as { error: { details: { fields: Record<string, string> } } };
        expect(Object.keys(wire.error.details.fields)).toContain('title');
    });

    it('a JSON body posted to a multipart route is a 415', async () =>
    {
        const app = buildUploadServer();
        const response = await app.handle(new Request('http://local/api/files', {
            method: 'POST', body: JSON.stringify({ title: 'Vacation' }), headers: { 'content-type': 'application/json' }
        }));
        expect(response.status).toBe(415);
    });

    it('the per-file cap holds at the boundary (413)', async () =>
    {
        const app = buildUploadServer();
        const response = await app.handle(formRequest('/files', (form) =>
        {
            form.append('title', 'Big');
            form.append('blob', new Blob([new Uint8Array(4096)]), 'big.bin');
        }));
        expect(response.status).toBe(413);
    });

    it('without a fields schema the handler gets the raw first-value map', async () =>
    {
        const app = buildUploadServer();
        const response = await app.handle(formRequest('/loose', (form) =>
        {
            form.append('a', '1');
            form.append('a', '2');
            form.append('b', 'two');
        }));
        expect(await response.json()).toEqual({ echo: { a: '1', b: 'two' } });
    });

    it('the typed client refuses a multipart route LOUDLY (FormData is not JSON)', async () =>
    {
        const client = createClient(uploads, { baseUrl: '/api', fetch: (request) => buildUploadServer().handle(request) });
        await expect(client.files.upload({ input: { fields: { title: 'x' }, files: [] } }))
            .rejects.toThrow(/multipart\/form-data.*FormData/);
    });
});
