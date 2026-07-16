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

import { App, ValidationError, HttpError, json, readJson } from '@azerothjs/http';
import { isRoute, type AnyRoute, type Contract, type Implementation } from './define.ts';

/**
 * Mounts every route of the implementation on `app` under `prefix` (default '/api').
 * Route conflicts surface at boot through the router, like any other route. A handler
 * missing at runtime (an untyped caller bypassing implementContract) fails HERE, at boot.
 */
export function mountApi(app: App<never> | App, implementation: Implementation, options: { prefix?: string } = {}): void
{
    walk(app, implementation.contract, implementation.handlers, options.prefix ?? '/api', '');
}

/** @internal The runtime (type-erased) view of the handler tree. */
interface HandlerTree
{
    [key: string]: HandlerTree | ((args: unknown) => unknown);
}

/** @internal */
function walk(app: App, node: Contract, handlers: HandlerTree, prefix: string, treePath: string): void
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
            register(app, child, handler, prefix);
        }
        else
        {
            if (typeof handler !== 'object' || (handler as unknown) === null)
            {
                throw new Error(`The contract group "${ at }" has no matching handler group.`);
            }
            walk(app, child, handler, prefix, at);
        }
    }
}

/** @internal One route -> one endpoint with the validation pipeline around the handler. */
function register(app: App, definition: AnyRoute, handler: (args: unknown) => unknown, prefix: string): void
{
    app.route(definition.method, `${ prefix }${ definition.path }`, async (request, ctx) =>
    {
        let query: unknown;
        if (definition.query !== undefined)
        {
            const raw: Record<string, string> = {};
            for (const [key, value] of ctx.url.searchParams)
            {
                raw[key] = raw[key] ?? value; // first value wins, deterministically
            }
            const parsed = definition.query.safeParse(raw);
            if (!parsed.ok)
            {
                throw new ValidationError(parsed.errors, 'Invalid query', parsed.issues);
            }
            query = parsed.value;
        }

        let input: unknown;
        if (definition.input !== undefined)
        {
            const parsed = definition.input.safeParse(await readJson(request));
            if (!parsed.ok)
            {
                throw new ValidationError(parsed.errors, 'Validation failed', parsed.issues);
            }
            input = parsed.value;
        }

        const result = await handler({ params: ctx.params, input, query, request });

        if (result instanceof Response)
        {
            return result;
        }

        if (definition.output !== undefined)
        {
            const parsed = definition.output.safeParse(result);
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
