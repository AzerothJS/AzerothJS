// @vitest-environment node
//
// The contract's third exporter. Every MAPPING.md row is pinned here; the document
// as a whole is checked by a real OpenAPI 3.1 validator (dev-only dependency - the
// shipped exporter has none); determinism is asserted as byte equality, because a
// spec that diffs cleanly in CI is one of the design's promises.

import { describe, it, expect } from 'vitest';
import { Validator } from '@seriousme/openapi-schema-validator';
import { object, string, number, boolean, array, literal, enumOf, record, union } from '@azerothjs/schema';
import { App } from '@azerothjs/http';
import { defineContract, route, get, post, put, patch, del, query, toOpenApi, openapiPlugin, uncontracted, mountApi } from '@azerothjs/api';

const INFO = { title: 'Test API', version: '1.0.0' };

function schemaOf(document: Record<string, unknown>, path: string, method: string): Record<string, unknown>
{
    const paths = document.paths as Record<string, Record<string, unknown>>;
    const operation = paths[path]?.[method] as Record<string, unknown>;
    const body = operation.requestBody as { content: Record<string, { schema: Record<string, unknown> }> };
    return body.content['application/json']!.schema;
}

describe('schema -> JSON Schema mapping (MAPPING.md rows)', () =>
{
    const contract = defineContract({
        probe: route({
            method: 'POST',
            path: '/probe',
            input: object({
                email: string({ format: 'email', nonempty: true }),
                id: string({ format: 'uuid' }),
                when: string({ format: 'datetime' }),
                code: string({ min: 2, max: 8, pattern: /^[A-Z]+$/ }),
                age: number({ min: 18, max: 130, int: true }),
                score: number(),
                active: boolean(),
                kind: literal('user'),
                role: enumOf(['admin', 'member']),
                tags: array(string(), { min: 1, max: 5 }),
                extras: record(number()),
                idOrIndex: union([string(), number()]),
                strong: string().refine(() => null, { code: 'strong-password' }),
                note: string().optional()
            })
        })
    });
    const document = toOpenApi(contract, { info: INFO });
    const body = schemaOf(document, '/api/probe', 'post');
    const properties = body.properties as Record<string, Record<string, unknown>>;

    it('strings carry length, pattern, and format truthfully', () =>
    {
        expect(properties.email).toMatchObject({ type: 'string', format: 'email', minLength: 1 });
        expect(properties.id).toMatchObject({ type: 'string', format: 'uuid' });
        expect(properties.when).toMatchObject({ type: 'string', format: 'date-time' });
        expect(properties.code).toMatchObject({ type: 'string', minLength: 2, maxLength: 8, pattern: '^[A-Z]+$' });
    });

    it('numbers distinguish integer and carry bounds; booleans are booleans', () =>
    {
        expect(properties.age).toEqual({ type: 'integer', minimum: 18, maximum: 130 });
        expect(properties.score).toEqual({ type: 'number' });
        expect(properties.active).toEqual({ type: 'boolean' });
    });

    it('literal is const; enum lists its values', () =>
    {
        expect(properties.kind).toEqual({ const: 'user' });
        expect(properties.role).toEqual({ type: 'string', enum: ['admin', 'member'] });
    });

    it('array, record, and union map structurally', () =>
    {
        expect(properties.tags).toMatchObject({ type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } });
        expect(properties.extras).toEqual({ type: 'object', additionalProperties: { type: 'number' } });
        expect(properties.idOrIndex).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] });
    });

    it('a refinement degrades to an honest description note, never an invented constraint', () =>
    {
        const strong = properties.strong ?? {};
        expect(strong.type).toBe('string');
        expect(String(strong.description)).toContain('strong-password');
        expect(Object.keys(strong)).not.toContain('pattern');
    });

    it('optional fields leave the required list; the object seals extras', () =>
    {
        expect(body.additionalProperties).toBe(false);
        expect(body.required).not.toContain('note');
        expect(body.required).toContain('email');
    });
});

describe('route derivation', () =>
{
    const output = object({ id: string(), name: string() });
    const contract = defineContract({
        users: {
            list: route({ method: 'GET', path: '/users', query: object({ page: number({ coerce: true }).optional(), q: string() }), output: array(output) }),
            get: route({ method: 'GET', path: '/users/:id', output }),
            create: route({
                method: 'POST',
                path: '/users',
                input: object({ name: string({ nonempty: true }) }),
                output,
                docs: {
                    summary: 'Create a user',
                    deprecated: true,
                    errors: [{ status: 409, code: 'exists', description: 'Name taken' }],
                    security: ['bearer']
                }
            }),
            files: route({ method: 'GET', path: '/users/:id/files/*rest' })
        },
        health: route({ method: 'GET', path: '/healthz' }),
        search: route({ method: 'QUERY', path: '/search', input: object({ text: string() }) })
    });
    const document = toOpenApi(contract, {
        info: INFO,
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }
    });
    const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;

    it('derives operation ids and tags from the tree; top-level routes stay untagged', () =>
    {
        expect(paths['/api/users']!.get!.operationId).toBe('users.list');
        expect(paths['/api/users']!.get!.tags).toEqual(['users']);
        expect(paths['/api/healthz']!.get!.operationId).toBe('health');
        expect(paths['/api/healthz']!.get!.tags).toBeUndefined();
    });

    it('converts :name and *name params, marking wildcards', () =>
    {
        const params = paths['/api/users/{id}/files/{rest}']!.get!.parameters as Array<Record<string, unknown>>;
        expect(params[0]).toMatchObject({ name: 'id', in: 'path', required: true });
        expect(String(params[1]!.description)).toContain('Wildcard');
    });

    it('query object fields become query parameters with honest requiredness', () =>
    {
        const params = paths['/api/users']!.get!.parameters as Array<Record<string, unknown>>;
        const page = params.find((p) => p.name === 'page');
        const q = params.find((p) => p.name === 'q');
        expect(page).toMatchObject({ in: 'query', required: false });
        expect(q).toMatchObject({ in: 'query', required: true });
    });

    it('framework error responses appear exactly where mountApi produces them', () =>
    {
        const create = paths['/api/users']!.post!.responses as Record<string, unknown>;
        expect(Object.keys(create).sort()).toEqual(['200', '409', '415', '422', '500']);
        const files = paths['/api/users/{id}/files/{rest}']!.get!.responses as Record<string, unknown>;
        expect(Object.keys(files)).toEqual(['200']); // no input/query/output -> no derived errors
    });

    it('docs enrich without inventing: summary, deprecated, declared errors, security', () =>
    {
        const create = paths['/api/users']!.post!;
        expect(create.summary).toBe('Create a user');
        expect(create.deprecated).toBe(true);
        expect(create.security).toEqual([{ bearer: [] }]);
        const conflict = (create.responses as Record<string, Record<string, unknown>>)['409'];
        expect(conflict!.description).toBe('Name taken');
    });

    it('QUERY routes are excluded from paths and listed machine-readably', () =>
    {
        expect(paths['/api/search']).toBeUndefined();
        const skipped = document['x-azerothjs-query'] as Array<Record<string, unknown>>;
        expect(skipped[0]).toMatchObject({ name: 'search', path: '/api/search' });
    });

    it('a shared output instance becomes one named component; single-use stays inline', () =>
    {
        const components = (document.components as Record<string, Record<string, unknown>>).schemas!;
        expect(components.UsersGetOutput).toMatchObject({ type: 'object' });
        const get = paths['/api/users/{id}']!.get!.responses as Record<string, Record<string, unknown>>;
        expect((get['200']!.content as Record<string, Record<string, unknown>>)['application/json']!.schema)
            .toEqual({ $ref: '#/components/schemas/UsersGetOutput' });
        const createBody = schemaOf(document, '/api/users', 'post');
        expect(createBody.$ref).toBeUndefined(); // create's input is used once - inline
    });

    it('two builds are byte-identical (the CI-diff promise)', () =>
    {
        const again = toOpenApi(contract, { info: INFO, securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } });
        expect(JSON.stringify(again)).toBe(JSON.stringify(document));
    });

    it('the document validates as OpenAPI 3.1', async () =>
    {
        const result = await new Validator().validate(JSON.parse(JSON.stringify(document)) as Record<string, unknown>);
        expect(result.errors ?? []).toEqual([]);
        expect(result.valid).toBe(true);
    });
});

describe('serving and coverage', () =>
{
    const contract = defineContract({ health: route({ method: 'GET', path: '/healthz' }) });

    it('openapiPlugin serves the cached document as JSON', async () =>
    {
        const app = new App().register(openapiPlugin({ contract, info: INFO }));
        const response = await app.handle(new Request('http://local/openapi.json'));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');
        const document = await response.json() as Record<string, unknown>;
        expect(document.openapi).toBe('3.1.0');
    });

    it('uncontracted lists exactly the routes the contract does not cover', () =>
    {
        const app = new App();
        app.get('/api/healthz', () => new Response('ok'));
        app.get('/internal/metrics', () => new Response('m'));
        const uncovered = uncontracted(app, contract);
        expect(uncovered).toHaveLength(1);
        expect(uncovered[0]).toContain('/internal/metrics');
    });
});

describe('the docs page', () =>
{
    const contract = defineContract({ health: route({ method: 'GET', path: '/healthz' }) });

    it('defaults to the Scalar shell: tiny page, viewer from the CDN, spec URL wired', async () =>
    {
        const app = new App().register(openapiPlugin({ contract, info: INFO }));
        const response = await app.handle(new Request('http://local/docs'));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');
        const html = await response.text();
        expect(html).toContain('cdn.jsdelivr.net/npm/@scalar/api-reference');
        expect(html).toContain("url: '/openapi.json'");
    });

    it("viewer: 'azeroth' serves the fully self-contained house explorer", async () =>
    {
        const app = new App().register(openapiPlugin({ contract, info: INFO, viewer: 'azeroth' }));
        const html = await (await app.handle(new Request('http://local/docs'))).text();
        expect(html).toContain('Test API');
        expect(html).toContain('/openapi.json');
        // Self-contained: no external resource may be referenced.
        expect(html).not.toMatch(/src="http|href="http|https:\/\//);
    });

    it('docs: false keeps the plugin spec-only', async () =>
    {
        const app = new App().register(openapiPlugin({ contract, info: INFO, docs: false }));
        const response = await app.handle(new Request('http://local/docs'));
        expect(response.status).toBe(404);
    });

    it('escapes a hostile title in both viewers', async () =>
    {
        for (const viewer of ['scalar', 'azeroth'] as const)
        {
            const app = new App().register(openapiPlugin({ contract, info: { title: '<script>alert(1)</script>', version: '1' }, viewer }));
            const html = await (await app.handle(new Request('http://local/docs'))).text();
            expect(html).not.toContain('<script>alert');
            expect(html).toContain('&lt;script&gt;');
        }
    });
});

describe('errorSchema: the spec tells the truth about custom envelopes', () =>
{
    it('a declared error envelope replaces the default in components and refs', () =>
    {
        const custom = object({ success: boolean(), code: string(), field: string() });
        const contract = defineContract({
            ping: route({ method: 'POST', path: '/ping', input: object({ x: string() }) })
        });
        const document = toOpenApi(contract, { info: INFO, errorSchema: custom });
        const components = (document.components as Record<string, Record<string, Record<string, unknown>>>).schemas!;
        expect(Object.keys(components.ErrorResponse!.properties as object)).toEqual(['success', 'code', 'field']);
        const responses = (document.paths as Record<string, Record<string, Record<string, unknown>>>)['/api/ping']!.post!.responses as Record<string, Record<string, unknown>>;
        expect(JSON.stringify(responses['422'])).toContain('#/components/schemas/ErrorResponse');
    });
});

describe('method sugar', () =>
{
    it('the factories are byte-equivalent to route() in the derived document', async () =>
    {
        const output = object({ id: number() });
        const viaSugar = defineContract({
            users: {
                list: get('/users', { output: array(output) }),
                create: post('/users', { input: object({ name: string() }), output }),
                update: patch('/users/:id', { input: object({ name: string() }), output }),
                replace: put('/users/:id', { input: object({ name: string() }), output }),
                remove: del('/users/:id'),
                search: query('/users/search', { input: object({ q: string() }) })
            }
        });
        const viaRoute = defineContract({
            users: {
                list: route({ method: 'GET', path: '/users', output: array(output) }),
                create: route({ method: 'POST', path: '/users', input: object({ name: string() }), output }),
                update: route({ method: 'PATCH', path: '/users/:id', input: object({ name: string() }), output }),
                replace: route({ method: 'PUT', path: '/users/:id', input: object({ name: string() }), output }),
                remove: route({ method: 'DELETE', path: '/users/:id' }),
                search: route({ method: 'QUERY', path: '/users/search', input: object({ q: string() }) })
            }
        });
        expect(JSON.stringify(toOpenApi(viaSugar, { info: INFO })))
            .toBe(JSON.stringify(toOpenApi(viaRoute, { info: INFO })));
        expect(await new Validator().validate(JSON.parse(JSON.stringify(toOpenApi(viaSugar, { info: INFO }))) as Record<string, unknown>)
            .then((r) => r.valid)).toBe(true);
    });
});

describe('Standard Schema interop (bring your own validator)', () =>
{
    // A minimal `~standard` validator, exactly the shape Zod/Valibot expose.
    const zodLikeName = {
        '~standard': {
            version: 1 as const,
            vendor: 'test',
            validate: (value: unknown) =>
                (typeof value === 'object' && value !== null && typeof (value as { name?: unknown }).name === 'string' && (value as { name: string }).name !== ''
                    ? { value: value as { name: string } }
                    : { issues: [{ message: 'name is required', path: ['name'] }] })
        }
    };

    const contract = defineContract({
        create: post('/things', { input: zodLikeName, output: object({ id: number() }) })
    });

    it('a foreign validator validates the boundary (422 on bad input)', async () =>
    {
        const app = new App();
        mountApi(app, contract, { prefix: '', handlers: { create: () => ({ id: 1 }) } });
        const ok = await app.handle(new Request('http://local/things', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'widget' })
        }));
        expect(ok.status).toBe(200);
        const bad = await app.handle(new Request('http://local/things', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '' })
        }));
        expect(bad.status).toBe(422);
        expect(((await bad.json()) as { error: { details: { fields: Record<string, string> } } }).error.details.fields.name).toBe('name is required');
    });

    it('a foreign input degrades to the permissive spec shape (honest, documented)', () =>
    {
        const document = toOpenApi(contract, { info: INFO });
        const body = schemaOf(document, '/api/things', 'post');
        expect(String(body.description)).toContain('custom rule'); // permissive fallback, not fabricated
    });
});
