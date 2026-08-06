/**
 * MODULE: context-merge - how a middleware's or guard's additions reach the context
 *
 * ONE rule, one implementation. Middleware (the kernel's `App.route` composition) and
 * feature guards (`register`'s per-route chain) both let a function return an object
 * whose properties become request context. Both must refuse the same three names, and
 * for the same reason, so the rule cannot live in two places and drift.
 */

/** @internal Context keys a middleware/guard return may never overwrite. */
const PROTECTED = new Set(['request', 'params', 'url']);

/**
 * Merges an addition object onto the context. `request`, `params` and `url` are readonly
 * to TypeScript and writable at runtime, so a function that returns parsed request data
 * as its additions (`app.use((c) => readJson(c.request))`) would otherwise let a body of
 * `{"params":{"id":"admin"}}` replace the path params a handler authorises on. Own keys
 * only: an addition must never arrive from a polluted prototype.
 *
 * @param context - The live request context.
 * @param addition - Whatever the middleware/guard returned (non-object values are ignored).
 */
export function mergeAdditions(context: object, addition: unknown): void
{
    if (addition === undefined || addition === null || typeof addition !== 'object')
    {
        return;
    }
    for (const key of Object.keys(addition))
    {
        if (!PROTECTED.has(key))
        {
            (context as Record<string, unknown>)[key] = (addition as Record<string, unknown>)[key];
        }
    }
}
