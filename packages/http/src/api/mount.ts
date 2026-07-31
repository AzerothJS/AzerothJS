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
import { isRoute, isStatusReply, isMultipartSpec, isOnly, responseSchemaFor, type AnyRoute, type Contract, type ContractFile, type GuardMap, type HandlersWithGuards, type PathParams as ContractPathParams } from './define.ts';
import type { ONLY } from './define.ts';
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

/** @internal An `only` entry as the mount sees it, with the guard types erased. */
interface OnlyEntry
{
    readonly [ONLY]: true;
    readonly guards: ReadonlyArray<AnyGuard>;
}

/** @internal One guards-map entry, type-erased: a plain chain, or an `only` wrapper. */
type GuardEntryView = ReadonlyArray<AnyGuard> | OnlyEntry;

/** Options for the unified (typed-guard) mount: guards and handlers together. */
export interface TypedMountOptions<Shape extends Contract, Guards extends GuardMap<Shape>>
{
    /** The path prefix every route is served under. Default '/api'. */
    prefix?: string;

    /**
     * Guards by contract tree path. A key that addresses no route THROWS at mount: the type
     * alone cannot catch it, because `Guards` is inferred from this literal and TypeScript's
     * excess-property check only fires when no key at all is valid. Each guard's additions
     * (from {@link guard}) flow into the TYPE of every handler it protects; no cast needed.
     */
    guards?: Guards;

    /**
     * The handlers, keyed by the SAME dotted route path the `guards` map uses - one key space for
     * both, and no tree to mirror. Each handler's context already carries its guards' additions.
     */
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
 *     guards:   { 'account.*': [requireAuth] },
 *     handlers: { 'account.me': (context) => ({ id: context.accountId }) }
 * });
 * ```
 *
 * Guards and handlers share ONE key space - the dotted contract path - so neither rebuilds the
 * tree the contract already declares. Handlers written in separate feature files compose with a
 * plain spread, and a feature never has to know which group it lands under; type each one against
 * its own routes with {@link implement}. Route conflicts surface at boot.
 */
export function mountApi<Shape extends Contract, Guards extends GuardMap<Shape>>(
    app: App<never> | App, contract: Shape, options: TypedMountOptions<Shape, Guards>
): void
{
    const opts = options as { prefix?: string; guards?: Record<string, GuardEntryView>; handlers: HandlerMapView };
    const guards = opts.guards ?? {};
    const routePaths: string[] = [];
    walk(app, contract, opts.handlers, opts.prefix ?? '/api', '', guards, routePaths);
    assertGuardKeysMatch(guards, routePaths);
}

/**
 * @internal Every guard key must address at least one route. The TYPE cannot be relied on for
 * this: `Guards` is inferred from the map literal, so TypeScript's excess-property check only
 * fires when NO key is valid, and every real map has a valid key (usually `'*'`). A key that
 * matches nothing is therefore silent, and it is silent in the one direction that matters - a
 * renamed group, or a wildcard written for an absolute path then mounted as a subtree, leaves
 * its routes with no guard at all. A pure gate (auth, CSRF, rate limit) adds nothing to the
 * context, so its absence changes no handler type either. Fail at boot, like a missing handler.
 */
function assertGuardKeysMatch(guards: Record<string, GuardEntryView>, routePaths: readonly string[]): void
{
    for (const key of Object.keys(guards))
    {
        if (key === '*')
        {
            continue;
        }
        const matched = key.endsWith('.*')
            ? routePaths.some((path) => path.startsWith(key.slice(0, -1)))
            : routePaths.includes(key);
        if (!matched)
        {
            throw new Error(`The guard key "${ key }" matches no route in this mount. Its guards would `
                + 'never run, leaving the routes it was meant to protect unguarded. Known routes: '
                + `${ routePaths.join(', ') }. When mounting a GROUP, keys are relative to it.`);
        }
    }
}

/**
 * @internal The guard chain for one tree path: global, then group levels, then exact - unless
 * the exact entry is an `only` list, which REPLACES everything it would have inherited.
 */
function guardsFor(guards: Record<string, GuardEntryView>, treePath: string): AnyGuard[]
{
    // Every lookup is own-property only: a route keyed `toString` or `constructor` would
    // otherwise resolve to the inherited function and be spread as a guard chain.
    const at = (key: string): GuardEntryView | undefined => (Object.hasOwn(guards, key) ? guards[key] : undefined);

    // An `only` entry is a WRAPPER, not an array, so every spread has to unwrap it. The opt-out
    // is exact-path only, but nothing stops one being written on a wildcard key, where it
    // degrades to a plain chain - and spreading the wrapper itself would throw at mount.
    const chainOf = (entry: GuardEntryView | undefined): ReadonlyArray<AnyGuard> =>
    {
        if (entry === undefined)
        {
            return [];
        }
        return Array.isArray(entry) ? entry as ReadonlyArray<AnyGuard> : (entry as OnlyEntry).guards;
    };

    const exact = at(treePath);
    if (exact !== undefined && isOnly(exact))
    {
        return [...exact.guards as ReadonlyArray<AnyGuard>];
    }

    const chain: AnyGuard[] = [...chainOf(at('*'))];
    const parts = treePath.split('.');
    for (let depth = 1; depth < parts.length; depth++)
    {
        chain.push(...chainOf(at(`${ parts.slice(0, depth).join('.') }.*`)));
    }
    chain.push(...chainOf(exact));
    return chain;
}

/** @internal The runtime (type-erased) view of the handler map: one entry per dotted route path. */
interface HandlerMapView
{
    [routePath: string]: ((context: unknown) => unknown) | undefined;
}

/**
 * @internal Flattens repeatable entries to one value per name, FIRST wins - the policy for both a
 * query string and a multipart field set, which are the two places a name can legally repeat. One
 * function so the two cannot answer `?a=1&a=2` differently.
 */
function firstValueWins(entries: Iterable<[string, string]>): Record<string, string>
{
    // Null-prototype: a field named `constructor` or `toString` would otherwise read the
    // inherited member, discard the client's real value, and 422 the route forever.
    const out: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, value] of entries)
    {
        if (!Object.hasOwn(out, key))
        {
            out[key] = value;
        }
    }
    return out;
}

/**
 * @internal Walks the CONTRACT and registers each leaf, addressing handlers and guards through
 * the same dotted path. The handler map is flat: the tree shape lives in the contract, which is
 * the only place it is declared, so a handler map never mirrors it.
 */
function walk(app: App, node: Contract, handlers: HandlerMapView, prefix: string, treePath: string, guards: Record<string, GuardEntryView>, routePaths: string[]): void
{
    for (const [key, child] of Object.entries(node))
    {
        const at = treePath === '' ? key : `${ treePath }.${ key }`;
        if (isRoute(child))
        {
            routePaths.push(at);
            const handler = Object.hasOwn(handlers, at) ? handlers[at] : undefined;
            if (typeof handler !== 'function')
            {
                // A handler present under the BARE key is the implement()/mountApi key-space
                // mismatch, not a missing handler: implement() keys relative to the routes it was
                // given (the only space a feature file can know), while a mount over the whole
                // contract keys from the root. Saying so turns a boot failure into a fix.
                if (Object.hasOwn(handlers, key) && typeof handlers[key] === 'function')
                {
                    const root = at.slice(0, -(key.length + 1));
                    throw new Error(`The contract route "${ at }" has no handler, but "${ key }" is present. `
                        + `implement() keys relative to the routes it was passed, so its map is "${ key }" while `
                        + `this mount counts from the contract root and wants "${ at }". Either mount the subtree `
                        + `- mountApi(app, contract.${ root }, { prefix, handlers }) - or key the map "${ at }".`);
                }
                throw new Error(`The contract route "${ at }" has no handler. The mount enforces this at `
                    + 'compile time; a runtime gap means the handlers map was built untyped.');
            }
            register(app, child, handler, prefix, guardsFor(guards, at));
        }
        else
        {
            walk(app, child, handlers, prefix, at, guards, routePaths);
        }
    }
}

/** @internal One route -> one endpoint with the guard + validation pipeline around the handler. */
function register(app: App, definition: AnyRoute, handler: (context: unknown) => unknown, prefix: string, guards: ReadonlyArray<AnyGuard>): void
{
    const responseSchema = (status: number): unknown => responseSchemaFor(definition, status);

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
            const parsed = await parseAny(definition.query, firstValueWins(context.url.searchParams));
            if (!parsed.ok)
            {
                throw new ValidationError(parsed.errors, 'Invalid query', parsed.issues);
            }
            shaped.query = parsed.value;
        }

        if (definition.input !== undefined)
        {
            // A guard that read the body (verifying an HMAC over the raw bytes is the reason to
            // write one) leaves the stream consumed, and the read below would fail with a locked
            // -stream TypeError surfacing as an opaque 500. Say what happened and what to do:
            // a guard that needs the bytes must hand them on by replacing `context.request`.
            if (context.request.bodyUsed)
            {
                throw new HttpError(500, 'A guard consumed the request body before the mount could validate it. '
                    + 'A guard that reads the body must hand the bytes on by replacing context.request with a '
                    + 'new Request built from them, or the route cannot validate its input.',
                { code: 'body-already-read' });
            }
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
                const raw = firstValueWins(body.fields);
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
