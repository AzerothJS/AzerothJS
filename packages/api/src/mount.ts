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

import type { App, RequestContext } from '@azerothjs/http';
import { ValidationError, HttpError, json, readJson } from '@azerothjs/http';
import {
    isRoute, type AnyRoute, type Contract, type Implementation,
    type GuardMap, type HandlersWithGuards, type Guard
} from './define.ts';

/**
 * A guard the `guards` map attaches to contract routes: the same shape as the app's
 * scoped middleware - return an object to add request context (merged flat onto the
 * one context the handler receives), a Response to short-circuit, throw to reject, or
 * nothing to pass through.
 */
export type ApiGuard = (context: RequestContext) => unknown;

/** Options for {@link mountApi}. */
export interface MountOptions
{
    /** The path prefix every route is served under. Default '/api'. */
    prefix?: string;

    /**
     * Guards by contract tree path - the mount-site answer to "which routes need which
     * middleware" that keeps the contract itself client-safe. Keys are dotted paths
     * (`'auth.signIn'`), group wildcards (`'auth.*'`), or the global `'*'`; every
     * matching level applies, outermost first (global, then group, then exact).
     *
     * ```ts
     * mountApi(app, implementation, { guards: {
     *     '*': [rateLimit],
     *     'auth.signIn': [authThrottle],
     *     'account.*': [requireAuth]
     * } });
     * ```
     */
    guards?: Record<string, ReadonlyArray<ApiGuard>>;
}

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
 * The legacy form - `mountApi(app, implementContract(contract, handlers), { guards })` -
 * is retained for separate construction; its handlers type WITHOUT guard additions, so
 * a guarded route there reads them via a knowing cast. Route conflicts surface at boot.
 */
export function mountApi<Shape extends Contract, Guards extends GuardMap<Shape>>(
    app: App<never> | App, contract: Shape, options: TypedMountOptions<Shape, Guards>
): void;
export function mountApi(app: App<never> | App, implementation: Implementation, options?: MountOptions): void;
export function mountApi(
    app: App<never> | App,
    second: Contract | Implementation,
    options: TypedMountOptions<Contract, GuardMap<Contract>> | MountOptions = {}
): void
{
    // Unified form: `handlers` in the options, `second` is the raw contract. Legacy form:
    // `second` is a pre-built Implementation, handlers come off it.
    const opts = options as { prefix?: string; guards?: Record<string, ReadonlyArray<Guard>>; handlers?: HandlerTree };
    const unified = opts.handlers !== undefined;
    const contract = unified ? (second as Contract) : (second as Implementation).contract;
    const handlers = (unified ? opts.handlers : (second as Implementation).handlers) as unknown as HandlerTree;
    walk(app, contract, handlers, opts.prefix ?? '/api', '', opts.guards ?? {});
}

/** @internal The guard chain for one tree path: global, then group levels, then exact. */
function guardsFor(guards: Record<string, ReadonlyArray<ApiGuard>>, treePath: string): ApiGuard[]
{
    const chain: ApiGuard[] = [...guards['*'] ?? []];
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
function walk(app: App, node: Contract, handlers: HandlerTree, prefix: string, treePath: string, guards: Record<string, ReadonlyArray<ApiGuard>>): void
{
    for (const [key, child] of Object.entries(node))
    {
        const at = treePath === '' ? key : `${ treePath }.${ key }`;
        const handler = handlers[key];
        if (isRoute(child))
        {
            if (typeof handler !== 'function')
            {
                throw new Error(`The contract route "${ at }" has no handler. implementContract enforces this at `
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

/** @internal A validation outcome unified across native and Standard Schema validators. */
interface ParseOk { ok: true; value: unknown }
interface ParseErr { ok: false; errors: Record<string, string>; issues?: ReadonlyArray<{ path: string; code: string; message: string }> }

/**
 * @internal Validates `value` through a route schema, native OR Standard Schema. A native
 * schema keeps its one-pass `safeParse` (and its `meta` still feeds OpenAPI); a
 * `~standard` schema (Zod/Valibot/ArkType) runs `~standard.validate` and its issues map
 * to the same flat field-path errors the whole framework speaks.
 */
async function parseAny(schema: unknown, value: unknown): Promise<ParseOk | ParseErr>
{
    const native = schema as { safeParse?: (v: unknown) => ParseOk | ParseErr };
    if (typeof native.safeParse === 'function')
    {
        return native.safeParse(value);
    }
    const standard = (schema as { ['~standard']: { validate: (v: unknown) => unknown } })['~standard'];
    const result = await standard.validate(value) as
        { value: unknown; issues?: undefined } | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> };
    if (result.issues === undefined)
    {
        return { ok: true, value: result.value };
    }
    const errors: Record<string, string> = {};
    const issues: Array<{ path: string; code: string; message: string }> = [];
    for (const issue of result.issues)
    {
        const path = (issue.path ?? []).map((seg) => typeof seg === 'object' ? String(seg.key) : String(seg)).join('.') || 'root';
        errors[path] = errors[path] ?? issue.message;
        issues.push({ path, code: 'invalid', message: issue.message });
    }
    return { ok: false, errors, issues };
}

/** @internal One route -> one endpoint with the guard + validation pipeline around the handler. */
function register(app: App, definition: AnyRoute, handler: (context: unknown) => unknown, prefix: string, guards: ReadonlyArray<ApiGuard>): void
{
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
            const parsed = await parseAny(definition.input, await readJson(context.request));
            if (!parsed.ok)
            {
                throw new ValidationError(parsed.errors, 'Validation failed', parsed.issues);
            }
            shaped.input = parsed.value;
        }

        const result = await handler(context);

        if (result instanceof Response)
        {
            return result;
        }

        if (definition.output !== undefined)
        {
            const parsed = await parseAny(definition.output, result);
            if (!parsed.ok)
            {
                // The handler broke its own declared contract - a server bug. The details
                // stay OUT of the wire (a 500 hides internals); the message goes to the log.
                throw new HttpError(500, `Endpoint ${ definition.method } ${ definition.path } returned a value `
                    + `violating its output schema: ${ Object.keys(parsed.errors).join(', ') }`,
                { code: 'contract-violation' });
            }
            return json(parsed.value);
        }
        return json(result);
    });
}
