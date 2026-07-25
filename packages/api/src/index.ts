/**
 * MODULE: api - the typed contract between an AzerothJS server and its clients
 *
 * Declare a CONTRACT once (routes + schemas, no handlers - client-safe by construction),
 * implement it server-side with derived handler signatures, mount it with validation at
 * the boundary, and call it through a fully inferred client whose failures land in the
 * browser form's own error shape. One declaration, no codegen, no drift.
 *
 * Browser bundles import from '@azerothjs/api/client' (contract + client + errors, zero
 * server code); this root entry adds the server half (the unified mountApi + guard).
 */

export { defineContract, route, get, post, put, patch, del, query, guard } from './define.ts';
export type {
    Contract, AnyRoute, Route, RouteDocs, ApiMethod, PathParams, HandlerContext,
    Guard, GuardContext, GuardKey, GuardMap, HandlersWithGuards
} from './define.ts';

export { mountApi } from './mount.ts';
export type { TypedMountOptions } from './mount.ts';

export { toOpenApi, openapiPlugin, uncontracted } from './openapi.ts';
export type { OpenApiDocument, ToOpenApiOptions, OpenApiPluginOptions } from './openapi.ts';

export { createClient, ApiError } from './client.ts';
export type { ClientOf, ClientOptions, Call, CallArgs } from './client.ts';
