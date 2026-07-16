/**
 * MODULE: http/respond - response constructors
 *
 * Thin, typed constructors for the common response shapes. They exist for correctness, not
 * ceremony: each sets the right Content-Type WITH charset (a plain `new Response(json)` is
 * text/plain and mojibake awaits the first non-ASCII byte), and redirect validates its status
 * range. Handlers return these directly - there is no `res` object to call methods on, which
 * is what makes double-send and headers-already-sent unrepresentable: a response is a VALUE
 * a handler returns once, not a channel it writes to twice.
 */

import { PayloadResponse } from './payload.ts';

const ENCODER = new TextEncoder();

/**
 * @internal The shared constructor: encode once, declare the exact Content-Length from those
 * bytes, and return the kernel's lazy Response (see payload.ts) - adapters write it with a
 * plain writeHead + end, no web-stream or undici machinery on the hot path.
 */
function payloadResponse(body: string, contentType: string, init: ResponseInit): Response
{
    const bytes = ENCODER.encode(body);
    const record: Record<string, string> = {
        'content-type': contentType,
        'content-length': String(bytes.byteLength)
    };
    if (init.headers !== undefined)
    {
        // The custom-headers path normalizes ONCE through real Headers (handles records,
        // arrays, Headers instances, and casing) - only callers who pass headers pay it.
        for (const [name, value] of new Headers(init.headers))
        {
            record[name] = value;
        }
        record['content-length'] = String(bytes.byteLength);
    }
    return new PayloadResponse(bytes, init.status ?? 200, record);
}

/** A JSON response; the default for API handlers. */
export function json(data: unknown, init: ResponseInit = {}): Response
{
    return payloadResponse(JSON.stringify(data), 'application/json; charset=utf-8', init);
}

/** A plain-text response. */
export function text(body: string, init: ResponseInit = {}): Response
{
    return payloadResponse(body, 'text/plain; charset=utf-8', init);
}

/** An HTML response (what an SSR route returns). */
export function html(body: string, init: ResponseInit = {}): Response
{
    return payloadResponse(body, 'text/html; charset=utf-8', init);
}

/**
 * A redirect. Defaults to 303 (See Other) rather than 302: after a POST, 303 is the one
 * status every client agrees turns the follow-up into a GET - the post/redirect/get idiom
 * working as intended. Pass 301/302/307/308 explicitly when semantics differ.
 */
export function redirect(location: string, status: 301 | 302 | 303 | 307 | 308 = 303): Response
{
    return new Response(null, { status, headers: { location } });
}

/** 204: success with nothing to say (the correct DELETE response). */
export function noContent(init: ResponseInit = {}): Response
{
    return new Response(null, { ...init, status: 204 });
}

/** 201 with a Location header; `data` (when given) is the created representation as JSON. */
export function created(location: string, data?: unknown): Response
{
    if (data === undefined)
    {
        return new Response(null, { status: 201, headers: { location } });
    }
    return json(data, { status: 201, headers: { location } });
}

/** Options for {@link queryResult}. */
export interface QueryResultOptions extends ResponseInit
{
    /**
     * Content-Location: a URL where the SAME results can be fetched with a plain GET. Give this
     * when the query has a stable GET-able representation, so a client can bookmark or share it.
     */
    contentLocation?: string;

    /**
     * Location: a URL identifying the QUERY itself, for replaying it without resending the body.
     */
    location?: string;

    /**
     * Cache-Control for the results. QUERY is safe and idempotent, so responses MAY be cached;
     * this stays UNSET by default because results are often per-user - opt in deliberately
     * (e.g. `private, max-age=30`) once you know the results are cacheable.
     */
    cacheControl?: string;
}

/**
 * A JSON response for a QUERY handler (RFC 10008). Same body encoding as {@link json}, plus the
 * QUERY-specific headers: `Content-Location` (a GET-able results resource), `Location` (the
 * replayable query), and an opt-in `Cache-Control`. Use it so a QUERY endpoint advertises the
 * result semantics the method promises instead of hand-assembling headers.
 */
export function queryResult(data: unknown, options: QueryResultOptions = {}): Response
{
    const { contentLocation, location, cacheControl, headers, ...init } = options;
    const merged = new Headers(headers);
    if (contentLocation !== undefined)
    {
        merged.set('content-location', contentLocation);
    }
    if (location !== undefined)
    {
        merged.set('location', location);
    }
    if (cacheControl !== undefined)
    {
        merged.set('cache-control', cacheControl);
    }
    return json(data, { ...init, headers: merged });
}

/**
 * The value for an `Accept-Query` response header - the query media types an endpoint accepts
 * (RFC 10008). Set it on OPTIONS or a 415 so a client discovers how to phrase its QUERY body.
 */
export function acceptQuery(mediaTypes: string[]): Record<string, string>
{
    return { 'accept-query': mediaTypes.join(', ') };
}
