// @vitest-environment node
//
// The API layer the way real apps use it: one feature module, a server registering it on a
// real App, and a client whose transport is `app.handle` - the whole round trip in process,
// no sockets, full inference end to end.
import { describe, it, expect, expectTypeOf } from 'vitest';
import { object, string, number, boolean } from '@azerothjs/schema';
import { App } from '../../src/app.ts';
import { noContent } from '../../src/respond.ts';
import { feature, manifestOf } from '../../src/api/feature.ts';
import { register } from '../../src/api/register.ts';
import { createClient } from '../../src/api/client.ts';

const user = object({ id: number({ int: true }), name: string(), email: string() });

const users = feature('/users', (routes) => ({
    read: routes.get('/:id', { output: user }, ({ params }) =>
    {
        expectTypeOf(params.id).toEqualTypeOf<string>();
        return { id: Number(params.id), name: 'IntelligentQuantum', email: 'intelligentquantum@example.org' };
    }),
    list: routes.get('/', {
        query: object({ limit: number({ coerce: true, int: true, min: 1 }).optional(), admin: boolean({ coerce: true }).optional() }),
        output: object({ total: number(), names: string() })
    }, ({ query }) =>
    {
        expectTypeOf(query.limit).toEqualTypeOf<number | undefined>();
        return { total: query.limit ?? 10, names: query.admin === true ? 'admins' : 'all' };
    }),
    create: routes.post('/', { input: object({ name: string({ min: 2 }) }), output: user },
        ({ input }) => ({ id: 7, name: input.name, email: 'new@example.org' })),
    remove: routes.del('/:id', {}, () => noContent()),
    // The route param that PREFIXES a sibling name - substitution must be boundary-anchored.
    compare: routes.get('/:id/vs/:ida', { output: object({ left: string(), right: string() }) },
        ({ params }) => ({ left: params.id, right: params.ida }))
}));

const api = { users };

function serve(): App
{
    const app = new App();
    register(app, api);
    return app;
}

describe('the two-sided round trip', () =>
{
    it('typed calls flow through params, query, input, and output', async () =>
    {
        const app = serve();
        const client = createClient<typeof api>(manifestOf(api), { baseUrl: '/api', fetch: (request) => app.handle(request) });

        const read = await client.users.read({ params: { id: '3' } });
        expectTypeOf(read).toEqualTypeOf<{ id: number; name: string; email: string }>();
        expect(read.id).toBe(3);

        const listed = await client.users.list({ query: { limit: 2, admin: true } });
        expect(listed).toEqual({ total: 2, names: 'admins' });

        const created = await client.users.create({ input: { name: 'IntelligentQuantum' } });
        expect(created.name).toBe('IntelligentQuantum');
    });

    it('a raw Response passes through (204 becomes undefined client-side)', async () =>
    {
        const app = serve();
        const client = createClient<typeof api>(manifestOf(api), { baseUrl: '/api', fetch: (request) => app.handle(request) });
        await expect(client.users.remove({ params: { id: '3' } })).resolves.toBeUndefined();
    });

    it('a param that PREFIXES a sibling name substitutes both correctly (:id beside :ida)', async () =>
    {
        const app = serve();
        const client = createClient<typeof api>(manifestOf(api), { baseUrl: '/api', fetch: (request) => app.handle(request) });
        const compared = await client.users.compare({ params: { id: 'left-value', ida: 'right-value' } });
        expect(compared).toEqual({ left: 'left-value', right: 'right-value' });
    });

    it('a forged request (bypassing the client) is rejected server-side with the field map', async () =>
    {
        const app = serve();
        const response = await app.handle(new Request('http://local/api/users', {
            method: 'POST', body: JSON.stringify({ name: 'x' }), headers: { 'content-type': 'application/json' }
        }));
        expect(response.status).toBe(422);
        const wire = await response.json() as { error: { details: { fields: Record<string, string> } } };
        expect(wire.error.details.fields['name']).toContain('at least 2');
    });

    it('output STRIPS undeclared fields - accidental leaks die at the boundary', async () =>
    {
        const app = new App();
        register(app, {
            leaky: feature('/leaky', (routes) => ({
                read: routes.get('/', { output: object({ id: number() }) },
                    () => ({ id: 1, passwordHash: 'hunter2' }))
            }))
        });
        const response = await app.handle(new Request('http://local/api/leaky'));
        expect(JSON.stringify(await response.json())).not.toContain('hunter2');
    });

    it('a handler behind app-scoped middleware reads what the middleware attached at runtime', async () =>
    {
        const app = new App().with(() => ({ tenant: 'acme' }));
        register(app, {
            probe: feature('/probe', (routes) => ({
                read: routes.get('/', {}, (context) => ({ tenant: (context as unknown as { tenant: string }).tenant }))
            }))
        });
        const response = await app.handle(new Request('http://local/api/probe'));
        expect(await response.json()).toEqual({ tenant: 'acme' });
    });
});
