// @vitest-environment node
//
// The feature record's third exporter. Every MAPPING.md row is pinned here; the document
// as a whole is checked by a real OpenAPI 3.1 validator (dev-only dependency - the
// shipped exporter has none); determinism is asserted as byte equality, because a
// spec that diffs cleanly in CI is one of the design's promises. NEW under the colocated
// design: raw, stream, and form routes appear in `paths` - the routes the old contract
// silently omitted - and `uncontracted` counts them as covered.

import { describe, it, expect } from 'vitest';
import { Validator } from '@seriousme/openapi-schema-validator';
import { object, string, number, boolean, date, array, literal, enumOf, record, union } from '@azerothjs/schema';
import { App } from '../../src/app.ts';
import { feature } from '../../src/api/feature.ts';
import { register } from '../../src/api/register.ts';
import { toOpenApi, openapiPlugin, uncontracted } from '../../src/api/openapi.ts';

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
    const api = {
        probe: feature('/probe', (routes) => ({
            run: routes.post('/', {
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
            }, () => ({}))
        }))
    };
    const document = toOpenApi(api, { info: INFO });
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

    it('date maps to string with date-time format', () =>
    {
        const dated = {
            probe: feature('/probe', (routes) => ({
                run: routes.post('/', { input: object({ at: date(), bounded: date({ min: new Date('2026-01-01T00:00:00Z') }) }) }, () => ({}))
            }))
        };
        const doc = toOpenApi(dated, { info: INFO });
        const props = schemaOf(doc, '/api/probe', 'post').properties as Record<string, Record<string, unknown>>;
        expect(props.at).toEqual({ type: 'string', format: 'date-time' });
        expect(props.bounded).toMatchObject({ type: 'string', format: 'date-time' });
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
    const api = {
        users: feature('/users', (routes) => ({
            list: routes.get('/', { query: object({ page: number({ coerce: true }).optional(), q: string() }), output: array(output) }, () => []),
            get: routes.get('/:id', { output }, () => ({ id: '1', name: 'x' })),
            create: routes.post('/', {
                input: object({ name: string({ nonempty: true }) }),
                output,
                docs: {
                    summary: 'Create a user',
                    deprecated: true,
                    errors: [{ status: 409, code: 'exists', description: 'Name taken' }],
                    security: ['bearer']
                }
            }, ({ input }) => ({ id: '1', name: input.name })),
            files: routes.raw('GET', '/:id/files/*rest', {}, () => new Response('bytes')),
            events: routes.stream('/:id/events', { events: ['changed'] }, () => undefined)
        })),
        search: feature('/search', (routes) => ({
            run: routes.query('/', { input: object({ text: string() }) }, () => ({}))
        }))
    };
    const document = toOpenApi(api, {
        info: INFO,
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }
    });
    const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;

    it('derives operation ids and tags from the record keys', () =>
    {
        expect(paths['/api/users']!.get!.operationId).toBe('users.list');
        expect(paths['/api/users']!.get!.tags).toEqual(['users']);
    });

    it('raw and stream routes APPEAR - the routes the old contract silently omitted', () =>
    {
        const raw = paths['/api/users/{id}/files/{rest}']!.get!;
        expect(raw.operationId).toBe('users.files');
        const rawResponses = raw.responses as Record<string, { description: string }>;
        expect(rawResponses['200']!.description).toContain('raw Response');

        const stream = paths['/api/users/{id}/events']!.get!;
        expect(stream.operationId).toBe('users.events');
        const streamResponses = stream.responses as Record<string, { content?: Record<string, unknown> }>;
        expect(Object.keys(streamResponses['200']!.content ?? {})).toEqual(['text/event-stream']);
        expect(stream['x-azerothjs-stream']).toEqual({ events: ['changed'] });
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

    it('framework error responses appear exactly where register produces them', () =>
    {
        const create = paths['/api/users']!.post!.responses as Record<string, unknown>;
        expect(Object.keys(create).sort()).toEqual(['200', '409', '415', '422', '500']);
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
        expect(skipped[0]).toMatchObject({ name: 'search.run', path: '/api/search' });
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
        const again = toOpenApi(api, { info: INFO, securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } });
        expect(JSON.stringify(again)).toBe(JSON.stringify(document));
    });

    it('the document validates as OpenAPI 3.1', async () =>
    {
        const result = await new Validator().validate(JSON.parse(JSON.stringify(document)) as Record<string, unknown>);
        expect(result.errors ?? []).toEqual([]);
        expect(result.valid).toBe(true);
    });

    it('two routes composing one operation id fail loudly at describe time', () =>
    {
        const colliding = {
            'a.b': feature('/x', (routes) => ({ c: routes.get('/', {}, () => ({})) })),
            a: feature('/y', (routes) => ({ 'b.c': routes.get('/', {}, () => ({})) }))
        };
        expect(() => toOpenApi(colliding, { info: INFO })).toThrow(/operation id/);
    });
});

describe('serving and coverage', () =>
{
    const api = { health: feature('/healthz', (routes) => ({ check: routes.get('/', {}, () => ({ ok: true })) })) };

    it('openapiPlugin serves the cached document as JSON', async () =>
    {
        const app = new App().register(openapiPlugin({ features: api, info: INFO }));
        const response = await app.handle(new Request('http://local/openapi.json'));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');
        const document = await response.json() as Record<string, unknown>;
        expect(document.openapi).toBe('3.1.0');
    });

    it('uncontracted lists exactly the routes the record does not cover - kinds count as covered', () =>
    {
        const app = new App();
        const registered = register(app, {
            media: feature('/media', (routes) => ({
                upload: routes.form('/', {}, () => ({})),
                events: routes.stream('/events', {}, () => undefined),
                avatar: routes.raw('GET', '/avatar', {}, () => new Response(''))
            }))
        });
        app.get('/internal/metrics', () => new Response('m'));
        const uncovered = uncontracted(app, registered);
        expect(uncovered).toHaveLength(1);
        expect(uncovered[0]).toContain('/internal/metrics');
    });
});

describe('the docs page', () =>
{
    const api = { health: feature('/healthz', (routes) => ({ check: routes.get('/', {}, () => ({ ok: true })) })) };

    it('defaults to the self-contained house explorer: no third-party code on the page', async () =>
    {
        const app = new App().register(openapiPlugin({ features: api, info: INFO }));
        const response = await app.handle(new Request('http://local/docs'));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');
        const html = await response.text();
        expect(html).toContain('Test API');
        expect(html).toContain('/openapi.json');
        // Self-contained: no external resource may be referenced.
        expect(html).not.toMatch(/src="http|href="http|https:\/\//);
        // The default IS the house explorer, byte for byte.
        const explicit = new App().register(openapiPlugin({ features: api, info: INFO, viewer: 'azeroth' }));
        expect(await (await explicit.handle(new Request('http://local/docs'))).text()).toBe(html);
    });

    it("viewer: 'scalar' opts in to the CDN shell", async () =>
    {
        const app = new App().register(openapiPlugin({ features: api, info: INFO, viewer: 'scalar' }));
        const html = await (await app.handle(new Request('http://local/docs'))).text();
        expect(html).toContain('cdn.jsdelivr.net/npm/@scalar/api-reference');
        expect(html).toContain("url: '/openapi.json'");
    });

    it('docs: false keeps the plugin spec-only', async () =>
    {
        const app = new App().register(openapiPlugin({ features: api, info: INFO, docs: false }));
        const response = await app.handle(new Request('http://local/docs'));
        expect(response.status).toBe(404);
    });

    it('registers NOTHING in production unless the app asks for it', async () =>
    {
        const previous = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try
        {
            const gated = new App().register(openapiPlugin({ features: api, info: INFO }));
            expect((await gated.handle(new Request('http://local/openapi.json'))).status).toBe(404);
            expect((await gated.handle(new Request('http://local/docs'))).status).toBe(404);

            const opted = new App().register(openapiPlugin({ features: api, info: INFO, public: true }));
            expect((await opted.handle(new Request('http://local/openapi.json'))).status).toBe(200);
            expect((await opted.handle(new Request('http://local/docs'))).status).toBe(200);
        }
        finally
        {
            if (previous === undefined)
            {
                delete process.env.NODE_ENV;
            }
            else
            {
                process.env.NODE_ENV = previous;
            }
        }
    });

    it('escapes a hostile title in both viewers', async () =>
    {
        for (const viewer of ['scalar', 'azeroth'] as const)
        {
            const app = new App().register(openapiPlugin({ features: api, info: { title: '<script>alert(1)</script>', version: '1' }, viewer }));
            const html = await (await app.handle(new Request('http://local/docs'))).text();
            expect(html).not.toContain('<script>alert');
            expect(html).toContain('&lt;script&gt;');
        }
    });
});

describe('component names disambiguate instead of colliding', () =>
{
    // `user.profile_card` and `user_profile.card` pascal to the same component name. Each
    // schema instance is used twice by its own route, so both hoist to components - and two
    // DIFFERENT shapes under one name would document each route with the other's body.
    const dotted = object({ a: string() });
    const underscored = object({ b: number() });
    const api = {
        user: feature('/dotted', (routes) => ({
            profile_card: routes.post('/', { input: dotted, output: dotted }, () => ({ a: 'x' }))
        })),
        user_profile: feature('/underscored', (routes) => ({
            card: routes.post('/', { input: underscored, output: underscored }, () => ({ b: 1 }))
        }))
    };
    const document = toOpenApi(api, { info: INFO });
    const components = (document.components as Record<string, Record<string, Record<string, unknown>>>).schemas!;
    const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;

    const refOf = (path: string): string =>
    {
        const body = paths[path]!.post!.requestBody as { content: Record<string, { schema: { $ref?: string } }> };
        return body.content['application/json']!.schema.$ref ?? '';
    };

    it('two distinct schemas never share one $ref', () =>
    {
        expect(refOf('/api/dotted')).not.toBe('');
        expect(refOf('/api/underscored')).not.toBe('');
        expect(refOf('/api/underscored')).not.toBe(refOf('/api/dotted'));
    });

    it('each ref resolves to its OWN shape', () =>
    {
        const first = components[refOf('/api/dotted').split('/').pop()!]!;
        const second = components[refOf('/api/underscored').split('/').pop()!]!;
        expect(Object.keys(first.properties as object)).toEqual(['a']);
        expect(Object.keys(second.properties as object)).toEqual(['b']);
    });

    it('disambiguation is deterministic and stays valid OpenAPI 3.1', async () =>
    {
        expect(JSON.stringify(toOpenApi(api, { info: INFO }))).toBe(JSON.stringify(document));
        const result = await new Validator().validate(JSON.parse(JSON.stringify(document)) as Record<string, unknown>);
        expect(result.errors ?? []).toEqual([]);
        expect(result.valid).toBe(true);
    });
});

describe('errorSchema: the spec tells the truth about custom envelopes', () =>
{
    it('a declared error envelope replaces the default in components and refs', () =>
    {
        const custom = object({ success: boolean(), code: string(), field: string() });
        const api = { ping: feature('/ping', (routes) => ({ run: routes.post('/', { input: object({ x: string() }) }, () => ({})) })) };
        const document = toOpenApi(api, { info: INFO, errorSchema: custom });
        const components = (document.components as Record<string, Record<string, Record<string, unknown>>>).schemas!;
        expect(Object.keys(components.ErrorResponse!.properties as object)).toEqual(['success', 'code', 'field']);
        const responses = (document.paths as Record<string, Record<string, Record<string, unknown>>>)['/api/ping']!.post!.responses as Record<string, Record<string, unknown>>;
        expect(JSON.stringify(responses['422'])).toContain('#/components/schemas/ErrorResponse');
    });
});

describe('verb sugar', () =>
{
    it('the named verbs are byte-equivalent to routes.method() in the derived document', async () =>
    {
        const output = object({ id: number() });
        const viaSugar = {
            users: feature('/users', (routes) => ({
                list: routes.get('/', { output: array(output) }, () => []),
                create: routes.post('/', { input: object({ name: string() }), output }, () => ({ id: 1 })),
                update: routes.patch('/:id', { input: object({ name: string() }), output }, () => ({ id: 1 })),
                replace: routes.put('/:id', { input: object({ name: string() }), output }, () => ({ id: 1 })),
                remove: routes.del('/:id', {}, () => ({}))
            }))
        };
        const viaMethod = {
            users: feature('/users', (routes) => ({
                list: routes.method('GET', '/', { output: array(output) }, () => []),
                create: routes.method('POST', '/', { input: object({ name: string() }), output }, () => ({ id: 1 })),
                update: routes.method('PATCH', '/:id', { input: object({ name: string() }), output }, () => ({ id: 1 })),
                replace: routes.method('PUT', '/:id', { input: object({ name: string() }), output }, () => ({ id: 1 })),
                remove: routes.method('DELETE', '/:id', {}, () => ({}))
            }))
        };
        expect(JSON.stringify(toOpenApi(viaSugar, { info: INFO })))
            .toBe(JSON.stringify(toOpenApi(viaMethod, { info: INFO })));
        expect(await new Validator().validate(JSON.parse(JSON.stringify(toOpenApi(viaSugar, { info: INFO }))) as Record<string, unknown>)
            .then((result) => result.valid)).toBe(true);
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

    const api = {
        things: feature('/things', (routes) => ({
            create: routes.post('/', { input: zodLikeName as never, output: object({ id: number() }) }, () => ({ id: 1 }))
        }))
    };

    it('a foreign validator validates the boundary (422 on bad input)', async () =>
    {
        const app = new App();
        register(app, api, { prefix: '' });
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
        const document = toOpenApi(api, { info: INFO });
        const body = schemaOf(document, '/api/things', 'post');
        expect(String(body.description)).toContain('custom rule'); // permissive fallback, not fabricated
    });
});

describe('per-status responses (the reply() channel) in the document', () =>
{
    const user = object({ id: number({ int: true }), name: string() });
    const problem = object({ code: string(), message: string() });
    const api = {
        things: feature('/things', (routes) => ({
            create: routes.post('/', { input: object({ name: string() }), output: user, responses: { 201: user, 409: problem } }, () => ({ id: 1, name: 'x' })),
            find: routes.get('/:id', { output: user, responses: { 404: problem } }, () => ({ id: 1, name: 'x' }))
        }))
    };
    const document = toOpenApi(api, { info: INFO });
    const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;

    it('each declared status becomes its own response entry with its resolved schema', () =>
    {
        const responses = paths['/api/things']!.post!.responses as Record<string, { description: string; content?: Record<string, { schema: unknown }> }>;
        expect(responses['200']).toBeDefined();                       // output stays the default
        expect(responses['201']!.description).toBe('Created');
        // The 201 body IS the output schema - the resolver dedupes it to the same component ref.
        expect(responses['201']!.content!['application/json']!.schema)
            .toEqual((responses['200']!.content!['application/json']!).schema);
        expect(responses['409']!.description).toBe('Conflict');
        const conflict = JSON.stringify(responses['409']!.content!['application/json']!.schema) + JSON.stringify(document.components ?? {});
        expect(conflict).toContain('"code"');

        const findResponses = paths['/api/things/{id}']!.get!.responses as Record<string, { description: string }>;
        expect(findResponses['404']!.description).toBe('Not Found');
    });

    it('a docs.errors entry never downgrades a typed responses status to the generic envelope', () =>
    {
        const collided = {
            things: feature('/things', (routes) => ({
                find: routes.get('/:id', {
                    output: user,
                    responses: { 404: problem },
                    docs: { errors: [{ status: 404, description: 'prose duplicate' }, { status: 410, description: 'Gone away' }] }
                }, () => ({ id: 1, name: 'x' }))
            }))
        };
        const collidedPaths = toOpenApi(collided, { info: INFO }).paths as Record<string, Record<string, Record<string, unknown>>>;
        const entries = collidedPaths['/api/things/{id}']!.get!.responses as Record<string, { description: string; content?: Record<string, { schema: unknown }> }>;
        expect(entries['404']!.description).toBe('Not Found');   // the typed schema entry won
        expect(JSON.stringify(entries['404'])).not.toContain('ErrorResponse');
        expect(entries['410']!.description).toBe('Gone away');   // prose-only statuses still document
    });

    it('the document with per-status responses is valid OpenAPI 3.1', async () =>
    {
        expect((await new Validator().validate(JSON.parse(JSON.stringify(document)) as Record<string, unknown>)).valid).toBe(true);
    });
});

describe('form routes in the document', () =>
{
    const api = {
        files: feature('/files', (routes) => ({
            upload: routes.form('/', { fields: object({ title: string({ nonempty: true }) }), output: object({ ok: boolean() }) }, () => ({ ok: true })),
            loose: routes.form('/loose', {}, () => ({}))
        }))
    };
    const document = toOpenApi(api, { info: INFO });
    const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;

    it('the request body is multipart/form-data with the FIELDS schema, never fabricated file constraints', () =>
    {
        const body = paths['/api/files']!.post!.requestBody as { description: string; content: Record<string, { schema: Record<string, unknown> }> };
        expect(Object.keys(body.content)).toEqual(['multipart/form-data']);
        expect(body.description).toContain('file parts');
        const schema = JSON.stringify(body.content['multipart/form-data']!.schema) + JSON.stringify(document.components ?? {});
        expect(schema).toContain('"title"');
    });

    it('an undeclared-fields form body degrades to the honest permissive shape', () =>
    {
        const body = paths['/api/files/loose']!.post!.requestBody as { content: Record<string, { schema: { description?: string } }> };
        expect(String(body.content['multipart/form-data']!.schema.description)).toContain('undeclared');
    });

    it('the 415 names multipart, and the fields schema derives the 422', () =>
    {
        const responses = paths['/api/files']!.post!.responses as Record<string, { description: string }>;
        expect(responses['415']!.description).toContain('multipart');
        expect(responses['422']).toBeDefined();
    });

    it('the document with form routes is valid OpenAPI 3.1', async () =>
    {
        expect((await new Validator().validate(JSON.parse(JSON.stringify(document)) as Record<string, unknown>)).valid).toBe(true);
    });
});
