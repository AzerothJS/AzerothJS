/**
 * MODULE: api/register - installing declared features on the HTTP app
 *
 * `register(app, { keys, orgs })` walks each feature's declarations and installs one endpoint
 * per route with the guard chain and validation AT the boundary, so a handler's `input`/`query`
 * are exactly their schemas' types or the request never reaches it:
 *
 *   - input/query failures throw the HTTP layer's ValidationError - the 422 whose
 *     `details.fields` is the flat field-path map the browser form's setError consumes.
 *     One schema, both sides: the same rules that validated the form client-side reject
 *     the forged request server-side, in the same shape.
 *   - OUTPUT is validated too, when declared. A handler returning something off-declaration
 *     is a SERVER bug: it maps to a hidden 500 (code 'contract-violation'), never to a
 *     silently wrong payload the client misparses three services later.
 *   - a handler may return a raw Response (redirects, files) and bypass output validation
 *     knowingly - the escape hatch is visible in the return type; `r.raw` routes are that
 *     escape hatch declared as a KIND, guard-covered and spec-visible.
 *
 * The record you register is the record you describe and the record you type the client from -
 * `register` RETURNS it so the value provably flows through: the record key becomes the OpenAPI
 * tag, the operation-id prefix, and the client namespace, written once.
 */

import type { App, MultipartOptions } from '../index.ts';
import { ValidationError, HttpError, json, readJson, readMultipart, sse } from '../index.ts';
import type { AnyDecl, AnyGuard, Feature } from './declare.ts';
import { isStatusReply, pathOf, responseSchemaFor } from './declare.ts';
import { parseAny } from '../body.ts';
import type { StreamConnection } from './feature.ts';

/** Options for {@link register}. */
export interface RegisterOptions
{
    /** The path prefix every feature is served under. Default '/api'. */
    prefix?: string;
}

/**
 * Registers a record of features on the app and returns the SAME record, so the value handed to
 * `openapiPlugin({ features })` and `typeof`'d by the client is provably the one that was
 * installed. Route conflicts (two features declaring one method + path) fail at boot through
 * the router, exactly like any duplicate route.
 *
 * ```ts
 * export const api = register(app, { orgs, keys, webhooks });
 * app.register(openapiPlugin({ features: api, info }));
 * ```
 */
export function register<Features extends Record<string, Feature>>(
    app: App<never> | App, features: Features, options: RegisterOptions = {}
): Features
{
    const prefix = options.prefix ?? '/api';
    for (const built of Object.values(features))
    {
        for (const declaration of Object.values(built.routes))
        {
            installRoute(app as App, declaration, pathOf(built.prefix, declaration.path as string, prefix), declaration.guards ?? built.guards);
        }
    }
    return features;
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

/** @internal One declaration -> one endpoint with the guard + validation pipeline around the handler. */
function installRoute(app: App, declaration: AnyDecl, fullPath: string, guards: ReadonlyArray<AnyGuard>): void
{
    const handler = declaration.handler as (context: unknown, connection?: StreamConnection) => unknown;

    app.route(declaration.method, fullPath, async (context) =>
    {
        // Guards mirror the app's own middleware composition: an object return adds
        // request context (merged FLAT onto the one context), a Response short-circuits,
        // a throw rejects.
        for (const guardFn of guards)
        {
            const added = await guardFn(context);
            if (added instanceof Response)
            {
                return added;
            }
            if (added !== null && added !== undefined && typeof added === 'object')
            {
                Object.assign(context, added);
            }
        }

        // The handler-owned kinds: past the guards, the declaration hands over the exchange.
        if (declaration.kind === 'raw')
        {
            return await handler(context) as Response;
        }
        if (declaration.kind === 'stream')
        {
            // The kernel's SSE machinery drives the wire (heartbeats, backpressure, done
            // marker); the handler receives the guarded context plus the live connection.
            return sse(context.request, (connection) => void handler(context, connection));
        }

        const shaped = context as { input?: unknown; query?: unknown };
        if (declaration.spec.query !== undefined)
        {
            const parsed = await parseAny(declaration.spec.query, firstValueWins(context.url.searchParams));
            if (!parsed.ok)
            {
                throw new ValidationError(parsed.errors, 'Invalid query', parsed.issues);
            }
            shaped.query = parsed.value;
        }

        if (declaration.kind === 'form' || declaration.spec.input !== undefined)
        {
            // A guard that read the body (verifying an HMAC over the raw bytes is the reason to
            // write one) leaves the stream consumed, and the read below would fail with a locked
            // -stream TypeError surfacing as an opaque 500. Say what happened and what to do:
            // a guard that needs the bytes must hand them on by replacing `context.request`.
            if (context.request.bodyUsed)
            {
                throw new HttpError(500, 'A guard consumed the request body before the route could validate it. '
                    + 'A guard that reads the body must hand the bytes on by replacing context.request with a '
                    + 'new Request built from them, or the route cannot validate its input.',
                { code: 'body-already-read' });
            }
        }

        if (declaration.kind === 'form')
        {
            // The declared file route: parse within the caps, validate the text fields exactly
            // like a JSON body, hand the handler { fields, files }.
            const spec = declaration.spec;
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
        else if (declaration.spec.input !== undefined)
        {
            const parsed = await parseAny(declaration.spec.input, await readJson(context.request));
            if (!parsed.ok)
            {
                throw new ValidationError(parsed.errors, 'Validation failed', parsed.issues);
            }
            shaped.input = parsed.value;
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
            const schema = responseSchemaFor(declaration, result.status);
            if (result.body === undefined)
            {
                return new Response(null, { status: result.status, headers: result.headers ?? {} });
            }
            if (schema !== undefined)
            {
                const parsed = await parseAny(schema, result.body);
                if (!parsed.ok)
                {
                    throw new HttpError(500, `Endpoint ${ declaration.method } ${ fullPath } returned a ${ result.status } body `
                        + `violating its declared schema: ${ Object.keys(parsed.errors).join(', ') }`,
                    { code: 'contract-violation' });
                }
                return json(parsed.value, { status: result.status, headers: result.headers ?? {} });
            }
            return json(result.body, { status: result.status, headers: result.headers ?? {} });
        }

        const okSchema = responseSchemaFor(declaration, 200);
        if (okSchema !== undefined)
        {
            const parsed = await parseAny(okSchema, result);
            if (!parsed.ok)
            {
                // The handler broke its own declared contract - a server bug. The details
                // stay OUT of the wire (a 500 hides internals); the message goes to the log.
                throw new HttpError(500, `Endpoint ${ declaration.method } ${ fullPath } returned a value `
                    + `violating its declared 200 schema: ${ Object.keys(parsed.errors).join(', ') }`,
                { code: 'contract-violation' });
            }
            return json(parsed.value);
        }
        return json(result);
    });
}
