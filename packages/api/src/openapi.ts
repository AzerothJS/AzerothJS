/**
 * MODULE: api/openapi - the contract's third exporter
 *
 * A contract already produces a server mount and a typed client from one declaration;
 * this module produces the OpenAPI 3.1 document from the same declaration - three
 * consumers, one truth, drift structurally impossible for everything derived. The
 * exporter is a PURE function: it reads the contract tree and each schema's
 * self-description (SchemaMeta) and never touches runtime behavior - `docs` on a
 * route is display-only by contract.
 *
 * Determinism is a tested promise: paths in contract-declaration order, canonical key
 * order inside every object, component names taken from the first tree-path use - two
 * builds of the same contract are byte-identical, so specs diff cleanly in CI.
 *
 * Honest degradations: a refinement cannot be expressed as JSON Schema, so it becomes a
 * description note; a QUERY route (RFC 10008)
 * has no OpenAPI method, so it is excluded from `paths` and listed, machine-readably,
 * under the `x-azerothjs-query` extension; a schema without metadata maps to the
 * permissive `{}` with a note. The exporter never invents a constraint the validator
 * does not enforce.
 */

import type { Schema, SchemaMeta, StringOptions, NumberOptions, ArrayOptions } from '@azerothjs/schema';
import type { App, AzerothPlugin } from '@azerothjs/http';

import { isRoute, type AnyRoute, type Contract, type RouteDocs } from './define.ts';
import { renderExplorerHtml, renderScalarHtml } from './explorer.ts';

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

/** @internal A walked route paired with its dotted tree path (`users.create`). */
interface FlatRoute
{
    name: string;
    group: string | null;
    route: AnyRoute;
}

/** @internal Flattens the contract tree in declaration order. */
function flatten(contract: Contract, prefix = '', group: string | null = null, out: FlatRoute[] = []): FlatRoute[]
{
    for (const [key, node] of Object.entries(contract))
    {
        const name = prefix === '' ? key : `${ prefix }.${ key }`;
        if (isRoute(node))
        {
            out.push({ name, group: group ?? (prefix === '' ? null : prefix), route: node });
        }
        else
        {
            flatten(node, name, group ?? key, out);
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
        const names = meta.refinements.map((r) => r.code ?? 'refine').join(', ');
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
 * Derives the OpenAPI 3.1 document from a contract. Pure and deterministic: the same
 * contract always produces the byte-identical document. Everything derivable is derived
 * (paths, params, bodies, the framework's 422/415/500 envelope responses, operation ids
 * and tags from the tree); `docs` adds only what a machine cannot know; QUERY routes are
 * listed under `x-azerothjs-query` because OpenAPI has no such method.
 */
export function toOpenApi(contract: Contract, options: ToOpenApiOptions): OpenApiDocument
{
    const prefix = options.prefix ?? '/api';
    const flat = flatten(contract);
    const paths: Record<string, Record<string, unknown>> = {};
    const queryRoutes: Array<Record<string, unknown>> = [];

    // Shared-schema identity: the SAME schema instance used by 2+ routes (as input or
    // output) becomes one named component, named from its first tree-path use - both
    // deterministic (declaration order) and meaningful across services that share a
    // schema value. Single-use schemas stay inline; query schemas explode into per-field
    // parameters and never hoist.
    const uses = new Map<Schema<unknown>, { count: number; name: string }>();
    for (const { name, route } of flat)
    {
        for (const [role, node] of [['Input', route.input], ['Output', route.output]] as const)
        {
            if (node === undefined)
            {
                continue;
            }
            const schema = node as Schema<unknown>;
            const seen = uses.get(schema);
            if (seen === undefined)
            {
                uses.set(schema, { count: 1, name: pascal(name) + role });
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
    for (const [schema, use] of uses)
    {
        if (use.count >= 2)
        {
            componentSchemas[use.name] = toJsonSchema(schema);
            refs.set(schema, { $ref: `#/components/schemas/${ use.name }` });
        }
    }
    const resolve = (schema: Schema<unknown>): Record<string, unknown> => refs.get(schema) ?? toJsonSchema(schema);

    for (const { name, group, route } of flat)
    {
        const docs: RouteDocs = route.docs ?? {};
        const routePath = route.path as string;
        if (route.method === 'QUERY')
        {
            queryRoutes.push({
                name,
                path: prefix + routePath,
                ...docs.summary !== undefined ? { summary: docs.summary } : {},
                ...route.input !== undefined ? { querySchema: toJsonSchema(route.input as Schema<unknown>) } : {}
            });
            continue;
        }

        const { path, params } = convertPath(prefix + routePath);
        const operation: Record<string, unknown> = { operationId: name };
        const tags = docs.tags ?? (group === null ? undefined : [group]);
        if (tags !== undefined && tags.length > 0)
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
        const querySchema = route.query as Schema<unknown> | undefined;
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

        if (route.input !== undefined)
        {
            operation.requestBody = {
                required: true,
                content: { 'application/json': { schema: resolve(route.input as Schema<unknown>) } }
            };
        }

        // Responses: the declared success shape, then the framework-DERIVED error set -
        // each emitted only when mountApi actually produces it for this route's shape.
        const responses: Record<string, unknown> = {};
        responses['200'] = route.output !== undefined
            ? { description: 'OK', content: { 'application/json': { schema: resolve(route.output as Schema<unknown>) } } }
            : { description: 'OK (response shape not declared by the contract)' };
        if (route.input !== undefined || route.query !== undefined)
        {
            responses['422'] = { description: 'Validation failed', content: { 'application/json': { schema: ERROR_REF } } };
        }
        if (route.input !== undefined)
        {
            responses['415'] = { description: 'Unsupported content type (JSON required)', content: { 'application/json': { schema: ERROR_REF } } };
        }
        if (route.output !== undefined)
        {
            responses['500'] = { description: 'Contract violation (response failed its declared schema)', content: { 'application/json': { schema: ERROR_REF } } };
        }
        for (const declared of docs.errors ?? [])
        {
            responses[String(declared.status)] = {
                description: declared.description ?? (declared.code !== undefined ? `Error: ${ declared.code }` : 'Error'),
                content: { 'application/json': { schema: ERROR_REF } }
            };
        }
        operation.responses = responses;

        if (docs.security !== undefined)
        {
            operation.security = docs.security.length === 0
                ? []
                : docs.security.map((scheme) => ({ [scheme]: [] }));
        }

        const entry = paths[path] ?? (paths[path] = {});
        entry[route.method.toLowerCase()] = operation;
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

/** Options for {@link openapiPlugin}: the export options plus the contract and routes. */
export interface OpenApiPluginOptions extends ToOpenApiOptions
{
    /** The contract the served document describes. */
    contract: Contract;

    /** Where the document is served. Default '/openapi.json'. */
    route?: string;

    /**
     * Where the docs page is served, or `false` for spec-only. Default '/docs'.
     */
    docs?: string | false;

    /**
     * Which viewer the docs page carries. Default `'scalar'`: a tiny shell that loads
     * the Scalar reference from a CDN in the browser - best-in-class UI, needs internet
     * while viewing. `'azeroth'`: the house explorer - one fully self-contained page
     * (inline styles/script, zero external requests, works offline) in the AzerothJS
     * design language, try-it included.
     */
    viewer?: 'scalar' | 'azeroth';
}

/**
 * Serves the contract's OpenAPI document - generated once at install (contracts are
 * immutable values), served from cached bytes - and, unless `docs: false`, the house
 * explorer page beside it. An ordinary plugin: two GET routes, nothing else. External
 * viewers (Scalar, Redoc, Swagger UI) read the document route directly.
 */
export function openapiPlugin(options: OpenApiPluginOptions): AzerothPlugin
{
    return {
        name: 'azerothjs-openapi',
        install(app: App): App
        {
            // Generated once, served as cached bytes - a contract is an immutable value.
            const specRoute = options.route ?? '/openapi.json';
            const payload = JSON.stringify(toOpenApi(options.contract, options));
            app.get(specRoute, () =>
                new Response(payload, { headers: { 'content-type': 'application/json; charset=utf-8' } }));
            if (options.docs !== false)
            {
                const page = options.viewer === 'azeroth'
                    ? renderExplorerHtml(specRoute, options.info.title)
                    : renderScalarHtml(specRoute, options.info.title);
                app.get(options.docs ?? '/docs', () =>
                    new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
            }
            return app;
        }
    };
}

/**
 * The coverage report for partial adoption: every route registered on the app that the
 * contract does NOT cover (compared under `prefix`). Call it AFTER all registration -
 * an honest list for the migration burndown, never a guess.
 */
export function uncontracted(app: App, contract: Contract, prefix = '/api'): string[]
{
    // Compare parsed (method, pattern) pairs, never formatted strings - the routes()
    // table's whitespace is presentation, and coupling to it would rot silently.
    const covered = new Set(flatten(contract).map(({ route }) => `${ route.method } ${ prefix }${ route.path as string }`));
    return app.routes().filter((line) =>
    {
        const [method, ...rest] = line.trim().split(/\s+/);
        return !covered.has(`${ method ?? '' } ${ rest.join(' ') }`);
    });
}
