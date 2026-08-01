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
 * @internal UTF-8 byte length WITHOUT encoding: Buffer.byteLength is a native counter on
 * Node (no allocation); other runtimes fall back to an actual encode. The body itself stays
 * a string all the way to the socket, where `end(string)` encodes natively during the write.
 */
function byteLengthUtf8(body: string): number
{
    return typeof Buffer !== 'undefined' ? Buffer.byteLength(body, 'utf8') : ENCODER.encode(body).byteLength;
}

/**
 * @internal The shared constructor: declare the exact Content-Length, and return the
 * kernel's lazy Response (see payload.ts) - adapters write it with a plain writeHead + end,
 * no web-stream, no undici, and no JS-side encoding on the hot path.
 */
export function payloadResponse(body: string, contentType: string, init: ResponseInit): Response
{
    const length = byteLengthUtf8(body);
    const record: Record<string, string> = {
        'content-type': contentType,
        'content-length': String(length)
    };
    let setCookies: string[] = [];
    if (init.headers !== undefined)
    {
        // The custom-headers path normalizes ONCE through real Headers (handles records,
        // arrays, Headers instances, and casing) - only callers who pass headers pay it.
        const headers = new Headers(init.headers);
        for (const [name, value] of headers)
        {
            record[name] = value;
        }
        // Headers iteration collapses duplicate set-cookie to one; getSetCookie() is the
        // only accessor that preserves every cookie. Carry them apart from the record so
        // a session + a csrf cookie both survive to the socket.
        setCookies = headers.getSetCookie();
        delete record['set-cookie'];
        record['content-length'] = String(length);
    }
    const status = init.status ?? 200;
    // RFC 9112 section 6.2: a 204/205/304 MUST NOT carry Content-Length, and the payload cannot
    // be sent at all. Declaring a length with no body on a keep-alive connection is the shape a
    // framing desync is built from, so the body and the length both go.
    if (status === 204 || status === 205 || status === 304)
    {
        delete record['content-length'];
        delete record['content-type'];
        return new PayloadResponse('', status, record, setCookies);
    }
    return new PayloadResponse(body, status, record, setCookies);
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
 *
 * `init` exists because a redirect routinely carries a cookie: sign-out is "expire the session
 * AND redirect", and a logout that redirects without clearing the cookie leaves the user signed
 * in. Built through the kernel's response so every `Set-Cookie` survives - header iteration
 * collapses duplicates, and only `getSetCookie()` preserves a session and a CSRF cookie together.
 *
 * @param location - The `Location` header value.
 * @param status - The redirect status; 303 by default.
 * @param init - Extra headers, most often `Set-Cookie`.
 * @returns A bodyless redirect response.
 * @example
 * app.post('/sign-out', () => redirect('/login', 303, {
 *     headers: { 'set-cookie': expireCookie('session') }
 * }));
 */
export function redirect(location: string, status: 301 | 302 | 303 | 307 | 308 = 303, init: ResponseInit = {}): Response
{
    const headers = new Headers(init.headers);
    headers.set('location', location);
    // 3xx is not in payloadResponse's bodyless set, so pass an empty body and let it declare a
    // zero length - the shape a redirect has always had on the wire.
    return payloadResponse('', 'text/plain; charset=utf-8', { ...init, status, headers });
}

/**
 * 204: success with nothing to say (the correct DELETE response).
 *
 * Built through the kernel's response like every other constructor, so it takes the adapter's
 * writeHead+end fast path and can carry a `Set-Cookie`. `payloadResponse` drops the body,
 * `Content-Length` and `Content-Type` for a 204 per RFC 9112 section 6.2 - declaring a length
 * with no body on a keep-alive connection is the shape a framing desync is built from.
 *
 * @param init - Extra headers.
 * @returns A 204 with no body.
 */
export function noContent(init: ResponseInit = {}): Response
{
    return payloadResponse('', 'text/plain; charset=utf-8', { ...init, status: 204 });
}

/** 201 with a Location header; `data` (when given) is the created representation as JSON. */
export function created(location: string, data?: unknown): Response
{
    // Both arms go through the kernel's response: a plain `Response` on the bodyless arm loses
    // the adapter fast path and cannot carry a `Set-Cookie`. `redirect` and `noContent` route
    // the same way for the same reason.
    return data === undefined
        ? payloadResponse('', 'text/plain; charset=utf-8', { status: 201, headers: { location } })
        : json(data, { status: 201, headers: { location } });
}
