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
import { reply, type Feature, type StatusReply } from '../../src/api/declare.ts';

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
            find: routes.get('/:id', { output: user, responses: { 409: problem } }, () => reply(409, { wrong: true })),
            // @ts-expect-error - no responses map at all: the return must not declare 202 for the route.
            accepted: routes.post('/accepted', { output: user }, () => reply(202, { id: 1, name: 'x', email: 'x@y.z' })),
            // @ts-expect-error - the same on a form route.
            upload: routes.form('/upload', { output: user }, () => reply(202, { id: 1, name: 'x', email: 'x@y.z' })),
            ok: routes.post('/ok', { output: user }, () => reply(200, { id: 1, name: 'x', email: 'x@y.z' })),
            gone: routes.post('/gone', { output: user }, () => reply(204)),
            bare: routes.get('/bare', {}, () => reply(200, { id: 1, secret: 's' }, { 'cache-control': 'no-store' })),
            declared: routes.post('/declared', { output: user, responses: { 202: user } }, () => reply(202, { id: 1, name: 'x', email: 'x@y.z' }))
        }));
        expect(true).toBe(true);
    });
});

describe('a reply at a status the route never declared', () =>
{
    const leak = { id: 1, name: 'x', email: 'x@y.z', passwordHash: 'hunter2' };

    function build(things: Feature): { app: App; errors: string[] }
    {
        const errors: string[] = [];
        const app = new App({ onError: (error) =>
        {
            errors.push(error instanceof Error ? error.message : String(error));
        } });
        register(app, { things });
        return { app, errors };
    }

    it('Regression: reply(202, body) on a route with only output ships the body unvalidated', async () =>
    {
        const { app, errors } = build(feature('/things', (routes) => ({
            accepted: routes.get('/accepted', { output: user }, () => reply(202, leak) as never)
        })));
        const response = await app.handle(new Request('http://local/api/things/accepted'));
        const wire = await response.text();

        expect(response.status).toBe(500);
        expect((JSON.parse(wire) as { error: { code: string } }).error.code).toBe('contract-violation');
        expect(wire).not.toContain('hunter2');
        expect(wire).not.toContain('passwordHash');
        expect(errors.join(' ')).toContain('202');
        expect(errors.join(' ')).toContain('responses');
    });

    it('any undeclared status is refused the same way, a body of null included', async () =>
    {
        const { app } = build(feature('/things', (routes) => ({
            missing: routes.get('/missing', { output: user }, () => reply(404, leak) as never),
            nothing: routes.get('/nothing', { output: user }, () => reply(202, null) as never)
        })));

        expect((await app.handle(new Request('http://local/api/things/missing'))).status).toBe(500);
        expect((await app.handle(new Request('http://local/api/things/nothing'))).status).toBe(500);
    });

    it('reply(200, body, headers) on a route that declares nothing passes through, as a plain return does', async () =>
    {
        const { app, errors } = build(feature('/things', (routes) => ({
            bare: routes.get('/bare', {}, () => reply(200, leak, { 'cache-control': 'no-store' })),
            other: routes.get('/other', { responses: { 201: user } }, () => reply(200, leak, { 'cache-control': 'no-store' }))
        })));
        for (const path of ['/api/things/bare', '/api/things/other'])
        {
            const response = await app.handle(new Request(`http://local${ path }`));
            expect(response.status).toBe(200);
            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(await response.json()).toEqual(leak);
        }
        expect(errors).toEqual([]);
    });

    it('a bodyless reply is empty at any status, and a declared status still strips', async () =>
    {
        const { app } = build(feature('/things', (routes) => ({
            teapot: routes.get('/teapot', { output: user }, () => reply(418)),
            declared: routes.get('/declared', { output: user, responses: { 202: user } }, () => reply(202, leak as never))
        })));
        const teapot = await app.handle(new Request('http://local/api/things/teapot'));
        expect(teapot.status).toBe(418);
        expect(await teapot.text()).toBe('');

        const declared = await app.handle(new Request('http://local/api/things/declared'));
        expect(declared.status).toBe(202);
        expect(await declared.text()).not.toContain('hunter2');
    });
});
