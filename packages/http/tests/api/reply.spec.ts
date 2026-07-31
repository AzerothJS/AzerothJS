// @vitest-environment node
//
// The typed reply channel: status codes and headers without losing output validation.
// `responses[status]` declares each shape; `output` doubles as the 200 entry; a reply body
// violating its status schema is a hidden 500 - internals never cross the wire.
import { describe, it, expect, expectTypeOf } from 'vitest';
import { object, string, number, type Infer } from '@azerothjs/schema';
import { App } from '../../src/app.ts';
import { feature, manifestOf } from '../../src/api/feature.ts';
import { register } from '../../src/api/register.ts';
import { createClient } from '../../src/api/client.ts';
import { reply, type StatusReply } from '../../src/api/declare.ts';

const user = object({ id: number({ int: true }), name: string(), email: string() });
const problem = object({ code: string(), message: string() });

function buildApi(overrides: Partial<{ create: (input: { name: string }) => unknown }> = {})
{
    return {
        things: feature('/things', (routes) => ({
            create: routes.post('/', {
                input: object({ name: string({ min: 2 }) }),
                output: user,
                responses: { 201: user, 409: problem }
            }, ({ input }) =>
            {
                if (overrides.create !== undefined)
                {
                    return overrides.create(input) as StatusReply<201, Infer<typeof user>>;
                }
                return reply(201, { id: 1, name: input.name, email: 'new@example.org' }, { location: '/things/1' });
            }),
            remove: routes.del('/:id', {}, () => reply(204)),
            find: routes.get('/:id', { output: user, responses: { 404: problem } }, ({ params }) => params.id === '1'
                ? { id: 1, name: 'IntelligentQuantum', email: 'intelligentquantum@example.org' }
                : reply(404, { code: 'not-found', message: `No thing ${ params.id }` }))
        }))
    };
}

function serve(api: ReturnType<typeof buildApi>): App
{
    const app = new App();
    register(app, api);
    return app;
}

describe('the typed reply channel', () =>
{
    it('reply(201, body, headers) sends the status and headers WITH the body validated', async () =>
    {
        const response = await serve(buildApi()).handle(new Request('http://local/api/things', {
            method: 'POST', body: JSON.stringify({ name: 'IntelligentQuantum' }), headers: { 'content-type': 'application/json' }
        }));
        expect(response.status).toBe(201);
        expect(response.headers.get('location')).toBe('/things/1');
        expect(await response.json()).toEqual({ id: 1, name: 'IntelligentQuantum', email: 'new@example.org' });
    });

    it('reply(204) sends an empty response', async () =>
    {
        const response = await serve(buildApi()).handle(new Request('http://local/api/things/9', { method: 'DELETE' }));
        expect(response.status).toBe(204);
        expect(await response.text()).toBe('');
    });

    it('a declared non-2xx reply carries its own validated body shape', async () =>
    {
        const response = await serve(buildApi()).handle(new Request('http://local/api/things/7'));
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ code: 'not-found', message: 'No thing 7' });
    });

    it('a reply body violating its status schema is a hidden 500 (contract-violation)', async () =>
    {
        const response = await serve(buildApi({ create: () => reply(201, { id: 'not-a-number', name: 5 }) }))
            .handle(new Request('http://local/api/things', {
                method: 'POST', body: JSON.stringify({ name: 'Valid' }), headers: { 'content-type': 'application/json' }
            }));
        expect(response.status).toBe(500);
        const wire = (await response.json()) as { error: { code: string } };
        expect(wire.error.code).toBe('contract-violation');
        expect(JSON.stringify(wire)).not.toContain('not-a-number'); // internals stay home
    });

    it('reply(200, out) validates against output and STRIPS undeclared fields', async () =>
    {
        const response = await serve(buildApi({ create: () => reply(200, { id: 1, name: 'x', email: 'x@y.z', passwordHash: 'hunter2' }) }))
            .handle(new Request('http://local/api/things', {
                method: 'POST', body: JSON.stringify({ name: 'Valid' }), headers: { 'content-type': 'application/json' }
            }));
        expect(response.status).toBe(200);
        expect(JSON.stringify(await response.json())).not.toContain('hunter2');
    });

    it('a PLAIN 200 return validates against a responses-only 200 schema (no output)', async () =>
    {
        const build = (value: unknown): App =>
        {
            const app = new App();
            register(app, {
                things: feature('/peek', (routes) => ({
                    peek: routes.get('/', { responses: { 200: object({ id: number({ int: true }) }) } }, () => value as { id: number })
                }))
            });
            return app;
        };
        const ok = await build({ id: 7, secret: 'hunter2' }).handle(new Request('http://local/api/peek'));
        expect(ok.status).toBe(200);
        expect(JSON.stringify(await ok.json())).not.toContain('hunter2'); // responses[200] IS the 200 contract
        const broken = await build({ id: 'not-a-number' }).handle(new Request('http://local/api/peek'));
        expect(broken.status).toBe(500);
        expect(((await broken.json()) as { error: { code: string } }).error.code).toBe('contract-violation');
    });

    it('the client still speaks the success body through a responses-declaring route', async () =>
    {
        const api = buildApi();
        const client = createClient<typeof api>(manifestOf(api), { baseUrl: '/api', fetch: (request) => serve(api).handle(request) });
        const created = await client.things.create({ input: { name: 'IntelligentQuantum' } });
        expectTypeOf(created).toEqualTypeOf<{ id: number; name: string; email: string }>();
        expect(created).toEqual({ id: 1, name: 'IntelligentQuantum', email: 'new@example.org' });

        await expect(client.things.find({ params: { id: '7' } })).rejects.toMatchObject({ status: 404 });
    });

    it('an undeclared status with a body is a compile error; declared shapes are enforced', () =>
    {
        feature('/typed', (routes) => ({
            // @ts-expect-error - 403 is not in the responses map, and it carries a body.
            create: routes.post('/', { output: user, responses: { 409: problem } }, () => reply(403, { code: 'nope', message: 'forbidden' })),
            // @ts-expect-error - 409 is declared, but the body must match the problem schema.
            find: routes.get('/:id', { output: user, responses: { 409: problem } }, () => reply(409, { wrong: true }))
        }));
        expect(true).toBe(true);
    });
});
