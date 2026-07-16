/**
 * MODULE: http/adapter-request - the lazy Request the Node adapter hands to the kernel
 *
 * Constructing a real (undici) Request per request is the single largest fixed cost on the
 * hot path: URL parsing, Headers normalization, internal-state setup - none of which a
 * typical handler ever observes. This class is a Request-shaped view over the raw Node
 * request that computes each member ON FIRST ACCESS:
 *
 *   - `method`/`url` are string work only;
 *   - `headers` builds the real Headers once, when someone actually reads a header;
 *   - `signal` allocates its AbortController and attaches its socket listener only for
 *     handlers that use cancellation - which also fixes a real leak: an unconditional
 *     per-request `socket.once('close')` accumulates listeners for the lifetime of a
 *     keep-alive socket (MaxListenersExceededWarning under load). The lazy listener is
 *     removed when the request completes;
 *   - `body` wraps the incoming stream on demand;
 *   - everything exotic (clone, formData, blob, cache, integrity, ...) delegates to a real
 *     Request materialized at that moment - full spec behavior, paid only when used.
 *
 * `instanceof Request` holds (the prototype chain ends in Request.prototype), and every
 * member undici's brand checks would reject is overridden here, so the shim never falls
 * through to internals it does not have. The kernel itself stays 100% web-standard: it
 * types against Request and never knows the difference - which is the whole point.
 */

import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import { Readable } from 'node:stream';
import { PayloadTooLargeError } from './errors.ts';
import { fastHeaderLookup, fastRawBody, socketAddress, type FastCapabilities } from './body.ts';

/** The structural surface shared by http1's IncomingMessage and http2's compat request. */
export type AnyIncoming = (IncomingMessage | Http2ServerRequest) & { headers: Record<string, string | string[] | undefined> };

const NO_BODY_METHODS = new Set(['GET', 'HEAD']);

class AdapterRequest implements Request
{
    readonly #incoming: AnyIncoming;

    readonly #scheme: 'http' | 'https';

    #url: string | null = null;

    #headers: Headers | null = null;

    #signal: AbortSignal | null = null;

    #body: ReadableStream<Uint8Array<ArrayBuffer>> | null | undefined = undefined;

    #real: Request | null = null;

    constructor(incoming: AnyIncoming, scheme: 'http' | 'https')
    {
        this.#incoming = incoming;
        this.#scheme = scheme;
    }

    public get method(): string
    {
        return this.#incoming.method ?? 'GET';
    }

    public get url(): string
    {
        if (this.#url === null)
        {
            const headers = this.#incoming.headers;
            const authority = (headers[':authority'] as string | undefined) ?? (headers.host) ?? 'localhost';
            this.#url = `${ this.#scheme }://${ authority }${ this.#incoming.url ?? '/' }`;
        }
        return this.#url;
    }

    public get headers(): Headers
    {
        if (this.#headers === null)
        {
            const headers = new Headers();
            for (const [name, value] of Object.entries(this.#incoming.headers))
            {
                if (name.startsWith(':') || value === undefined)
                {
                    continue; // h2 pseudo-headers are transport framing, not application headers
                }
                if (Array.isArray(value))
                {
                    for (const item of value)
                    {
                        headers.append(name, item);
                    }
                }
                else
                {
                    headers.set(name, value);
                }
            }
            this.#headers = headers;
        }
        return this.#headers;
    }

    public get signal(): AbortSignal
    {
        if (this.#signal === null)
        {
            const socket = this.#incoming.socket;
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- @types/node types .socket as always-present; h2 compat streams can lose it at runtime
            if (socket === undefined || socket.destroyed)
            {
                // The connection is already gone (or never observable): a pre-aborted signal
                // is the truthful answer, and nothing needs listeners.
                this.#signal = AbortSignal.abort();
            }
            else
            {
                const controller = new AbortController();
                const onClose = (): void => controller.abort();
                socket.once('close', onClose);
                // Detach when THIS request finishes, so a keep-alive socket serving thousands
                // of requests does not accumulate one listener per request served.
                this.#incoming.once('close', () => socket.removeListener('close', onClose));
                this.#signal = controller.signal;
            }
        }
        return this.#signal;
    }

    public get body(): ReadableStream<Uint8Array<ArrayBuffer>> | null
    {
        if (this.#body === undefined)
        {
            this.#body = NO_BODY_METHODS.has(this.method.toUpperCase())
                ? null
                : Readable.toWeb(this.#incoming as IncomingMessage) as ReadableStream<Uint8Array<ArrayBuffer>>;
        }
        return this.#body;
    }

    public get bodyUsed(): boolean
    {
        if (this.#real !== null)
        {
            return this.#real.bodyUsed;
        }
        return this.#body !== undefined && this.#body !== null && (this.#body.locked || this.#incoming.readableEnded);
    }

    /** The peer's remote address as the TCP socket reports it - the pre-proxy client IP. */
    public [socketAddress](): string | null
    {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- @types/node types .socket as always-present; h2 compat streams can lose it at runtime
        return this.#incoming.socket?.remoteAddress ?? null;
    }

    /** Kernel fast lane: one header, straight off the raw record - no Headers object. */
    public [fastHeaderLookup](name: string): string | null
    {
        const value = this.#incoming.headers[name.toLowerCase()];
        if (value === undefined)
        {
            return null;
        }
        return Array.isArray(value) ? value.join(', ') : value;
    }

    /**
     * Kernel fast lane: the whole body off the Node stream directly - no web-stream wrapper,
     * no reader promise per chunk - with the limit enforced as chunks arrive, exactly like
     * the portable path. A lying or absent Content-Length cannot beat the running count.
     */
    public [fastRawBody](limit: number): Promise<Uint8Array>
    {
        const declared = this[fastHeaderLookup]('content-length');
        if (declared !== null && Number(declared) > limit)
        {
            return Promise.reject(new PayloadTooLargeError(`Body of ${ declared } bytes exceeds the ${ limit }-byte limit.`));
        }
        const incoming = this.#incoming;
        return new Promise((resolve, reject) =>
        {
            const chunks: Buffer[] = [];
            let total = 0;
            incoming.on('data', (chunk: Buffer) =>
            {
                total += chunk.byteLength;
                if (total > limit)
                {
                    incoming.destroy();
                    reject(new PayloadTooLargeError(`Body exceeds the ${ limit }-byte limit.`));
                    return;
                }
                chunks.push(chunk);
            });
            incoming.once('end', () => resolve(chunks[0] !== undefined && chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total)));
            incoming.once('error', reject);
        });
    }

    /**
     * @internal The real Request, built on first exotic use. It reuses the SAME lazily
     * created body stream, so partial reads and bodyUsed stay consistent across both faces.
     */
    #materialize(): Request
    {
        if (this.#real === null)
        {
            const init: RequestInit & { duplex?: 'half' } = { method: this.method, headers: this.headers };
            if (this.body !== null)
            {
                init.body = this.body;
                init.duplex = 'half';
            }
            this.#real = new Request(this.url, init);
        }
        return this.#real;
    }

    public arrayBuffer(): Promise<ArrayBuffer>
    {
        return this.#materialize().arrayBuffer();
    }

    public blob(): Promise<Blob>
    {
        return this.#materialize().blob();
    }

    public bytes(): Promise<Uint8Array<ArrayBuffer>>
    {
        return this.#materialize().bytes();
    }

    public formData(): Promise<FormData>
    {
        return this.#materialize().formData();
    }

    public json(): Promise<unknown>
    {
        return this.#materialize().json();
    }

    public text(): Promise<string>
    {
        return this.#materialize().text();
    }

    public clone(): Request
    {
        return this.#materialize().clone();
    }

    // The spec attributes a server-made request has exactly one sane answer for.
    public get cache(): RequestCache
    {
        return 'default';
    }

    public get credentials(): RequestCredentials
    {
        return 'same-origin';
    }

    public get destination(): RequestDestination
    {
        return '';
    }

    public get integrity(): string
    {
        return '';
    }

    public get keepalive(): boolean
    {
        return false;
    }

    public get mode(): RequestMode
    {
        return 'cors';
    }

    public get redirect(): RequestRedirect
    {
        return 'follow';
    }

    public get referrer(): string
    {
        return '';
    }

    public get referrerPolicy(): ReferrerPolicy
    {
        return '';
    }

    public get duplex(): 'half'
    {
        return 'half';
    }
}

// `instanceof Request` must hold for user code that checks; the overrides above cover every
// member that would otherwise hit undici's brand-checked internals.
Object.setPrototypeOf(AdapterRequest.prototype, Request.prototype);

/**
 * Builds the adapter Request for one incoming Node message. The factory (not the class) is
 * the module's export: its explicit return type is what declaration emit needs under
 * isolatedDeclarations (computed symbol-keyed class methods cannot be emitted), and the
 * class stays module-internal - its whole public shape IS `Request & FastCapabilities`.
 */
export function createAdapterRequest(incoming: AnyIncoming, scheme: 'http' | 'https'): Request & FastCapabilities
{
    return new AdapterRequest(incoming, scheme);
}
