/**
 * MODULE: http/body - request body readers with limits ON by default
 *
 * Express ships body parsing as an external middleware with no limit unless configured;
 * unbounded bodies are a one-request memory DoS. Here reading a body is an explicit, typed,
 * LIMITED operation: every reader enforces a byte cap while STREAMING, so neither a lying
 * Content-Length nor a chunked body without one can exceed it - the read aborts the moment
 * the cap is crossed, not after buffering.
 *
 * Readers throw the kernel's own errors (PayloadTooLargeError, UnsupportedMediaTypeError,
 * BadRequestError), which the one error path maps to correct statuses - a handler simply
 * awaits `readJson(request)` and malformed input becomes a 400/413/415 with a stable code.
 *
 * Multipart lives in its own module (multipart.ts): a from-scratch stream parser deserves
 * focused code and fixtures, not a corner of this file.
 */

import { BadRequestError, PayloadTooLargeError, UnsupportedMediaTypeError, ValidationError } from './errors.ts';

/**
 * OPTIONAL adapter capabilities. The kernel is 100% web-standard: these symbols name fast
 * lanes an adapter's Request MAY implement (the Node adapter does), and every consumer here
 * falls back to the spec surface when they are absent - a plain undici Request, a test
 * Request, or another runtime's Request all work identically, just without the shortcut.
 */
// Declared `unique symbol` so the interface below and adapter classes can use them as
// computed member keys under isolatedDeclarations. Symbol.for() returns plain `symbol`
// (the registry lookup is what makes them work across package instances), so the value
// needs the never-cast to inhabit the declared type - the runtime identity is unchanged.
export const fastHeaderLookup: unique symbol = Symbol.for('azerothjs.http.fastHeaderLookup') as never;
export const fastRawBody: unique symbol = Symbol.for('azerothjs.http.fastRawBody') as never;
export const socketAddress: unique symbol = Symbol.for('azerothjs.http.socketAddress') as never;

/** The shapes behind the capability symbols. */
export interface FastCapabilities
{
    /** Case-insensitive single-header read without constructing a Headers object. */
    [fastHeaderLookup]?(name: string): string | null;

    /** Reads the whole body with the limit enforced while streaming; rejects PayloadTooLarge. */
    [fastRawBody]?(limit: number): Promise<Uint8Array>;

    /** The peer's remote IP as the socket sees it (before any proxy header), or null off-socket. */
    [socketAddress]?(): string | null;
}

const DECODER = new TextDecoder();

/** The default body cap: 1 MiB, matching the conservative end of ecosystem defaults. */
export const DEFAULT_BODY_LIMIT: number = 1024 * 1024;

export interface ReadOptions
{
    /** Maximum body size in bytes (default {@link DEFAULT_BODY_LIMIT}). */
    limit?: number;
}

/**
 * Reads the raw body into one Uint8Array, enforcing the limit while streaming. The shared
 * primitive under every other reader. A declared Content-Length above the limit fails fast
 * WITHOUT reading; an undeclared or lying length is caught by the running count.
 */
export async function readRaw(request: Request, options: ReadOptions = {}): Promise<Uint8Array>
{
    const limit = options.limit ?? DEFAULT_BODY_LIMIT;

    const fast = (request as FastCapabilities)[fastRawBody];
    if (fast !== undefined)
    {
        return fast.call(request, limit);
    }

    const declared = request.headers.get('content-length');
    if (declared !== null)
    {
        const length = Number(declared);
        if (Number.isFinite(length) && length > limit)
        {
            throw new PayloadTooLargeError(`Body of ${ length } bytes exceeds the ${ limit }-byte limit.`);
        }
    }

    if (request.body === null)
    {
        return new Uint8Array(0);
    }

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            break;
        }
        total += value.byteLength;
        if (total > limit)
        {
            // Stop pulling immediately; the transport adapter translates the cancel into
            // closing the connection rather than draining an attacker-sized body.
            await reader.cancel();
            throw new PayloadTooLargeError(`Body exceeds the ${ limit }-byte limit.`);
        }
        chunks.push(value);
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks)
    {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

/** Reads the body as UTF-8 text (with the same streaming limit). */
export async function readText(request: Request, options: ReadOptions = {}): Promise<string>
{
    const raw = await readRaw(request, options);
    return DECODER.decode(raw);
}

/**
 * Reads and parses a JSON body. Enforces `Content-Type: application/json` (including
 * `+json` suffixes like application/problem+json) unless `accept` widens it - silently
 * parsing text/plain as JSON is how CSRF-adjacent content-type confusion starts.
 */
export async function readJson<T = unknown>(
    request: Request,
    options: ReadOptions & { accept?: (contentType: string) => boolean } = {}
): Promise<T>
{
    const contentType = mediaTypeOf(request);
    const acceptable = options.accept !== undefined
        ? options.accept(contentType)
        : contentType === 'application/json' || contentType.endsWith('+json');
    if (!acceptable)
    {
        throw new UnsupportedMediaTypeError(`Expected application/json, got "${ contentType || '(none)' }".`);
    }

    const bodyText = await readText(request, options);
    if (bodyText === '')
    {
        throw new BadRequestError('Expected a JSON body, got an empty one.', { code: 'empty-body' });
    }
    try
    {
        return JSON.parse(bodyText) as T;
    }
    catch (cause)
    {
        throw new BadRequestError('The body is not valid JSON.', { code: 'malformed-json', cause });
    }
}

/**
 * Reads an application/x-www-form-urlencoded body (what a plain HTML form posts) into
 * URLSearchParams - the standard container, preserving repeated keys.
 */
export async function readForm(request: Request, options: ReadOptions = {}): Promise<URLSearchParams>
{
    const contentType = mediaTypeOf(request);
    if (contentType !== 'application/x-www-form-urlencoded')
    {
        throw new UnsupportedMediaTypeError(
            `Expected application/x-www-form-urlencoded, got "${ contentType || '(none)' }".`);
    }
    return new URLSearchParams(await readText(request, options));
}

/** One validation failure from a schema: a dot path, a stable machine code, a human message. */
export interface ValidationIssue
{
    path: string;
    code: string;
    message: string;
}

/**
 * The STRUCTURAL shape of a validator this module accepts - `@azerothjs/schema`'s Schema
 * satisfies it, and so does anything else with a compatible safeParse. Structural on purpose:
 * the kernel stays dependency-free while validating with whatever schema library the app uses.
 */
export interface SchemaLike<T>
{
    safeParse(value: unknown, options?: { mode?: 'all' | 'first' }):
        | { ok: true; value: T }
        | { ok: false; errors: Record<string, string>; issues?: ValidationIssue[] };
}

/**
 * Reads and validates a JSON body in one call: `readJson` (Content-Type + limits enforced)
 * then `schema.safeParse`. A failure throws {@link ValidationError} - the 422 whose
 * `details.fields` the frontend form's setError consumes and whose `details.issues` carry
 * the stable codes. The happy path returns the schema's parsed (normalized) value, typed.
 */
export async function readValidated<T>(
    request: Request,
    schema: SchemaLike<T>,
    options: ReadOptions & { mode?: 'all' | 'first' } = {}
): Promise<T>
{
    const body = await readJson(request, options);
    const parsed = schema.safeParse(body, options.mode !== undefined ? { mode: options.mode } : undefined);
    if (!parsed.ok)
    {
        throw new ValidationError(parsed.errors, 'Validation failed', parsed.issues);
    }
    return parsed.value;
}

/** The media type of the request, lowercased, without parameters ("text/html;q=1" -> "text/html"). */
export function mediaTypeOf(request: Request): string
{
    const lookup = (request as FastCapabilities)[fastHeaderLookup];
    const header = lookup !== undefined ? lookup.call(request, 'content-type') : request.headers.get('content-type');
    if (header === null)
    {
        return '';
    }
    const semicolon = header.indexOf(';');
    return (semicolon === -1 ? header : header.slice(0, semicolon)).trim().toLowerCase();
}
