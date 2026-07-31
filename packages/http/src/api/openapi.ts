/**
 * MODULE: api/openapi - the feature record's third exporter
 *
 * A feature record already produces a server registration and a typed client from one
 * declaration; this module produces the OpenAPI 3.1 document from the same declaration -
 * three consumers, one truth, drift structurally impossible for everything derived. The
 * exporter is a PURE function: it reads the declarations and each schema's
 * self-description (SchemaMeta) and never touches runtime behavior - `docs` on a
 * route is display-only by contract.
 *
 * Determinism is a tested promise: paths in declaration order (two insertion-ordered
 * Object.entries walks), canonical key order inside every object, component names taken
 * from the first use and disambiguated in declaration order when two names collapse -
 * two builds of the same record are byte-identical, so specs diff cleanly in CI.
 *
 * Honest degradations: a refinement cannot be expressed as JSON Schema, so it becomes a
 * description note; a QUERY route (RFC 10008) has no OpenAPI method, so it is excluded
 * from `paths` and listed, machine-readably, under the `x-azerothjs-query` extension; a
 * schema without metadata maps to the permissive `{}` with a note; a `raw` route's body
 * degrades to what its spec declared and never an invented schema. The exporter never
 * claims a constraint the validator does not enforce.
 */

import type { Schema, SchemaMeta, StringOptions, NumberOptions, ArrayOptions } from '@azerothjs/schema';
import type { App, AzerothPlugin } from '../index.ts';

import type { AnyDecl, Feature, RouteDocs } from './declare.ts';
import { pathOf, responseSchemaFor } from './declare.ts';
import { renderExplorerHtml, renderScalarHtml } from './explorer.ts';

/** @internal Reason phrases for the per-status response descriptions. */
const DEFAULT_STATUS_TEXT: Record<string, string> = {
    '200': 'OK', '201': 'Created', '202': 'Accepted', '204': 'No Content',
    '301': 'Moved Permanently', '302': 'Found', '304': 'Not Modified',
    '400': 'Bad Request', '401': 'Unauthorized', '403': 'Forbidden', '404': 'Not Found',
    '409': 'Conflict', '410': 'Gone', '429': 'Too Many Requests'
};

/** The subset of an OpenAPI document this exporter emits (structurally 3.1-valid). */
export type OpenApiDocument = Record<string, unknown>;

/** Everything a machine cannot derive from the contract - and nothing it can. */
export interface ToOpenApiOptions
{
    /** OpenAPI `info` - title and version are the spec's only required fields. */
    info: { title: string; version: string; description?: string };

    /** OpenAPI `servers` (base URLs); omit for a relative-path spec. */
    servers?: ReadonlyArray<{ url: string; description?: string }>;

    /** The mount prefix routes are served under; must match `mountApi`. Default '/api'. */
    prefix?: string;

    /** Raw OpenAPI securityScheme objects by name (referenced from route docs.security). */
    securitySchemes?: Record<string, unknown>;

    /** The document-wide security requirement (route docs.security overrides per route). */
    security?: ReadonlyArray<Record<string, readonly string[]>>;

    /**
     * The wire shape of error responses, when the app replaces the framework envelope
     * (a custom `serializeError`). Declared once, referenced by every derived and
     * declared error response - so the spec tells the truth about YOUR errors.
     * Default: the framework's `{ error: { code, message, details } }` envelope.
     */
    errorSchema?: Schema<unknown>;
}

/** @internal The DEFAULT error envelope (mountApi's own, absent a custom serializeError). */
const ERROR_ENVELOPE = {
    type: 'object',
    properties: {
        error: {
            type: 'object',
            properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                details: { type: 'object' }
            },
            required: ['code', 'message']
        }
    },
    required: ['error']
} as const;

const ERROR_REF = { $ref: '#/components/schemas/ErrorResponse' } as const;

/** @internal A walked declaration paired with its `group.key` name and full path. */
interface FlatRoute
{
    name: string;
    group: string;
    fullPath: string;
    decl: AnyDecl;
}

/**
 * @internal Flattens the feature record in declaration order. The uniqueness assert is the
 * ONE residue of the old key-space machinery, and it lives here in the describer: a feature
 * key containing a dot could compose the same `group.key` as a sibling, and two operations
 * sharing one operationId is a structurally valid document describing the wrong route.
 */
function flatten(features: Record<string, Feature>): FlatRoute[]
{
    const out: FlatRoute[] = [];
    const names = new Set<string>();
    for (const [group, built] of Object.entries(features))
    {
        for (const [key, decl] of Object.entries(built.routes))
        {
            const name = `${ group }.${ key }`;
            if (names.has(name))
            {
                throw new Error(`Two routes compose the same operation id "${ name }" - rename one key.`);
            }
            names.add(name);
            out.push({ name, group, fullPath: pathOf(built.prefix, decl.path as string), decl });
        }
    }
    return out;
}

/** @internal `/users/:id/files/*rest` -> `/users/{id}/files/{rest}` + the param list. */
function convertPath(pattern: string): { path: string; params: Array<{ name: string; wildcard: boolean }> }
{
    const params: Array<{ name: string; wildcard: boolean }> = [];
    const path = pattern.split('/').map((segment) =>
    {
        if (segment.startsWith(':'))
        {
            params.push({ name: segment.slice(1), wildcard: false });
            return `{${ segment.slice(1) }}`;
        }
        if (segment.startsWith('*'))
        {
            params.push({ name: segment.slice(1), wildcard: true });
            return `{${ segment.slice(1) }}`;
        }
        return segment;
    }).join('/');
    return { path, params };
}

/** @internal PascalCases a dotted tree path: `users.create` -> `UsersCreate`. */
function pascal(name: string): string
{
    return name.split(/[.\-_]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

/**
 * @internal Claims a component name, mutating the taken set. `user.profile`, `user_profile`
 * and `userProfile` all pascal to one name; letting two DIFFERENT schemas share it would
 * give both routes the same `$ref` - a structurally valid document describing the wrong
 * body. The separator-preserving tree path disambiguates first (it is unique per route),
 * a counter after that; both follow declaration order, so rebuilds stay byte-identical.
 */
function claimName(preferred: string, fallback: string, taken: Set<string>): string
{
    let name = taken.has(preferred) ? fallback : preferred;
    let counter = 2;
    while (taken.has(name))
    {
        name = `${ preferred }${ counter }`;
        counter += 1;
    }
    taken.add(name);
    return name;
}

/**
 * @internal Maps one schema's self-description to JSON Schema. Every rule here has a
 * test; anything the metadata cannot express degrades to a permissive schema plus a
 * description note - never an invented constraint.
 */
function toJsonSchema(schema: Schema<unknown> | undefined): Record<string, unknown>
{
    const meta: SchemaMeta | undefined = schema?.meta;
    if (meta === undefined)
    {
        return { description: 'Validated by a custom rule the declaration does not describe.' };
    }
    const out = fromMeta(meta);
    if (meta.refinements !== undefined && meta.refinements.length > 0)
    {
        const names = meta.refinements.map((refinement) => refinement.code ?? 'refine').join(', ');
        out.description = typeof out.description === 'string'
            ? `${ out.description } Additionally validated: ${ names }.`
            : `Additionally validated: ${ names }.`;
    }
    if (meta.nullable === true)
    {
        return { anyOf: [out, { type: 'null' }] };
    }
    return out;
}

/** @internal The kind-by-kind mapping (refinement notes handled by the caller). */
function fromMeta(meta: SchemaMeta): Record<string, unknown>
{
    switch (meta.kind)
    {
        case 'string': {
            const c = (meta.constraints ?? {}) as StringOptions;
            const out: Record<string, unknown> = { type: 'string' };
            const minLength = c.nonempty === true ? Math.max(c.min ?? 0, 1) : c.min;
            if (minLength !== undefined)
            {
                out.minLength = minLength;
            }
            if (c.max !== undefined)
            {
                out.maxLength = c.max;
            }
            if (c.pattern !== undefined)
            {
                out.pattern = c.pattern.source;
            }
            if (c.format !== undefined)
            {
                out.format = c.format === 'datetime' ? 'date-time' : c.format;
            }
            return out;
        }
        case 'number': {
            const c = (meta.constraints ?? {}) as NumberOptions;
            const out: Record<string, unknown> = { type: c.int === true ? 'integer' : 'number' };
            if (c.min !== undefined)
            {
                out.minimum = c.min;
            }
            if (c.max !== undefined)
            {
                out.maximum = c.max;
            }
            return out;
        }
        case 'boolean':
            return { type: 'boolean' };
        case 'literal':
            return { const: meta.value };
        case 'enum':
            return { type: 'string', enum: [...meta.values ?? []] };
        case 'array': {
            const c = (meta.constraints ?? {}) as ArrayOptions;
            const out: Record<string, unknown> = { type: 'array', items: toJsonSchema(meta.item) };
            if (c.min !== undefined)
            {
                out.minItems = c.min;
            }
            if (c.max !== undefined)
            {
                out.maxItems = c.max;
            }
            return out;
        }
        case 'object': {
            const properties: Record<string, unknown> = {};
            const required: string[] = [];
            for (const [key, field] of Object.entries(meta.shape ?? {}))
            {
                properties[key] = toJsonSchema(field);
                if (field.meta?.optional !== true)
                {
                    required.push(key);
                }
            }
            const out: Record<string, unknown> = { type: 'object', properties, additionalProperties: false };
            if (required.length > 0)
            {
                out.required = required;
            }
            return out;
        }
        case 'record':
            return { type: 'object', additionalProperties: toJsonSchema(meta.item) };
        case 'union':
            return { anyOf: (meta.options ?? []).map((option) => toJsonSchema(option)) };
    }
}

/**
 * Derives the OpenAPI 3.1 document from a feature record. Pure and deterministic: the same
 * record always produces the byte-identical document. Everything derivable is derived
 * (paths, params, bodies, the framework's 422/415/500 envelope responses, operation ids
 * and tags from the record keys); `docs` adds only what a machine cannot know; QUERY routes
 * are listed under `x-azerothjs-query` because OpenAPI has no such method; `raw` and
 * `stream` routes appear in `paths` - the +N routes the old contract silently omitted.
 */
export function toOpenApi(features: Record<string, Feature>, options: ToOpenApiOptions): OpenApiDocument
{
    const prefix = options.prefix ?? '/api';
    const flat = flatten(features);
    const paths: Record<string, Record<string, unknown>> = {};
    const queryRoutes: Array<Record<string, unknown>> = [];

    // Shared-schema identity: the SAME schema instance used by 2+ routes (as input or
    // output) becomes one named component, named from its first use - both deterministic
    // (declaration order) and meaningful across services that share a schema value.
    // Single-use schemas stay inline; query schemas explode into per-field parameters and
    // never hoist.
    const uses = new Map<Schema<unknown>, { count: number; name: string; path: string }>();
    for (const { name, decl } of flat)
    {
        for (const [role, node] of [['Input', decl.kind === 'json' ? decl.spec.input : undefined], ['Output', decl.spec.output]] as const)
        {
            if (node === undefined)
            {
                continue;
            }
            const schema = node as Schema<unknown>;
            const seen = uses.get(schema);
            if (seen === undefined)
            {
                uses.set(schema, { count: 1, name: pascal(name) + role, path: name + role });
            }
            else
            {
                seen.count += 1;
            }
        }
    }
    const componentSchemas: Record<string, unknown> = {
        ErrorResponse: options.errorSchema !== undefined ? toJsonSchema(options.errorSchema) : ERROR_ENVELOPE
    };
    const refs = new Map<Schema<unknown>, Record<string, unknown>>();
    const taken = new Set(Object.keys(componentSchemas));
    for (const [schema, use] of uses)
    {
        if (use.count >= 2)
        {
            const name = claimName(use.name, use.path, taken);
            componentSchemas[name] = toJsonSchema(schema);
            refs.set(schema, { $ref: `#/components/schemas/${ name }` });
        }
    }
    const resolve = (schema: Schema<unknown>): Record<string, unknown> => refs.get(schema) ?? toJsonSchema(schema);

    for (const { name, group, fullPath, decl } of flat)
    {
        const docs: RouteDocs = decl.spec.docs ?? {};
        if (decl.method === 'QUERY')
        {
            queryRoutes.push({
                name,
                path: prefix + fullPath,
                ...docs.summary !== undefined ? { summary: docs.summary } : {},
                ...decl.spec.input !== undefined ? { querySchema: toJsonSchema(decl.spec.input as Schema<unknown>) } : {}
            });
            continue;
        }

        const { path, params } = convertPath(prefix + fullPath);
        const operation: Record<string, unknown> = { operationId: name };
        const tags = docs.tags ?? [group];
        if (tags.length > 0)
        {
            operation.tags = [...tags];
        }
        if (docs.summary !== undefined)
        {
            operation.summary = docs.summary;
        }
        if (docs.description !== undefined)
        {
            operation.description = docs.description;
        }
        if (docs.deprecated === true)
        {
            operation.deprecated = true;
        }

        const parameters: Array<Record<string, unknown>> = params.map((param) => ({
            name: param.name,
            in: 'path',
            required: true,
            schema: { type: 'string' },
            ...param.wildcard ? { description: 'Wildcard segment - may span multiple path segments.' } : {}
        }));
        const querySchema = decl.spec.query as Schema<unknown> | undefined;
        if (querySchema?.meta?.kind === 'object')
        {
            for (const [key, field] of Object.entries(querySchema.meta.shape ?? {}))
            {
                parameters.push({
                    name: key,
                    in: 'query',
                    required: field.meta?.optional !== true,
                    schema: toJsonSchema(field)
                });
            }
        }
        if (parameters.length > 0)
        {
            operation.parameters = parameters;
        }

        if (decl.kind === 'form')
        {
            operation.requestBody = {
                required: true,
                description: 'multipart/form-data: the schema describes the TEXT fields; file parts ride beside them (binary).',
                content: { 'multipart/form-data': {
                    schema: decl.spec.fields !== undefined
                        ? resolve(decl.spec.fields as Schema<unknown>)
                        : { type: 'object', description: 'Text fields (undeclared) plus file parts.' }
                } }
            };
        }
        else if (decl.kind === 'raw')
        {
            // The +N win over the old contract: the route appears, with its params, docs,
            // security, and derived errors. The body degrades HONESTLY - a declared media
            // type with a binary format, never an invented schema.
            if (decl.method !== 'GET' && decl.method !== 'DELETE')
            {
                operation.requestBody = {
                    content: { [decl.spec.accepts ?? 'application/octet-stream']: { schema: { format: 'binary' } } }
                };
            }
        }
        else if (decl.spec.input !== undefined)
        {
            operation.requestBody = {
                required: true,
                content: { 'application/json': { schema: resolve(decl.spec.input as Schema<unknown>) } }
            };
        }

        // Responses: the declared success shape, every per-status schema from the
        // `responses` map (the reply() channel), then the framework-DERIVED error set -
        // each emitted only when register actually produces it for this route's shape.
        const responses: Record<string, unknown> = {};
        // One response concept: `responses[200]` and `output` are the same slot (`output`
        // is the declared shorthand), so the 200 entry derives from either and the loop
        // below skips it.
        const okSchema = responseSchemaFor(decl, 200);
        if (decl.kind === 'stream')
        {
            responses['200'] = {
                description: 'A Server-Sent-Events stream.',
                content: { 'text/event-stream': { schema: { type: 'string' } } }
            };
        }
        else if (decl.kind === 'raw')
        {
            responses['200'] = okSchema !== undefined
                ? { description: 'OK', content: { 'application/json': { schema: resolve(okSchema as Schema<unknown>) } } }
                : { description: 'Response shape not declared: this route answers with a raw Response.' };
        }
        else
        {
            responses['200'] = okSchema !== undefined
                ? { description: 'OK', content: { 'application/json': { schema: resolve(okSchema as Schema<unknown>) } } }
                : { description: 'OK (response shape not declared)' };
        }
        for (const [status, statusSchema] of Object.entries((decl.spec.responses ?? {}) as Record<string, unknown>))
        {
            if (status === '200')
            {
                continue;
            }
            responses[status] = {
                description: DEFAULT_STATUS_TEXT[status] ?? `Status ${ status }`,
                content: { 'application/json': { schema: resolve(statusSchema as Schema<unknown>) } }
            };
        }
        const validatesBody = decl.kind === 'form' ? decl.spec.fields !== undefined : (decl.kind === 'json' && decl.spec.input !== undefined);
        if (validatesBody || decl.spec.query !== undefined)
        {
            responses['422'] = { description: 'Validation failed', content: { 'application/json': { schema: ERROR_REF } } };
        }
        if (decl.kind === 'form' || (decl.kind === 'json' && decl.spec.input !== undefined))
        {
            responses['415'] = {
                description: decl.kind === 'form' ? 'Unsupported content type (multipart/form-data required)' : 'Unsupported content type (JSON required)',
                content: { 'application/json': { schema: ERROR_REF } }
            };
        }
        if (decl.spec.output !== undefined || decl.spec.responses !== undefined)
        {
            responses['500'] = { description: 'Contract violation (response failed its declared schema)', content: { 'application/json': { schema: ERROR_REF } } };
        }
        for (const declared of docs.errors ?? [])
        {
            // A status carried by the typed `responses` map keeps its REAL schema - the
            // prose-only docs.errors entry never downgrades it to the generic envelope.
            if (decl.spec.responses?.[declared.status] !== undefined)
            {
                continue;
            }
            responses[String(declared.status)] = {
                description: declared.description ?? (declared.code !== undefined ? `Error: ${ declared.code }` : 'Error'),
                content: { 'application/json': { schema: ERROR_REF } }
            };
        }
        if (decl.kind === 'stream')
        {
            if (decl.spec.events !== undefined && decl.spec.events.length > 0)
            {
                operation['x-azerothjs-stream'] = { events: [...decl.spec.events] };
            }
        }
        operation.responses = responses;

        if (docs.security !== undefined)
        {
            operation.security = docs.security.length === 0
                ? []
                : docs.security.map((scheme) => ({ [scheme]: [] }));
        }

        const entry = paths[path] ?? (paths[path] = {});
        entry[decl.method.toLowerCase()] = operation;
    }

    const document: OpenApiDocument = {
        openapi: '3.1.0',
        info: { ...options.info },
        ...options.servers !== undefined ? { servers: options.servers.map((server) => ({ ...server })) } : {},
        paths,
        components: { schemas: componentSchemas },
        ...options.security !== undefined ? { security: options.security.map((entry) => ({ ...entry })) } : {},
        ...queryRoutes.length > 0 ? { 'x-azerothjs-query': queryRoutes } : {}
    };
    if (options.securitySchemes !== undefined)
    {
        (document.components as Record<string, unknown>).securitySchemes = options.securitySchemes;
    }
    return document;
}

/** @internal `NODE_ENV` where a `process` exists - api/ also runs on runtimes without one. */
function nodeEnv(): string | undefined
{
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV;
}

/** Options for {@link openapiPlugin}: the export options plus the features and routes. */
export interface OpenApiPluginOptions extends ToOpenApiOptions
{
    /** The registered feature record the served document describes - pass what `register` returned. */
    features: Record<string, Feature>;

    /** Where the document is served. Default '/openapi.json'. */
    route?: string;

    /**
     * Where the docs page is served, or `false` for spec-only. Default '/docs'.
     */
    docs?: string | false;

    /**
     * Register both routes even in production. Off by default: the document enumerates
     * every contracted route's shape and constraints, and the docs page carries a try-it
     * panel a developer pastes a real token into - so an app that wants that surface on
     * the public internet says so in one word, and an app that forgets leaks nothing.
     * Without it, `NODE_ENV=production` installs the plugin as a no-op.
     */
    public?: boolean;

    /**
     * Which viewer the docs page carries. Default `'azeroth'`: the house explorer - one
     * fully self-contained page (inline styles/script, zero external requests, works
     * offline) in the AzerothJS design language, try-it included. `'scalar'`: a tiny shell
     * that loads the Scalar reference from a CDN in the browser - best-in-class UI, at the
     * price of internet while viewing and third-party code your browser runs on the page
     * you paste tokens into.
     */
    viewer?: 'scalar' | 'azeroth';
}

/**
 * Serves the contract's OpenAPI document - generated once at install (contracts are
 * immutable values), served from cached bytes - and, unless `docs: false`, the house
 * explorer page beside it. An ordinary plugin: two GET routes, nothing else. External
 * viewers (Scalar, Redoc, Swagger UI) read the document route directly.
 *
 * Both routes are development surfaces: under `NODE_ENV=production` the plugin registers
 * nothing unless `public: true` says otherwise.
 */
export function openapiPlugin(options: OpenApiPluginOptions): AzerothPlugin
{
    return {
        name: 'azerothjs-openapi',
        install(app: App): App
        {
            if (options.public !== true && nodeEnv() === 'production')
            {
                return app;
            }
            // Generated once, served as cached bytes - a feature record is an immutable value.
            const specRoute = options.route ?? '/openapi.json';
            const payload = JSON.stringify(toOpenApi(options.features, options));
            app.get(specRoute, () =>
                new Response(payload, { headers: { 'content-type': 'application/json; charset=utf-8' } }));
            if (options.docs !== false)
            {
                const page = options.viewer === 'scalar'
                    ? renderScalarHtml(specRoute, options.info.title)
                    : renderExplorerHtml(specRoute, options.info.title);
                app.get(options.docs ?? '/docs', () =>
                    new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
            }
            return app;
        }
    };
}

/**
 * The coverage report for partial adoption: every route registered on the app that the
 * feature record does NOT cover (compared under `prefix`). Call it AFTER all registration -
 * an honest list for the migration burndown, never a guess. raw/stream/form routes count as
 * covered now, so the output shrinks to what is genuinely outside the system.
 */
export function uncontracted(app: App, features: Record<string, Feature>, prefix = '/api'): string[]
{
    // Compare parsed (method, pattern) pairs, never formatted strings - the routes()
    // table's whitespace is presentation, and coupling to it would rot silently.
    const covered = new Set(flatten(features).map(({ fullPath, decl }) => `${ decl.method } ${ pathOf('', fullPath, prefix) }`));
    return app.routes().filter((line) =>
    {
        const [method, ...rest] = line.trim().split(/\s+/);
        return !covered.has(`${ method ?? '' } ${ rest.join(' ') }`);
    });
}
