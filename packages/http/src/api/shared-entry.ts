/**
 * MODULE: api/shared-entry - the half both sides import ('@azerothjs/http/api/shared')
 *
 * A browser needs exactly two things from the API layer: the erased TYPE of the server's
 * features (`import type { api } from ...`) and the projected manifest value. This entry is
 * that safe half: the typed client, the error type, and the declaration types - and nothing
 * else. `feature`/`register` live only in the root entry, so importing this path can never
 * drag @azerothjs/http, or anything Node, into a browser bundle.
 *
 * The name is the point: `shared`, not `client`. The declaration types are read by BOTH
 * sides; only the client VALUE here is browser-specific.
 */

export { createClient, ApiError } from './client.ts';
export { manifestScript, readManifest } from './manifest-handoff.ts';
export type { ClientOf, FeatureClient, ClientOptions, Call, CallArgs } from './client.ts';

export type {
    Decl, AnyDecl, Routes, Feature, Manifest, ManifestEntry, RouteKind, RouteDocs, ApiMethod,
    PathParams, HandlerContext, MultipartInput, ContractFile
} from './declare.ts';
