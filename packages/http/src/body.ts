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

import type { Issue } from '@azerothjs/schema';
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
 *
 * A body can only be read ONCE (the web standard's rule, and the reason a raw-body HMAC check
 * must hand its bytes on rather than let the handler read again). A second read throws
 * TypeError - the same shape the standard reader produces on a disturbed stream - because the
 * alternative on a drained socket is a promise that never settles and a request that never ends.
 */
export async function readRaw(request: Request, options: ReadOptions = {}): Promise<Uint8Array>
{
    const limit = options.limit ?? DEFAULT_BODY_LIMIT;

    if (request.bodyUsed)
    {
        throw new TypeError('Invalid state: the request body has already been read.');
    }

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

/**
 * The STRUCTURAL shape of a validator this module accepts - `@azerothjs/schema`'s Schema
 * satisfies it, and so does anything else with a compatible safeParse. Structural on purpose:
 * the boundary accepts whatever schema library the app uses; the ISSUE shape is the one
 * declaration the whole framework speaks (`@azerothjs/schema`'s Issue, imported type-only).
 */
export interface SchemaLike<T>
{
    safeParse(value: unknown, options?: { mode?: 'all' | 'first' }):
        | { ok: true; value: T }
        | { ok: false; errors: Record<string, string>; issues?: Issue[] };
}

/** The structural `~standard` half: any Standard Schema v1 validator (Zod, Valibot, ArkType). */
export interface StandardSchemaLike<T>
{
    '~standard': {
        validate(value: unknown):
            | { value: T; issues?: undefined }
            | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> }
            | Promise<
                | { value: T; issues?: undefined }
                | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> }>;
    };
}

/** A validation success: the parsed (normalized) value. */
export interface ParseOk { ok: true; value: unknown }

/** A validation failure: the flat field-path map plus the ordered issue list. */
export interface ParseErr { ok: false; errors: Record<string, string>; issues?: Issue[] }

/**
 * ONE schema unification for every boundary: a schema's capabilities are sniffed, never
 * type-dispatched. A native `@azerothjs/schema` value keeps its one-pass `safeParse` (issue
 * codes included); any other Standard Schema validator runs `~standard.validate`, its issues
 * mapped to the flat field-path errors the whole framework speaks. Failures are returned,
 * never thrown - each caller raises its own dialect. Consumed by {@link readValidated} and
 * the api layer's `register`; module-exported, deliberately not on the package index.
 */
export async function parseAny(schema: unknown, value: unknown, mode?: 'all' | 'first'): Promise<ParseOk | ParseErr>
{
    const native = schema as { safeParse?: (v: unknown, o?: { mode?: 'all' | 'first' }) => ParseOk | ParseErr };
    if (typeof native.safeParse === 'function')
    {
        return native.safeParse(value, mode !== undefined ? { mode } : undefined);
    }
    const standard = (schema as StandardSchemaLike<unknown>)['~standard'];
    const result = await standard.validate(value);
    if (result.issues === undefined)
    {
        return { ok: true, value: result.value };
    }
    const errors: Record<string, string> = {};
    const issues: Issue[] = [];
    for (const issue of result.issues)
    {
        const path = (issue.path ?? []).map((seg) => typeof seg === 'object' ? String(seg.key) : String(seg)).join('.') || 'root';
        errors[path] = errors[path] ?? issue.message;
        issues.push({ path, code: 'invalid', message: issue.message });
    }
    return { ok: false, errors, issues };
}

/**
 * Reads and validates a JSON body in one call: `readJson` (Content-Type + limits enforced)
 * then the schema - a native safeParse or any Standard Schema validator, unified by
 * {@link parseAny}. A failure throws {@link ValidationError} - the 422 whose
 * `details.fields` the frontend form's setError consumes and whose `details.issues` carry
 * the stable codes. The happy path returns the schema's parsed (normalized) value, typed.
 */
export async function readValidated<T>(
    request: Request,
    schema: SchemaLike<T> | StandardSchemaLike<T>,
    options: ReadOptions & { mode?: 'all' | 'first' } = {}
): Promise<T>
{
    const body = await readJson(request, options);
    const parsed = await parseAny(schema, body, options.mode);
    if (!parsed.ok)
    {
        throw new ValidationError(parsed.errors, 'Validation failed', parsed.issues);
    }
    return parsed.value as T;
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
