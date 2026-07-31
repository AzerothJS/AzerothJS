/**
 * MODULE: api - the typed, colocated API layer
 *
 * Declare a FEATURE once - routes, schemas, guards, handlers, docs, colocated - register the
 * record on the app, and three consumers read the same declaration: the server (`register`),
 * the typed client (`typeof` + the projected manifest), and the OpenAPI document. One
 * declaration, no codegen, no drift, and the route name written exactly once.
 *
 * A browser bundle imports from '@azerothjs/http/api/shared' - the client, the error type,
 * and the declaration TYPES, with zero server code. This root entry adds the server half
 * (feature + register + guard + the exporters).
 */

export { feature, guard, manifestOf } from './feature.ts';
export type { Verbs, AdditionsOf, BodySpec, BodylessSpec, FormSpec, RawSpec, StreamSpec, StreamConnection } from './feature.ts';

export { register } from './register.ts';
export type { RegisterOptions } from './register.ts';

export { reply, pathOf } from './declare.ts';
export type {
    Decl, AnyDecl, Routes, Feature, Manifest, ManifestEntry, RouteKind, RouteSchema, RouteDocs, ApiMethod,
    PathParams, HandlerContext, StatusReply, ReplyOf, MultipartInput, ContractFile,
    Guard, ExactGuard, GuardContext
} from './declare.ts';

export { toOpenApi, openapiPlugin, uncontracted } from './openapi.ts';
export type { OpenApiDocument, ToOpenApiOptions, OpenApiPluginOptions } from './openapi.ts';

export { createClient, ApiError } from './client.ts';
export type { ClientOf, FeatureClient, ClientOptions, Call, CallArgs } from './client.ts';
