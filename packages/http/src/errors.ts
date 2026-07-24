/**
 * MODULE: http/errors - the one error path
 *
 * Every throw in the stack - sync or async, handler or middleware, kernel or app code - ends
 * up in exactly one place: `errorResponse`, which turns ANY thrown value into a Response with
 * a stable wire shape. One path means one set of guarantees: no second kind of "error
 * middleware" selected by convention, and no async rejection that bypasses handling because
 * nothing awaited it - the dispatcher awaits everything and routes every failure here.
 *
 * The wire shape is stable and machine-readable:
 *
 *     { "error": { "code": "not-found", "message": "...", "details"?: ... } }
 *
 * `code` is a kebab-case identifier clients can switch on (statuses are too coarse; messages
 * are for humans). `details` carries structured payloads - most importantly the field-error
 * map `{ field: message }` that `@azerothjs/form`'s setError consumes, so a server-side
 * validation failure lands in the SAME shape the browser form already understands.
 *
 * EXPOSURE: a 4xx describes the client's mistake, so its message crosses the wire. A 5xx
 * describes the server's - its message (stack traces, internal paths, query fragments) stays
 * in the log; the client sees a generic body. `HttpError.expose` encodes that default per
 * error, and constructing a bare `new HttpError(500, ...)` follows it.
 */

import { PayloadResponse } from './payload.ts';

/**
 * An HTTP-mappable error. Throw it anywhere; the kernel maps it to a Response. Not exported
 * subclasses' `code` values are stable API - clients switch on them.
 */
export class HttpError extends Error
{
    /** The HTTP status this error maps to. */
    public readonly status: number;

    /** Stable machine-readable identifier (kebab-case), e.g. 'payload-too-large'. */
    public readonly code: string;

    /** Whether `message` crosses the wire (default: true for 4xx, false for 5xx). */
    public readonly expose: boolean;

    /** Structured wire payload, e.g. a field-error map for validation failures. */
    public readonly details: unknown;

    /** Extra response headers this error mandates (e.g. Allow on a 405, Retry-After on a 429). */
    public readonly headers: Record<string, string>;

    constructor(
        status: number,
        message: string,
        options: { code?: string; expose?: boolean; details?: unknown; headers?: Record<string, string>; cause?: unknown } = {}
    )
    {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = 'HttpError';
        this.status = status;
        this.code = options.code ?? defaultCode(status);
        this.expose = options.expose ?? status < 500;
        this.details = options.details;
        this.headers = options.headers ?? {};
    }
}

/** 400: the request is malformed (bad JSON, invalid escape, missing required part). */
export class BadRequestError extends HttpError
{
    constructor(message = 'Bad request', options: { code?: string; details?: unknown; cause?: unknown } = {})
    {
        super(400, message, options);
        this.name = 'BadRequestError';
    }
}

/** 401: no valid credentials. `WWW-Authenticate` is the caller's to set via headers. */
export class UnauthorizedError extends HttpError
{
    constructor(message = 'Unauthorized', options: { code?: string; details?: unknown; headers?: Record<string, string> } = {})
    {
        super(401, message, options);
        this.name = 'UnauthorizedError';
    }
}

/** 403: authenticated, but not allowed. */
export class ForbiddenError extends HttpError
{
    constructor(message = 'Forbidden', options: { code?: string; details?: unknown } = {})
    {
        super(403, message, options);
        this.name = 'ForbiddenError';
    }
}

/** 404: nothing lives at this path. */
export class NotFoundError extends HttpError
{
    constructor(message = 'Not found', options: { code?: string; details?: unknown } = {})
    {
        super(404, message, options);
        this.name = 'NotFoundError';
    }
}

/** 405: the path exists under other methods; carries the Allow header by construction. */
export class MethodNotAllowedError extends HttpError
{
    constructor(allowed: string[], message = 'Method not allowed')
    {
        super(405, message, { headers: { allow: allowed.join(', ') }, details: { allowed } });
        this.name = 'MethodNotAllowedError';
    }
}

/** 409: the request conflicts with current state (duplicate create, stale update). */
export class ConflictError extends HttpError
{
    constructor(message = 'Conflict', options: { code?: string; details?: unknown } = {})
    {
        super(409, message, options);
        this.name = 'ConflictError';
    }
}

/** 413: the body exceeds the configured limit. Kernel body readers throw this. */
export class PayloadTooLargeError extends HttpError
{
    constructor(message = 'Payload too large', options: { details?: unknown } = {})
    {
        super(413, message, options);
        this.name = 'PayloadTooLargeError';
    }
}

/** 415: the Content-Type is not one this endpoint reads. */
export class UnsupportedMediaTypeError extends HttpError
{
    constructor(message = 'Unsupported media type', options: { details?: unknown } = {})
    {
        super(415, message, options);
        this.name = 'UnsupportedMediaTypeError';
    }
}

/**
 * 422: syntactically fine, semantically invalid - THE validation error. `details.fields` is
 * the field-error map (`{ field: message }`) that the frontend form's setError consumes
 * directly; `details.issues` (when the validator supplies them) is the ordered list of
 * `{ path, code, message }` failures for clients that switch on stable codes.
 */
export class ValidationError extends HttpError
{
    constructor(
        fieldErrors: Record<string, string>,
        message = 'Validation failed',
        issues?: ReadonlyArray<{ path: string; code: string; message: string }>
    )
    {
        super(422, message, {
            code: 'validation-failed',
            details: issues !== undefined ? { fields: fieldErrors, issues } : { fields: fieldErrors }
        });
        this.name = 'ValidationError';
    }
}

/** 429: rate limited; `retryAfterSeconds` becomes the Retry-After header. */
export class TooManyRequestsError extends HttpError
{
    constructor(retryAfterSeconds?: number, message = 'Too many requests')
    {
        super(429, message, retryAfterSeconds !== undefined
            ? { headers: { 'retry-after': String(retryAfterSeconds) } }
            : {});
        this.name = 'TooManyRequestsError';
    }
}

/** @internal Stable default codes for the statuses the kernel itself produces. */
function defaultCode(status: number): string
{
    switch (status)
    {
        case 400: return 'bad-request';
        case 401: return 'unauthorized';
        case 403: return 'forbidden';
        case 404: return 'not-found';
        case 405: return 'method-not-allowed';
        case 409: return 'conflict';
        case 413: return 'payload-too-large';
        case 415: return 'unsupported-media-type';
        case 422: return 'unprocessable';
        case 429: return 'too-many-requests';
        case 500: return 'internal';
        case 502: return 'bad-gateway';
        case 503: return 'unavailable';
        default: return status < 500 ? 'client-error' : 'server-error';
    }
}

const ENCODER = new TextEncoder();

// The router-miss 404 is the most-hammered error on any public server (scanners, favicons,
// stale links, health probes). Its body never varies, so it is encoded ONCE and each response
// is a cheap shell over the shared bytes - no per-request Error, stack capture, or JSON
// serialization on a path a bot can flood.
const NOT_FOUND_BODY = ENCODER.encode(JSON.stringify({ error: { code: 'not-found', message: 'Not found' } }));
const NOT_FOUND_HEADERS: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(NOT_FOUND_BODY.byteLength)
};

/** The stable 404 Response for a routing miss, built without constructing an Error. */
export function notFoundResponse(): Response
{
    return new PayloadResponse(NOT_FOUND_BODY, 404, NOT_FOUND_HEADERS);
}

/** How `errorResponse` reports the errors it maps (the observability seam's first consumer). */
export type ErrorObserver = (error: unknown, mapped: HttpError) => void;

/** The context a custom error serializer receives - everything needed to shape the wire body. */
export interface ErrorSerializerContext
{
    /** The thrown value mapped to its HTTP form: status, code, message, expose, details, headers. */
    error: HttpError;

    /** The request that failed - available for path, request id, timestamp context, etc. */
    request: Request;

    /**
     * Whether the error's message may cross the wire (true for a 4xx, or in dev). When false, do
     * NOT put `error.message` in the body - a 5xx message can hold server internals.
     */
    expose: boolean;

    /** Development mode. */
    dev: boolean;
}

/**
 * Reshapes the error wire body. Return a plain value to REPLACE the default `{ error: { code,
 * message } }` (the kernel still applies the error's status and any mandated headers - a 405
 * `Allow`, a 429 `Retry-After`); return a `Response` to take full control; return `undefined`
 * to fall back to the default shape for this error. Wired via `new App({ serializeError })`.
 *
 * This is the seam that lets an app speak its own envelope (`{ success, code, field, message }`,
 * a JSON:API document, ...) without reimplementing the one error path - the same mapping, the
 * same guarantees, one place to change the shape.
 */
export type ErrorSerializer = (context: ErrorSerializerContext) => unknown;

/** @internal Encodes a JSON error body into a PayloadResponse, merging the error's mandated headers. */
function encodeError(body: unknown, status: number, headers: Record<string, string>): Response
{
    const bytes = ENCODER.encode(JSON.stringify(body));
    const record: Record<string, string> = {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(bytes.byteLength)
    };
    for (const [name, value] of Object.entries(headers))
    {
        record[name.toLowerCase()] = value;
    }
    return new PayloadResponse(bytes, status, record);
}

/**
 * Turns ANY thrown value into the stable wire Response. A non-HttpError becomes a 500 whose
 * message never crosses the wire (unless `dev`, where debugging beats secrecy). This function
 * itself cannot throw - the last resort must be unconditionally safe.
 *
 * @param error - Whatever was thrown.
 * @param options.dev - Expose non-HttpError messages and stacks (development only).
 * @param options.observe - Called with every mapped error, for logging; its own throws are swallowed.
 * @param options.serialize - Reshapes the body (or returns a full Response); falls back to default on undefined. Runs only when `request` is also given - the serializer contract includes the request.
 * @param options.request - The failing request, handed to a serializer (path/id context).
 */
export function errorResponse(
    error: unknown,
    options: {
        dev?: boolean | undefined;
        observe?: ErrorObserver | undefined;
        serialize?: ErrorSerializer | undefined;
        request?: Request | undefined;
    } = {}
): Response
{
    const mapped = error instanceof HttpError
        ? error
        : new HttpError(500, error instanceof Error ? error.message : String(error), { cause: error });

    if (options.observe !== undefined)
    {
        try
        {
            options.observe(error, mapped);
        }
        catch
        {
            // An observer must never be able to break the error path itself.
        }
    }

    const exposeMessage = mapped.expose || options.dev === true;

    // A consumer-supplied serializer can replace the body shape or take full control. A thrown
    // serializer must not break the last-resort error path, so its own failure falls back to the
    // default shape below.
    if (options.serialize !== undefined && options.request !== undefined)
    {
        try
        {
            const custom = options.serialize({ error: mapped, request: options.request, expose: exposeMessage, dev: options.dev === true });
            if (custom instanceof Response)
            {
                return custom;
            }
            if (custom !== undefined)
            {
                return encodeError(custom, mapped.status, mapped.headers);
            }
            // undefined -> fall through to the default shape.
        }
        catch
        {
            // A broken serializer cannot break error handling - use the default shape.
        }
    }

    const body: { error: { code: string; message: string; details?: unknown; stack?: string | undefined } } =
    {
        error:
        {
            code: mapped.code,
            message: exposeMessage ? mapped.message : 'Internal server error'
        }
    };
    if (mapped.details !== undefined)
    {
        body.error.details = mapped.details;
    }
    if (options.dev === true && mapped.status >= 500)
    {
        const source = mapped.cause instanceof Error ? mapped.cause : mapped;
        body.error.stack = source.stack;
    }

    return encodeError(body, mapped.status, mapped.headers);
}
