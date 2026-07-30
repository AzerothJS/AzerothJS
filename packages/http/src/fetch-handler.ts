/**
 * MODULE: http/fetch-handler - the WinterCG entry
 *
 * The kernel is pure fetch-standard (Request in, Response out, `handle` never throws),
 * so any runtime whose deployment unit is a `fetch` function - Cloudflare Workers,
 * Deno Deploy, Bun.serve, Vercel Edge - can host an App directly. This is the ~1-line
 * bridge that makes that explicit and typed, without the Node adapter ever loading.
 *
 *   // Cloudflare Workers / WinterCG
 *   import { App, json, toFetchHandler } from '@azerothjs/http';
 *   const app = new App();
 *   app.get('/hello', () => json({ hi: true }));
 *   export default { fetch: toFetchHandler(app) };
 *
 *   // Bun
 *   Bun.serve({ fetch: toFetchHandler(app) });
 *
 * Node stays on `serve()` from '@azerothjs/http/node' (real sockets, graceful
 * shutdown, keep-alive tuning); this bridge is for fetch-hosted runtimes.
 *
 * NOTE on request roots: the default per-request store isolation rides on
 * AsyncLocalStorage (node:async_hooks) - implemented by Bun, Deno, and workerd
 * (Cloudflare's nodejs_compat). On a runtime without it, construct the app with
 * `new App({ requestRoot: false })`.
 *
 * NOTE on client identity: a fetch-hosted request carries no socket, so `clientIp()` has
 * nothing to read and `rateLimit()` REFUSES rather than silently keying every request in the
 * world to one bucket. Give the limiter an explicit key drawn from whatever header the platform
 * itself sets and guarantees - `CF-Connecting-IP` on Cloudflare, the platform's own forwarded
 * header elsewhere - because on this transport that header is the only identity available, and
 * it is trustworthy only because the platform, not the caller, wrote it:
 *
 *   rateLimit({ limit: 100, windowMs: 60_000,
 *       key: (request) => request.headers.get('cf-connecting-ip') ?? 'anonymous' })
 */

import type { WebHandler } from './edge.ts';

/**
 * Wraps an App (or anything with its `handle` shape) as a bare WinterCG fetch
 * function.
 *
 * @param app - The app whose `handle` maps one Request to one Response.
 * @returns `(request) => Promise<Response>` - hand it to the runtime's fetch slot.
 */
export function toFetchHandler(app: WebHandler): (request: Request) => Promise<Response>
{
    return (request: Request): Promise<Response> => app.handle(request);
}
