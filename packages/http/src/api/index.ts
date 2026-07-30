/**
 * MODULE: api - the typed contract between an AzerothJS server and its clients
 *
 * Declare a CONTRACT once (routes + schemas, no handlers - client-safe by construction),
 * implement it server-side with derived handler signatures, mount it with validation at
 * the boundary, and call it through a fully inferred client whose failures land in the
 * browser form's own error shape. One declaration, no codegen, no drift.
 *
 * The declaration is SHARED: a contract file (and a browser bundle) imports from
 * '@azerothjs/http/api/shared' - the declaration, the typed client, and the error type, with
 * zero server code. This root entry adds the server half (mountApi + guard + implement).
 */

export { defineContract, route, get, post, put, patch, del, query, group, merge, guard, only, reply, multipart, implement } from './define.ts';
export type {
    Contract, AnyRoute, Route, RouteDocs, ApiMethod, PathParams, HandlerContext, StatusReply, ReplyOf, MultipartInput, MultipartConfig, ContractFile,
    Guard, ExactGuard, GuardContext, GuardEntry, GuardKey, GuardMap, OnlyGuards, HandlersWithGuards, HandlersOf
} from './define.ts';

export { mountApi } from './mount.ts';
export type { TypedMountOptions } from './mount.ts';

export { toOpenApi, openapiPlugin, uncontracted } from './openapi.ts';
export type { OpenApiDocument, ToOpenApiOptions, OpenApiPluginOptions } from './openapi.ts';

export { createClient, ApiError } from './client.ts';
export type { ClientOf, ClientOptions, Call, CallArgs } from './client.ts';
