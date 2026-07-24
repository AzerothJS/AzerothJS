/**
 * MODULE: api/client-entry - the browser-safe subset ('@azerothjs/api/client')
 *
 * Everything a client bundle needs and nothing it must not carry: contract declaration
 * (shared files import defineContract/route from here too), the typed client, and the
 * error type. The server half (implementContract, mountApi) lives only in the root entry,
 * so importing this path can never drag @azerothjs/http - or anything Node - into a bundle.
 */

export { defineContract, route, get, post, put, patch, del, query, guard } from './define.ts';
export type { Contract, AnyRoute, Route, RouteDocs, ApiMethod, PathParams, Guard, GuardContext } from './define.ts';

export { createClient, ApiError } from './client.ts';
export type { ClientOf, ClientOptions, Call, CallArgs } from './client.ts';
