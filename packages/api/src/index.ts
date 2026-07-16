/**
 * MODULE: api - the typed contract between an AzerothJS server and its clients
 *
 * Declare a CONTRACT once (routes + schemas, no handlers - client-safe by construction),
 * implement it server-side with derived handler signatures, mount it with validation at
 * the boundary, and call it through a fully inferred client whose failures land in the
 * browser form's own error shape. One declaration, no codegen, no drift.
 *
 * Browser bundles import from '@azerothjs/api/client' (contract + client + errors, zero
 * server code); this root entry adds the server half (implementContract + mountApi).
 */

export { defineContract, route, implementContract } from './define.ts';
export type {
    Contract, AnyRoute, Route, ApiMethod, PathParams, HandlerArgs, HandlerFor, HandlersOf, Implementation
} from './define.ts';

export { mountApi } from './mount.ts';

export { createClient, ApiError } from './client.ts';
export type { ClientOf, ClientOptions, Call, CallArgs } from './client.ts';
