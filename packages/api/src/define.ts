/**
 * MODULE: api/define - the contract: one shared declaration, both sides of the wire
 *
 * An API is declared as a CONTRACT - a plain value of routes (method + path + input/query/
 * output schemas) with NO handler code - in a file both sides import:
 *
 *   - the client (client.ts) walks the contract to spell real REST calls with full
 *     inference AND validates inputs before they ever leave the browser - the schemas are
 *     the same isomorphic rules the form ran, so this costs no second source of truth;
 *   - the server attaches handlers with `implementContract` - handler signatures are
 *     DERIVED from the contract, so an implementation drifting from its declaration is a
 *     compile error at the definition site - and mounts the result (mount.ts).
 *
 * Why a shared VALUE and not a type-only import: types erase. A client built from
 * `typeof api` alone cannot know methods and paths at runtime; the alternatives are a
 * manifest fetch (a second source of truth), a codegen step (drift plus a build stage), or
 * collapsing REST into RPC-by-tree-path. The contract IS the single source of truth, it
 * contains nothing a browser must not see, and it makes client-side pre-validation free.
 *
 * Path parameters are typed from the pattern string exactly like the HTTP router
 * (`/users/:id` gives `{ id: string }`); the type is duplicated here rather than imported
 * so this module and the client depend on nothing but @azerothjs/schema.
 */

import type { Schema } from '@azerothjs/schema';

/** Infers the param object type from a route pattern string (mirrors @azerothjs/http). */
export type PathParams<Path extends string> =
    Path extends `${ infer Head }/${ infer Rest }`
        ? PathParams<Head> & PathParams<Rest>
        : Path extends `:${ infer Name }`
            ? Name extends '' ? object : { [K in Name]: string }
            : Path extends `*${ infer Name }`
                ? Name extends '' ? object : { [K in Name]: string }
                : object;

// QUERY (RFC 10008) is a safe, idempotent method that carries a request body - a read whose
// parameters are too large or structured for a URL. On a QUERY route, `input` is that body (the
// query document), validated exactly as a POST body is; the handler MUST NOT mutate state.
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'QUERY';

/** One declared route: the wire shape, no behavior. Lives in shared (client-safe) code. */
export interface Route<Path extends string = string, In = undefined, Out = unknown, Query = undefined>
{
    kind: 'route';
    method: ApiMethod;
    path: Path;
    input?: Schema<In>;
    query?: Schema<Query>;
    output?: Schema<Out>;
}

/**
 * Any route regardless of its wire types - the shape membership checks compare against.
 * The `any`s are deliberate, for two reasons. Variance: Schema<T> is invariant (T appears in
 * both parameter and return positions), so a bare `Route` - whose generics default to
 * undefined - would reject every route that actually declares an input, output, or query.
 * Inference: the Path slot must be `any` (not `string`), because this type is the Contract
 * index signature that contextually types the object literal inside defineContract - a
 * `string` there PINS the nested route() calls' Path inference to `string`, silently erasing
 * PathParams and collapsing typed client calls to zero-argument. TypeScript ignores `any`
 * contextual positions during inference, which is exactly the behavior needed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- variance-erasing existential; see the doc comment above
export type AnyRoute = Route<any, any, any, any>;

/** A contract tree: routes grouped under names, nested arbitrarily. */
export interface Contract
{
    [key: string]: AnyRoute | Contract;
}

/** Declares one route. Identity at runtime; the generics carry the wire types. */
export function route<Path extends string, In = undefined, Out = unknown, Query = undefined>(
    definition: {
        method: ApiMethod;
        path: Path;
        input?: Schema<In>;
        query?: Schema<Query>;
        output?: Schema<Out>;
    }
): Route<Path, In, Out, Query>
{
    return { kind: 'route', ...definition };
}

/**
 * Declares a contract tree. Identity at runtime; fixes the type both sides derive from.
 * The `const` type parameter keeps literal properties of the fresh object literal from
 * widening; the deeper literal-preservation story (route paths) lives on AnyRoute's doc.
 */
export function defineContract<const Shape extends Contract>(shape: Shape): Shape
{
    return shape;
}

/** @internal Discriminates a route from a nested group. */
export function isRoute(node: AnyRoute | Contract): node is AnyRoute
{
    return (node as { kind?: unknown }).kind === 'route';
}

/** What a handler receives - each part validated where the contract declared a schema. */
export interface HandlerArgs<Path extends string, In, Query>
{
    /** Decoded path parameters, typed from the pattern. */
    params: PathParams<Path> & Record<string, string>;

    /** The validated input body (undefined when the route declares no input schema). */
    input: In;

    /** The validated query object (undefined when the route declares no query schema). */
    query: Query;

    /** The raw request, for headers/cookies/signal. */
    request: Request;
}

/** The handler an implementation must provide for one route - signature derived. */
export type HandlerFor<R> =
    R extends Route<infer Path, infer In, infer Out, infer Query>
        ? (args: HandlerArgs<Path, In, Query>) => Out | Response | Promise<Out | Response>
        : never;

/** The full handler tree a contract demands. */
export type HandlersOf<Shape extends Contract> =
    {
        [K in keyof Shape]:
        Shape[K] extends AnyRoute ? HandlerFor<Shape[K]>
            : Shape[K] extends Contract ? HandlersOf<Shape[K]> : never;
    };

/** A contract paired with its handlers - what the server mounts. */
export interface Implementation<Shape extends Contract = Contract>
{
    contract: Shape;
    handlers: HandlersOf<Shape>;
}

/**
 * Attaches handlers to a contract, SERVER-SIDE ONLY. Every route must be implemented with
 * exactly the derived signature - a missing handler or a drifted return type fails to
 * compile here, at the earliest possible site.
 */
export function implementContract<Shape extends Contract>(
    contract: Shape,
    handlers: HandlersOf<Shape>
): Implementation<Shape>
{
    return { contract, handlers };
}
