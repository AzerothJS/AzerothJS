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

    readonly #payload: Uint8Array<ArrayBuffer>;

    #headers: Headers | null = null;

    #body: ReadableStream<Uint8Array<ArrayBuffer>> | null = null;

    #bodyUsed = false;

    #real: Response | null = null;

    constructor(payload: Uint8Array<ArrayBuffer> | string, status: number, headerRecord: Record<string, string>)
    {
        this.#payload = typeof payload === 'string' ? ENCODER.encode(payload) : payload;
        this.#status = status;
        this.#headerRecord = headerRecord;
    }

    /** The adapter's fast path: everything a socket write needs, no undici. @internal */
    public raw(): { status: number; headers: Record<string, string>; payload: Uint8Array }
    {
        return { status: this.#status, headers: this.#headerRecord, payload: this.#payload };
    }

    /**
     * A new PayloadResponse over the SAME payload with extra headers merged into the record
     * (later names lowercased; existing names win unless overwritten). Edge middleware use
     * this to add response headers WITHOUT dropping the adapter fast path - mutating the
     * `headers` view alone would not reach the record the adapter actually writes. @internal
     */
    public withHeaders(extra: Record<string, string>): PayloadResponse
    {
        const record: Record<string, string> = { ...this.#headerRecord };
        for (const [name, value] of Object.entries(extra))
        {
            record[name.toLowerCase()] = value;
        }
        return new PayloadResponse(this.#payload, this.#status, record);
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
        this.#headers ??= new Headers(this.#headerRecord);
        return this.#headers;
    }

    public get body(): ReadableStream<Uint8Array<ArrayBuffer>> | null
    {
        if (this.#body === null)
        {
            const payload = this.#payload;
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
        const copy = this.#payload.slice();
        return Promise.resolve(copy.buffer);
    }

    public bytes(): Promise<Uint8Array<ArrayBuffer>>
    {
        this.#bodyUsed = true;
        return Promise.resolve(this.#payload.slice());
    }

    public text(): Promise<string>
    {
        this.#bodyUsed = true;
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
        return new PayloadResponse(this.#payload, this.#status, { ...this.#headerRecord });
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
        this.#real ??= new Response(this.#payload.slice(), { status: this.#status, headers: this.#headerRecord });
        return this.#real;
    }
}

// `instanceof Response` must hold; every member that would hit undici brand checks is
// overridden above.
Object.setPrototypeOf(PayloadResponse.prototype, Response.prototype);
