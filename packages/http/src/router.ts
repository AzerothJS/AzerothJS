/**
 * MODULE: http/router - the radix-tree route matcher
 *
 * Routing is a pure data structure with no HTTP in it: insert (method, pattern, value) pairs
 * at startup, then match (method, path) per request. Three design decisions do the heavy
 * lifting:
 *
 *   - NO USER REGEX. Express's path-to-regexp compiles every route into a regex and scans
 *     them linearly - O(routes) per request and a ReDoS CVE history. Here a path walks one
 *     radix tree in O(segments), and nothing user-supplied is ever compiled into a pattern.
 *   - CONFLICTS FAIL LOUDLY AT INSERT. Express lets a later, more specific route be silently
 *     shadowed by an earlier one. Here a duplicate (method, pattern) or two different param
 *     names at the same position throw at registration - boot fails with the exact pair.
 *   - METHOD MISMATCH IS DISTINGUISHED FROM NO MATCH. A path that exists under other methods
 *     reports which ones, so the app layer can emit a correct 405 + Allow instead of a 404.
 *
 * Matching precedence per segment is static > parameter > wildcard, the ecosystem-standard
 * specificity order, applied with BACKTRACKING: if the static branch dead-ends deeper in the
 * tree, the walk retries the param branch, then the wildcard - so `/users/me` and
 * `/users/:id/posts` coexist with `/users/me/settings` without registration-order tricks.
 *
 * Parameter typing is compile-time: `PathParams<'/users/:id/files/*rest'>` infers
 * `{ id: string; rest: string }` from the pattern string itself, so handlers receive typed
 * params with zero runtime cost and no codegen.
 */

/** Infers the param object type from a route pattern string. */
export type PathParams<Path extends string> =
    Path extends `${ infer Head }/${ infer Rest }`
        ? PathParams<Head> & PathParams<Rest>
        : Path extends `:${ infer Name }`
            ? Name extends '' ? object : { [K in Name]: string }
            : Path extends `*${ infer Name }`
                ? Name extends '' ? object : { [K in Name]: string }
                : object;

/** A successful match: the stored value plus the decoded path parameters. */
export interface RouteMatch<T>
{
    kind: 'match';
    value: T;
    params: Record<string, string>;
}

/** The path exists under other methods - the app layer turns this into 405 + Allow. */
export interface RouteMethodMismatch
{
    kind: 'method-mismatch';
    /** The methods registered for this path, for the Allow header. */
    allowed: string[];
}

/** Nothing registered anywhere under this path. */
export interface RouteMiss
{
    kind: 'miss';
}

/**
 * The path is not a valid URI - a percent escape without two hex digits after it. Distinct from
 * a miss because the request-target is malformed rather than unknown; the app layer turns this
 * into 400, not 404.
 */
export interface RouteDecodeError
{
    kind: 'decode-error';
}

/**
 * Everything {@link RadixRouter.route} can answer, as a discriminated union on `kind`: a match
 * carrying the value and decoded params, a method mismatch carrying the Allow set (405), a
 * plain miss (404), or a decode error for malformed percent-escapes (400). One union so a
 * dispatcher must handle all four - there is no throwing path.
 */
export type RouteResult<T> = RouteMatch<T> | RouteMethodMismatch | RouteMiss | RouteDecodeError;

/** One radix-tree node. Children are keyed by literal segment; param/wildcard are singular. */
interface RadixNode<T>
{
    staticChildren: Map<string, RadixNode<T>>;

    /** The `:name` child, if any. One per node: two different names at one position conflict. */
    param: { name: string; node: RadixNode<T> } | null;

    /** The `*name` child, if any. Terminal by construction (validated at insert). */
    wildcard: { name: string; handlers: Map<string, T>; pattern: string } | null;

    /** method -> stored value for routes terminating at this node. */
    handlers: Map<string, T>;

    /** The pattern that first claimed this terminal, for conflict messages. */
    pattern: string | null;
}

function createNode<T>(): RadixNode<T>
{
    return { staticChildren: new Map(), param: null, wildcard: null, handlers: new Map(), pattern: null };
}

/**
 * Splits a path into segments, collapsing duplicate slashes and one trailing slash so
 * `/a//b/` and `/a/b` are the same route. The empty path and `/` both yield [].
 */
export function segmentsOf(path: string): string[]
{
    const segments: string[] = [];
    let start = 0;
    for (let i = 0; i <= path.length; i++)
    {
        if (i === path.length || path.charCodeAt(i) === 47) // '/'
        {
            if (i > start)
            {
                segments.push(path.slice(start, i));
            }
            start = i + 1;
        }
    }
    return segments;
}

/**
 * @internal The sorted method list for an `Allow` header. HEAD is added alongside GET because
 * the router genuinely serves it off a GET registration - RFC 9110 10.2.1 says Allow lists the
 * methods the resource supports, and advertising a set that omits one the server answers is a
 * machine-readable lie clients act on.
 */
function allowedList(methods: Iterable<string>): string[]
{
    const set = new Set(methods);
    if (set.has('GET'))
    {
        set.add('HEAD');
    }
    return [...set].sort();
}

/** @internal A percent escape in a pattern segment: unreachable, since requests decode first. */
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/;

/**
 * A radix-tree router mapping (method, pattern) to a value of the caller's choosing.
 * Patterns are `/literal/:param/*wildcard` - no regex form exists.
 */
export class RadixRouter<T>
{
    readonly #root: RadixNode<T> = createNode();

    /** Every registered (method, pattern) in insertion order, for the printable route table. */
    readonly #registered: Array<{ method: string; pattern: string }> = [];

    /**
     * Registers a route. Throws (synchronously, at startup) on: a duplicate (method, pattern);
     * two different param names at the same tree position; a wildcard that is not the final
     * segment; or an empty param/wildcard name. Failing the boot loudly is the point - a
     * conflicting route table must never reach traffic.
     */
    public insert(method: string, pattern: string, value: T): void
    {
        const segments = segmentsOf(pattern);
        const verb = method.toUpperCase();

        let node = this.#root;
        for (let i = 0; i < segments.length; i++)
        {
            const segment = segments[i];
            if (segment === undefined)
            {
                continue; // segmentsOf returns a dense array; satisfies the indexed-access check
            }

            if (segment.startsWith('*'))
            {
                const name = segment.slice(1);
                if (name === '')
                {
                    throw new Error(`Route "${ pattern }": a wildcard segment needs a name - write "*rest".`);
                }
                if (i !== segments.length - 1)
                {
                    throw new Error(`Route "${ pattern }": the wildcard "*${ name }" must be the final segment.`);
                }
                if (node.wildcard === null)
                {
                    node.wildcard = { name, handlers: new Map(), pattern };
                }
                else if (node.wildcard.name !== name)
                {
                    throw new Error(
                        `Route conflict: "${ pattern }" names its wildcard "*${ name }" but "${ node.wildcard.pattern }" `
                        + `already claimed "*${ node.wildcard.name }" at the same position. One position, one name.`);
                }
                if (node.wildcard.handlers.has(verb))
                {
                    throw new Error(`Route conflict: ${ verb } "${ pattern }" is already registered.`);
                }
                node.wildcard.handlers.set(verb, value);
                this.#registered.push({ method: verb, pattern });
                return;
            }

            if (segment.startsWith(':'))
            {
                const name = segment.slice(1);
                if (name === '')
                {
                    throw new Error(`Route "${ pattern }": a parameter segment needs a name - write ":id".`);
                }
                // ":base...:head" (the compound-segment syntax some URL schemes use) reads as two
                // params but registers as ONE whose name is the whole text - it matches anything
                // and neither "base" nor "head" ever exists. Refusing at boot turns a route that
                // could only 404 into an error naming the fix.
                if (name.includes(':') || name.includes('*'))
                {
                    throw new Error(`Route "${ pattern }": the segment ":${ name }" declares more than one parameter. `
                        + 'A segment holds ONE param; split it into separate segments (":base/:head") or parse the '
                        + 'compound value inside the handler from a single param.');
                }
                if (node.param === null)
                {
                    node.param = { name, node: createNode() };
                }
                else if (node.param.name !== name)
                {
                    throw new Error(
                        `Route conflict: "${ pattern }" names a parameter ":${ name }" where an existing route `
                        + `already uses ":${ node.param.name }". One position, one name - params merge across routes.`);
                }
                node = node.param.node;
                continue;
            }

            // A request segment is percent-DECODED before it is matched, so a pattern carrying an
            // escape can never be reached by the URL it appears to describe: `/my%20page` only
            // matches a request for `/my%2520page`. The route would sit in the table looking
            // served. Write the decoded character instead.
            if (PERCENT_ESCAPE.test(segment))
            {
                throw new Error(`The route pattern "${ pattern }" contains a percent escape in the segment `
                    + `"${ segment }". Request paths are decoded before matching, so this route could only be `
                    + 'reached by a double-encoded URL. Write the decoded character in the pattern.');
            }

            let child = node.staticChildren.get(segment);
            if (child === undefined)
            {
                child = createNode();
                node.staticChildren.set(segment, child);
            }
            node = child;
        }

        if (node.handlers.has(verb))
        {
            throw new Error(`Route conflict: ${ verb } "${ pattern }" is already registered (as "${ node.pattern }").`);
        }
        node.handlers.set(verb, value);
        node.pattern = node.pattern ?? pattern;
        this.#registered.push({ method: verb, pattern });
    }

    /**
     * Matches a request path. Segments are percent-decoded individually; a malformed escape
     * returns a miss (the app layer's 400 lives above this pure structure). HEAD falls back
     * to a GET registration, mirroring what every origin server does.
     */
    public match(method: string, path: string): RouteResult<T>
    {
        // An empty segment is a distinct, significant path component (RFC 3986 3.3), and 6.2.2
        // does not list removing one among the equivalence-preserving normalizations. Collapsing
        // made `//admin` reach `/admin`, which no other mainstream router does, and put this
        // router at odds with every gate keyed on the spelling the client actually sent - a proxy
        // ACL in front, or a prefix check on `url.pathname` above. Tested on the RAW path, before
        // decoding, so an ENCODED `%2F%2F` inside one segment's value is untouched.
        if (path.includes('//'))
        {
            return { kind: 'miss' };
        }

        const segments = segmentsOf(path);
        for (let i = 0; i < segments.length; i++)
        {
            const raw = segments[i];
            if (raw !== undefined && raw.includes('%'))
            {
                try
                {
                    segments[i] = decodeURIComponent(raw);
                }
                catch
                {
                    // Distinct from a miss: a `%` not followed by two hex digits is not a valid
                    // URI at all (RFC 3986 2.1), so the request-target is malformed and the
                    // answer is 400, not "no such resource" (RFC 9110 15.5.1). Reporting it as a
                    // miss is what made this return a 404 while the comment above promised a 400.
                    return { kind: 'decode-error' };
                }
            }
        }

        const verb = method.toUpperCase();
        const pairs: string[] = [];
        // The verb is part of the match, not a lookup after it: a terminal that holds only OTHER
        // methods is a dead end the walk must keep backtracking past, or `app.get('/users/me')`
        // makes `app.post('/users/:id')` answer 405 for that one id with no warning at boot.
        // `allowed` accumulates every method seen on the paths that did match structurally, so
        // the 405 still reports the full set.
        const allowed = new Set<string>();
        const terminal = this.#walk(this.#root, segments, 0, pairs, verb, allowed);
        if (terminal === null)
        {
            return allowed.size > 0 ? { kind: 'method-mismatch', allowed: allowedList(allowed) } : { kind: 'miss' };
        }

        const value = terminal.get(verb) ?? (verb === 'HEAD' ? terminal.get('GET') : undefined);
        if (value === undefined)
        {
            return { kind: 'method-mismatch', allowed: allowedList(terminal.keys()) };
        }
        const params: Record<string, string> = {};
        for (let i = 0; i < pairs.length; i += 2)
        {
            const name = pairs[i];
            const value = pairs[i + 1];
            if (name !== undefined && value !== undefined)
            {
                params[name] = value; // pairs is written strictly two at a time
            }
        }
        return { kind: 'match', value, params };
    }

    /**
     * Depth-first walk with backtracking across the static > param > wildcard precedence.
     * Returns the terminal's handler map, or null. Captures accumulate in `pairs` as a flat
     * [name, value, name, value, ...] list: a param branch PUSHES before recursing and POPS
     * when the branch dead-ends, so backtracking costs two array ops instead of an object
     * copy per branch - the match's params object is built once, by the caller, on success.
     * @internal
     */
    #walk(
        node: RadixNode<T>,
        segments: string[],
        index: number,
        pairs: string[],
        verb: string,
        allowed: Set<string>
    ): Map<string, T> | null
    {
        if (index === segments.length)
        {
            if (node.handlers.size > 0)
            {
                if (node.handlers.has(verb) || (verb === 'HEAD' && node.handlers.has('GET')))
                {
                    return node.handlers;
                }
                // Structurally a match, but not for this method: record what IS allowed here and
                // dead-end so a sibling param or wildcard branch can still serve the verb.
                for (const method of node.handlers.keys())
                {
                    allowed.add(method);
                }
            }
            // An exhausted path can still be served by a wildcard matching the empty remainder?
            // No: a wildcard requires at least one segment (matching Fastify/find-my-way), so
            // `/files/*rest` does NOT match `/files`. Register `/files` explicitly if wanted.
            return null;
        }

        const segment = segments[index];
        if (segment === undefined)
        {
            return null; // index < segments.length was checked above; unreachable in practice
        }

        const staticChild = node.staticChildren.get(segment);
        if (staticChild !== undefined)
        {
            const result = this.#walk(staticChild, segments, index + 1, pairs, verb, allowed);
            if (result !== null)
            {
                return result;
            }
        }

        if (node.param !== null)
        {
            pairs.push(node.param.name, segment);
            const result = this.#walk(node.param.node, segments, index + 1, pairs, verb, allowed);
            if (result !== null)
            {
                return result;
            }
            pairs.length -= 2; // the branch dead-ended; un-capture
        }

        if (node.wildcard !== null)
        {
            if (node.wildcard.handlers.has(verb) || (verb === 'HEAD' && node.wildcard.handlers.has('GET')))
            {
                pairs.push(node.wildcard.name, segments.slice(index).join('/'));
                return node.wildcard.handlers;
            }
            for (const method of node.wildcard.handlers.keys())
            {
                allowed.add(method);
            }
        }

        return null;
    }

    /**
     * The registered route table, one line per (method, pattern), in registration order -
     * printed at boot so the served surface is never a mystery.
     */
    public table(): string[]
    {
        return this.#registered.map(({ method, pattern }) => `${ method.padEnd(7) } ${ pattern }`);
    }
}
