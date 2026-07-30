/**
 * MODULE: api/mount - registering an implemented contract on the HTTP app
 *
 * Walks the contract tree alongside its handlers and registers each route with validation
 * AT the boundary, so a handler's `input`/`query` are exactly their schemas' types or the
 * request never reaches it:
 *
 *   - input/query failures throw the HTTP layer's ValidationError - the 422 whose
 *     `details.fields` is the flat field-path map the browser form's setError consumes.
 *     One schema, both sides: the same rules that validated the form client-side reject
 *     the forged request server-side, in the same shape.
 *   - OUTPUT is validated too, when declared. A handler returning something off-contract
 *     is a SERVER bug: it maps to a hidden 500 (code 'contract-violation'), never to a
 *     silently wrong payload the client misparses three services later.
 *   - a handler may return a raw Response (redirects, files) and bypass output validation
 *     knowingly - the escape hatch is visible in the return type.
 */

import type { App, RequestContext, UploadedFile, MultipartOptions, PathParams as RouterPathParams } from '../index.ts';
import { ValidationError, HttpError, json, readJson, readMultipart } from '../index.ts';
import { isRoute, isStatusReply, isMultipartSpec, type AnyRoute, type Contract, type ContractFile, type GuardMap, type HandlersWithGuards, type PathParams as ContractPathParams } from './define.ts';
import { parseAny } from './validate.ts';

// ContractFile is a client-safe duplicate of http's UploadedFile, and the contract's
// PathParams of the router's pattern inference (define.ts must not import server
// packages). These welds break the build if either pair ever drifts.
type AssertExtends<T extends B, B> = T;
/** @internal Type-only drift weld; never referenced. */
export type UploadedFileMatchesContractFile = AssertExtends<UploadedFile, ContractFile>;
/** @internal Type-only drift weld; never referenced. */
export type ContractFileMatchesUploadedFile = AssertExtends<ContractFile, UploadedFile>;
type WeldPattern = '/users/:id/files/*rest';
/** @internal Type-only drift weld; never referenced. */
export type ContractParamsMatchRouter = AssertExtends<ContractPathParams<WeldPattern>, RouterPathParams<WeldPattern>>;
/** @internal Type-only drift weld; never referenced. */
export type RouterParamsMatchContract = AssertExtends<RouterPathParams<WeldPattern>, ContractPathParams<WeldPattern>>;

/**
 * A guard the `guards` map attaches to contract routes: the same shape as the app's
 * scoped middleware - return an object to add request context (merged flat onto the
 * one context the handler receives), a Response to short-circuit, throw to reject, or
 * nothing to pass through.
 */
type AnyGuard = (context: RequestContext) => unknown;

/** Options for the unified (typed-guard) mount: guards and handlers together. */
export interface TypedMountOptions<Shape extends Contract, Guards extends GuardMap<Shape>>
{
    /** The path prefix every route is served under. Default '/api'. */
    prefix?: string;

    /**
     * Guards by contract tree path. Keys are CHECKED against the contract - a typo is a
     * compile error, never a silently-unguarded route. Each guard's additions (from
     * {@link guard}) flow into the TYPE of every handler it protects; no cast needed.
     */
    guards?: Guards;

    /** The handler tree - each handler's context already carries its guards' additions. */
    handlers: HandlersWithGuards<Shape, Guards>;
}

/**
 * Mounts a contract on the app. The UNIFIED form takes the contract, a typed `guards`
 * map (keys checked against the tree), and the `handlers` - and the guards' context
 * additions flow into each handler's context type, so a guarded handler reads
 * `context.accountId` with no cast:
 *
 * ```ts
 * const requireAuth = guard((context) => ({ accountId: verify(context.request) }));
 * mountApi(app, contract, {
 *     guards: { 'account.*': [requireAuth] },
 *     handlers: { account: { me: (context) => ({ id: context.accountId }) } }
 * });
 * ```
 *
 * Handlers organized in separate factory files stay cast-free by sharing the guards
 * map: a factory returns `HandlersWithGuards<typeof contract, typeof guards>['branch']`.
 * Route conflicts surface at boot.
 */
export function mountApi<Shape extends Contract, Guards extends GuardMap<Shape>>(
    app: App<never> | App, contract: Shape, options: TypedMountOptions<Shape, Guards>
): void
{
    const opts = options as { prefix?: string; guards?: Record<string, ReadonlyArray<AnyGuard>>; handlers: HandlerTree };
    walk(app, contract, opts.handlers, opts.prefix ?? '/api', '', opts.guards ?? {});
}

/** @internal The guard chain for one tree path: global, then group levels, then exact. */
function guardsFor(guards: Record<string, ReadonlyArray<AnyGuard>>, treePath: string): AnyGuard[]
{
    const chain: AnyGuard[] = [...guards['*'] ?? []];
    const parts = treePath.split('.');
    for (let depth = 1; depth < parts.length; depth++)
    {
        chain.push(...guards[`${ parts.slice(0, depth).join('.') }.*`] ?? []);
    }
    chain.push(...guards[treePath] ?? []);
    return chain;
}

/** @internal The runtime (type-erased) view of the handler tree. */
interface HandlerTree
{
    [key: string]: HandlerTree | ((context: unknown) => unknown);
}

/** @internal */
function walk(app: App, node: Contract, handlers: HandlerTree, prefix: string, treePath: string, guards: Record<string, ReadonlyArray<AnyGuard>>): void
{
    for (const [key, child] of Object.entries(node))
    {
        const at = treePath === '' ? key : `${ treePath }.${ key }`;
        const handler = handlers[key];
        if (isRoute(child))
        {
            if (typeof handler !== 'function')
            {
                throw new Error(`The contract route "${ at }" has no handler. the unified mount enforces this at `
                    + 'compile time; a runtime gap means the handlers object was built untyped.');
            }
            register(app, child, handler, prefix, guardsFor(guards, at));
        }
        else
        {
            if (typeof handler !== 'object' || (handler as unknown) === null)
            {
                throw new Error(`The contract group "${ at }" has no matching handler group.`);
            }
            walk(app, child, handler, prefix, at, guards);
        }
    }
}

/** @internal One route -> one endpoint with the guard + validation pipeline around the handler. */
function register(app: App, definition: AnyRoute, handler: (context: unknown) => unknown, prefix: string, guards: ReadonlyArray<AnyGuard>): void
{
    // The response contract per status: the `responses` map, with `output` as the
    // declared shorthand for its 200 entry.
    const responseSchema = (status: number): unknown =>
        (definition.responses as Record<number, unknown> | undefined)?.[status]
            ?? (status === 200 ? definition.output : undefined);

    app.route(definition.method, `${ prefix }${ definition.path }`, async (context) =>
    {
        // Guards mirror the app's own middleware composition: an object return adds
        // request context (merged FLAT onto the one context), a Response short-circuits,
        // a throw rejects.
        for (const guard of guards)
        {
            const added = await guard(context);
            if (added instanceof Response)
            {
                return added;
            }
            if (added !== null && added !== undefined && typeof added === 'object')
            {
                Object.assign(context, added);
            }
        }

        const shaped = context as { input?: unknown; query?: unknown };
        if (definition.query !== undefined)
        {
            const raw: Record<string, string> = {};
            for (const [key, value] of context.url.searchParams)
            {
                raw[key] = raw[key] ?? value; // first value wins, deterministically
            }
            const parsed = await parseAny(definition.query, raw);
            if (!parsed.ok)
            {
                throw new ValidationError(parsed.errors, 'Invalid query', parsed.issues);
            }
            shaped.query = parsed.value;
        }

        if (definition.input !== undefined)
        {
            if (isMultipartSpec(definition.input))
            {
                // The contract-level file route: parse within the caps, validate the text
                // fields exactly like a JSON body, hand the handler { fields, files }.
                const spec = definition.input;
                const caps: MultipartOptions = {};
                if (spec.limit !== undefined)
                {
                    caps.limit = spec.limit;
                }
                if (spec.maxParts !== undefined)
                {
                    caps.maxParts = spec.maxParts;
                }
                if (spec.maxFileSize !== undefined)
                {
                    caps.maxFileSize = spec.maxFileSize;
                }
                const body = await readMultipart(context.request, caps);
                const raw: Record<string, string> = {};
                for (const [key, value] of body.fields)
                {
                    raw[key] = raw[key] ?? value; // first value wins, deterministically (same policy as query)
                }
                let fields: unknown = raw;
                if (spec.fields !== undefined)
                {
                    const parsed = await parseAny(spec.fields, raw);
                    if (!parsed.ok)
                    {
                        throw new ValidationError(parsed.errors, 'Validation failed', parsed.issues);
                    }
                    fields = parsed.value;
                }
                shaped.input = { fields, files: body.files };
            }
            else
            {
                const parsed = await parseAny(definition.input, await readJson(context.request));
                if (!parsed.ok)
                {
                    throw new ValidationError(parsed.errors, 'Validation failed', parsed.issues);
                }
                shaped.input = parsed.value;
            }
        }

        const result = await handler(context);

        if (result instanceof Response)
        {
            // The non-JSON escape hatch (files, redirects, streams) - the ONLY return shape
            // that bypasses output validation. Status codes and headers on a JSON body
            // belong to reply(), which stays validated.
            return result;
        }

        // A typed status reply: validate the body against that status's declared schema
        // (responses[status]; output doubles as the 200 schema), then build the Response
        // with the status and headers. A bodyless reply sends an empty response.
        if (isStatusReply(result))
        {
            const schema = responseSchema(result.status);
            if (result.body === undefined)
            {
                return new Response(null, { status: result.status, headers: result.headers ?? {} });
            }
            if (schema !== undefined)
            {
                const parsed = await parseAny(schema, result.body);
                if (!parsed.ok)
                {
                    throw new HttpError(500, `Endpoint ${ definition.method } ${ definition.path } returned a ${ result.status } body `
                        + `violating its declared schema: ${ Object.keys(parsed.errors).join(', ') }`,
                    { code: 'contract-violation' });
                }
                return json(parsed.value, { status: result.status, headers: result.headers ?? {} });
            }
            return json(result.body, { status: result.status, headers: result.headers ?? {} });
        }

        const okSchema = responseSchema(200);
        if (okSchema !== undefined)
        {
            const parsed = await parseAny(okSchema, result);
            if (!parsed.ok)
            {
                // The handler broke its own declared contract - a server bug. The details
                // stay OUT of the wire (a 500 hides internals); the message goes to the log.
                throw new HttpError(500, `Endpoint ${ definition.method } ${ definition.path } returned a value `
                    + `violating its declared 200 schema: ${ Object.keys(parsed.errors).join(', ') }`,
                { code: 'contract-violation' });
            }
            return json(parsed.value);
        }
        return json(result);
    });
}
