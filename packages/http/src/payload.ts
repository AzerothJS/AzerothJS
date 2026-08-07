/**
 * MODULE: http/payload - the lazy Response the kernel's own constructors return
 *
 * `new Response(...)` (undici) costs URL-less but still substantial internal setup - Headers
 * normalization, web-stream wrapping of the body - none of which matters when the kernel
 * itself built the payload and a Node adapter is about to write it to a socket. This class
 * is the response-side twin of adapter-request.ts:
 *
 *   - constructors (json/text/html, the error path) create it with a STATUS, a plain header
 *     record, and the encoded PAYLOAD BYTES - three fields, no undici;
 *   - adapters detect it and write `writeHead(status, record)` + `end(bytes)` directly;
 *   - everything of the spec surface still works: `headers` builds a real Headers on first
 *     access, `json()/text()/arrayBuffer()/bytes()` read straight from the payload, `body`
 *     wraps it in a one-chunk stream on demand, and the exotic remainder (blob, formData,
 *     clone) delegates to a real Response materialized at that moment.
 *
 * `instanceof Response` holds via the prototype chain, so user code - middleware inspecting
 * a response, tests asserting headers - cannot tell the difference; it only ever pays undici
 * costs for the members it actually touches.
 */

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export class PayloadResponse implements Response
{
    readonly #status: number;

    /** Plain lowercase-name header record - what a Node writeHead consumes directly. */
    readonly #headerRecord: Record<string, string>;

    /** String payloads stay strings until someone needs bytes: a Node socket write
     * encodes natively in `end(string)`, so the hot path never runs TextEncoder. */
    readonly #payload: Uint8Array<ArrayBuffer> | string;

    /**
     * Set-Cookie is the one header a Response may carry more than once, and a plain
     * `Record<string, string>` cannot hold that - so cookies live here, apart from the
     * record, and are re-joined only at the boundaries (the adapter's `raw()`, the
     * `headers` view, a materialized Response). Without this, two `set-cookie`s collapse
     * to one (session OR csrf, silently lost).
     */
    readonly #setCookies: readonly string[];

    #bytesCache: Uint8Array<ArrayBuffer> | null = null;

    #headers: Headers | null = null;

    #body: ReadableStream<Uint8Array<ArrayBuffer>> | null = null;

    #bodyUsed = false;

    #real: Response | null = null;

    constructor(payload: Uint8Array<ArrayBuffer> | string, status: number, headerRecord: Record<string, string>, setCookies: readonly string[] = [])
    {
        this.#payload = payload;
        this.#status = status;
        this.#headerRecord = headerRecord;
        this.#setCookies = setCookies;
    }

    /** @internal The payload as bytes, encoded on first need and cached. */
    #encoded(): Uint8Array<ArrayBuffer>
    {
        if (typeof this.#payload !== 'string')
        {
            return this.#payload;
        }
        this.#bytesCache ??= ENCODER.encode(this.#payload);
        return this.#bytesCache;
    }

    /**
     * @internal The response's CURRENT headers, split into a plain record plus the cookies a
     * record cannot hold. The single answer to "what headers do I actually have", because
     * there are two possible truths and reading the wrong one loses data silently.
     *
     * When the `headers` VIEW has been materialised it IS the truth: a caller writing
     * `response.headers.set(...)` - the web-standard way, and what middleware naturally does -
     * must reach the wire. Reading the construction-time record instead reports the header
     * through `app.handle()` (so a test passes) while the socket never carries it, which drops
     * a Set-Cookie or a Cache-Control: no-store in production only.
     *
     * Both {@link raw} and {@link withHeaders} read through here. They used to answer this
     * question separately and `withHeaders` got it wrong, so ANY edge middleware silently
     * discarded every header set through the view - session cookies and `no-store` included.
     */
    #currentHeaders(): { record: Record<string, string>; cookies: string[] }
    {
        if (this.#headers === null)
        {
            return { record: this.#headerRecord, cookies: [...this.#setCookies] };
        }
        const record: Record<string, string> = {};
        for (const [name, value] of this.#headers)
        {
            if (name !== 'set-cookie')
            {
                record[name] = value;
            }
        }
        return { record, cookies: this.#headers.getSetCookie() };
    }

    /**
     * The adapter's fast path: everything a socket write needs, no undici. A string payload
     * is returned AS a string - `res.end(string)` encodes natively during the write, which
     * beats encoding in JS first. @internal
     */
    public raw(): { status: number; headers: Record<string, string | string[]>; payload: Uint8Array<ArrayBuffer> | string }
    {
        const { record, cookies } = this.#currentHeaders();
        // A multi-cookie response re-joins the array under `set-cookie`; Node's writeHead
        // accepts a string[] value and emits one header line per entry.
        const headers: Record<string, string | string[]> = cookies.length > 0
            ? { ...record, 'set-cookie': cookies }
            : record;
        return { status: this.#status, headers, payload: this.#payload };
    }

    /**
     * A new PayloadResponse over the SAME payload with extra headers merged into the record
     * (later names lowercased; existing names win unless overwritten). Edge middleware use
     * this to add response headers WITHOUT dropping the adapter fast path - mutating the
     * `headers` view alone would not reach the record the adapter actually writes. @internal
     */
    public withHeaders(extra: Record<string, string>): PayloadResponse
    {
        // Reads the CURRENT headers, not the construction-time record: a response whose
        // `headers` view was written to carries its state there, and rebuilding from the
        // record would silently discard it.
        const base = this.#currentHeaders();
        const record: Record<string, string> = { ...base.record };
        const cookies = base.cookies;
        for (const [name, value] of Object.entries(extra))
        {
            // A set-cookie added here JOINS the carried cookies rather than clobbering the
            // record's single slot, so edge middleware can add a cookie without dropping one.
            if (name.toLowerCase() === 'set-cookie')
            {
                cookies.push(value);
                continue;
            }
            record[name.toLowerCase()] = value;
        }
        return new PayloadResponse(this.#payload, this.#status, record, cookies);
    }

    public get status(): number
    {
        return this.#status;
    }

    public get ok(): boolean
    {
        return this.#status >= 200 && this.#status < 300;
    }

    public get statusText(): string
    {
        return '';
    }

    public get headers(): Headers
    {
        if (this.#headers === null)
        {
            const headers = new Headers(this.#headerRecord);
            for (const cookie of this.#setCookies)
            {
                headers.append('set-cookie', cookie);
            }
            this.#headers = headers;
        }
        return this.#headers;
    }

    public get body(): ReadableStream<Uint8Array<ArrayBuffer>> | null
    {
        if (this.#body === null)
        {
            const payload = this.#encoded();
            const markUsed = (): void =>
            {
                this.#bodyUsed = true;
            };
            this.#body = new ReadableStream<Uint8Array<ArrayBuffer>>({
                start(controller): void
                {
                    controller.enqueue(payload);
                    controller.close();
                    markUsed();
                }
            });
        }
        return this.#body;
    }

    public get bodyUsed(): boolean
    {
        return this.#bodyUsed;
    }

    public arrayBuffer(): Promise<ArrayBuffer>
    {
        this.#bodyUsed = true;
        const copy = this.#encoded().slice();
        return Promise.resolve(copy.buffer);
    }

    public bytes(): Promise<Uint8Array<ArrayBuffer>>
    {
        this.#bodyUsed = true;
        return Promise.resolve(this.#encoded().slice());
    }

    public text(): Promise<string>
    {
        this.#bodyUsed = true;
        // A string payload round-trips for free - no decode, no encode.
        if (typeof this.#payload === 'string')
        {
            return Promise.resolve(this.#payload);
        }
        return Promise.resolve(DECODER.decode(this.#payload));
    }

    public async json(): Promise<unknown>
    {
        return JSON.parse(await this.text());
    }

    public blob(): Promise<Blob>
    {
        return this.#materialize().blob();
    }

    public formData(): Promise<FormData>
    {
        return this.#materialize().formData();
    }

    public clone(): Response
    {
        // Through #currentHeaders, or a clone silently drops everything the `headers` view
        // carries - the same loss `withHeaders` used to have.
        const { record, cookies } = this.#currentHeaders();
        return new PayloadResponse(this.#payload, this.#status, { ...record }, cookies);
    }

    public get redirected(): boolean
    {
        return false;
    }

    public get type(): ResponseType
    {
        return 'default';
    }

    public get url(): string
    {
        return '';
    }

    /** @internal A real Response over the same payload, for the members nobody hot-paths. */
    #materialize(): Response
    {
        if (this.#real === null)
        {
            const current = this.#currentHeaders();
            const headers = new Headers(current.record);
            for (const cookie of current.cookies)
            {
                headers.append('set-cookie', cookie);
            }
            this.#real = new Response(this.#encoded().slice(), { status: this.#status, headers });
        }
        return this.#real;
    }
}

// `instanceof Response` must hold; every member that would hit undici brand checks is
// overridden above.
Object.setPrototypeOf(PayloadResponse.prototype, Response.prototype);
