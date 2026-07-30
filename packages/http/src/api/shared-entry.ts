/**
 * MODULE: api/shared-entry - the half both sides import ('@azerothjs/http/api/shared')
 *
 * A contract is ONE declaration that the browser and the server both read, so the file
 * declaring it must be safe to bundle. This entry is that safe half: the declaration
 * (`defineContract`, the verb helpers, `group`, `merge`), the typed client, and the error type -
 * and nothing else. Everything a guard or a mount needs lives only in the root entry, so
 * importing this path can never drag @azerothjs/http, or anything Node, into a browser bundle.
 *
 * The name is the point: `shared`, not `client`. Importing `defineContract` from a path
 * called "client" read as "contracts are a client-side thing", which is the opposite of the
 * truth and cost at least one reader a wrong mental model.
 */

export { defineContract, route, get, post, put, patch, del, query, group, merge, multipart } from './define.ts';
export type { Contract, AnyRoute, Route, RouteDocs, ApiMethod, PathParams, MultipartInput, MultipartConfig, ContractFile } from './define.ts';

export { createClient, ApiError } from './client.ts';
export type { ClientOf, ClientOptions, Call, CallArgs } from './client.ts';
