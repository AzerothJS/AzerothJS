/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The not-found sentinel: the value a loader THROWS to say the URL matched a route but the
 * content behind it does not exist.
 *
 * A route table can only answer "no such ROUTE"; whether `/users/42` has a user behind it is
 * something only the loader knows. Without this the loader's only channel is an ordinary
 * throw, which is a server FAULT - so the commonest not-found in an application answered 500
 * to clients, crawlers and caches alike.
 *
 * The second member of the same family as {@link redirect}, and travels the same path: the
 * server surfaces it from `matchAndLoad` as the `notFound` outcome the SSR layer already maps
 * to a 404. On the client it stays that level's loader error, where {@link isNotFound} tells
 * it apart from a fault - so an ancestor layout keeps rendering and only the missing level
 * shows its own empty state.
 */

/** @internal The brand distinguishing a not-found sentinel from an ordinary error/value. */
const NOT_FOUND: unique symbol = Symbol('azerothjs.router.notFound');

/** The sentinel {@link notFound} builds; recognized by the router wherever it surfaces. */
export interface NotFound
{
    readonly [NOT_FOUND]: true;
}

/**
 * Builds a not-found sentinel. THROW it from a loader when the route matched but its content
 * does not exist; the server answers 404 instead of 500, and the client leaves the level in a
 * not-found state its own UI can read.
 *
 * @example
 * loader: async ({ params, signal }) =>
 * {
 *     const user = await fetchUser(params.id, signal);
 *     if (user === null) { throw notFound(); }
 *     return user;
 * }
 */
export function notFound(): NotFound
{
    return { [NOT_FOUND]: true };
}

/**
 * Whether a thrown/returned value is a not-found sentinel - the test an error boundary or a
 * component uses to render an empty state rather than a failure.
 */
export function isNotFound(value: unknown): value is NotFound
{
    return typeof value === 'object' && value !== null && (value as { [NOT_FOUND]?: unknown })[NOT_FOUND] === true;
}
