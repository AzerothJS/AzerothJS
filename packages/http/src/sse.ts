/**
 * MODULE: http/sse - Server-Sent Events, the frontend stream keyword's server peer
 *
 * `sse(request, producer)` returns a `text/event-stream` Response whose body a producer
 * drives through a small typed connection - the exact wire format the frontend's `stream`
 * keyword (`createStream({ parse: 'sse' })`) and the browser's EventSource consume:
 *
 *   - `send(data)` emits one event; multi-line strings become multiple `data:` lines (the
 *     spec's framing - a payload newline never terminates an event early); objects are
 *     JSON-stringified, so `send({ n: 1 })` pairs with a client-side JSON.parse.
 *   - `close()` emits the `data: [DONE]` terminator by default - the convention the
 *     frontend parser (and the OpenAI-style ecosystem) treats as end-of-stream - then ends
 *     the response.
 *   - comment heartbeats (`:hb`) flow every 15s by default, keeping idle connections alive
 *     through proxies whose read timeouts kill silent sockets; the client parser skips
 *     comments by spec.
 *
 * DISCONNECT is first-class: the producer receives the connection's AbortSignal (fired by
 * client disconnect via request.signal, or by close()); registered abort listeners are the
 * producer's teardown. The heartbeat stops itself. Nothing leaks when a tab closes.
 *
 * Response headers set `Cache-Control: no-cache, no-transform` (a cached or transformed
 * event stream is a broken one) and `X-Accel-Buffering: no` (nginx must not buffer);
 * compress.ts additionally refuses to compress event streams - zlib buffering would hold
 * events hostage until a flush boundary.
 */

export interface SseSendOptions
{
    /** The `event:` name (the client's addEventListener key). Omit for the default channel. */
    event?: string;

    /** The `id:` field - the client's Last-Event-ID resume cursor. */
    id?: string;
}

/** What a producer drives. All methods are safe after close (they become no-ops). */
export interface SseConnection
{
    /** Emits one event. Objects are JSON-stringified; multi-line strings frame correctly. */
    send(data: string | object, options?: SseSendOptions): void;

    /** Emits a `:` comment line (invisible to consumers; useful for custom keep-alives). */
    comment(text: string): void;

    /** Ends the stream (with the `[DONE]` terminator unless disabled at creation). */
    close(): void;

    /** Fires when the connection ends - client disconnect or close(). The producer's teardown hook. */
    readonly signal: AbortSignal;

    /** The client's Last-Event-ID header, for resuming after a reconnect. */
    readonly lastEventId: string | null;
}

export interface SseOptions
{
    /** Comment-heartbeat interval in ms; 0 disables (default 15000). */
    heartbeatMs?: number;

    /** Emitted as the `retry:` prologue - the client's reconnect delay hint. */
    retryMs?: number;

    /** Emit `data: [DONE]` when close() ends the stream (default true - the frontend parser's terminator). */
    doneMarker?: boolean;
}

const ENCODER = new TextEncoder();

/** @internal One event in wire form: optional event/id lines, one data: line per payload line. */
function frame(data: string, options: SseSendOptions | undefined): string
{
    let out = '';
    if (options?.event !== undefined)
    {
        out += `event: ${ options.event }\n`;
    }
    if (options?.id !== undefined)
    {
        out += `id: ${ options.id }\n`;
    }
    for (const line of data.split('\n'))
    {
        out += `data: ${ line }\n`;
    }
    return out + '\n';
}

/**
 * Builds the event-stream Response. The producer runs as soon as the transport starts
 * reading the body; its throw closes the stream (after the error reaches the app's
 * error observer via the returned rejected promise being swallowed - an SSE stream that
 * already sent bytes cannot change its status line, so mid-stream errors END, not 500).
 */
export function sse(
    request: Request,
    producer: (connection: SseConnection) => void | Promise<void>,
    options: SseOptions = {}
): Response
{
    const heartbeatMs = options.heartbeatMs ?? 15_000;
    const doneMarker = options.doneMarker ?? true;
    const controller = new AbortController();
    const lastEventId = request.headers.get('last-event-id');

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let enqueue: ((chunk: Uint8Array) => void) | null = null;
    let finish: (() => void) | null = null;

    const stop = (): void =>
    {
        if (heartbeat !== undefined)
        {
            clearInterval(heartbeat);
            heartbeat = undefined;
        }
        if (!controller.signal.aborted)
        {
            controller.abort();
        }
    };

    const connection: SseConnection = {
        signal: controller.signal,
        lastEventId,
        send(data, sendOptions): void
        {
            if (enqueue === null)
            {
                return; // already closed - sends become no-ops, never throws
            }
            const payload = typeof data === 'string' ? data : JSON.stringify(data);
            enqueue(ENCODER.encode(frame(payload, sendOptions)));
        },
        comment(text): void
        {
            enqueue?.(ENCODER.encode(`: ${ text }\n\n`));
        },
        close(): void
        {
            if (enqueue === null)
            {
                return;
            }
            if (doneMarker)
            {
                enqueue(ENCODER.encode('data: [DONE]\n\n'));
            }
            const done = finish;
            enqueue = null;
            finish = null;
            stop();
            done?.();
        }
    };

    const body = new ReadableStream<Uint8Array>({
        start(streamController): void
        {
            enqueue = (chunk) =>
            {
                try
                {
                    streamController.enqueue(chunk);
                }
                catch
                {
                    // The stream was torn down between the null-check and the write (client
                    // vanished mid-send). Sends after teardown are no-ops by contract.
                    enqueue = null;
                    stop();
                }
            };
            finish = () =>
            {
                try
                {
                    streamController.close();
                }
                catch
                {
                    // Already errored/cancelled by the transport - closed is closed.
                }
            };

            if (options.retryMs !== undefined)
            {
                connection.comment('connected');
                enqueue(ENCODER.encode(`retry: ${ options.retryMs }\n\n`));
            }
            if (heartbeatMs > 0)
            {
                heartbeat = setInterval(() => connection.comment('hb'), heartbeatMs);
                // A long-lived timer must not hold the process open by itself.
                (heartbeat as { unref?: () => void }).unref?.();
            }

            // The client vanishing aborts the request signal; propagate to the connection.
            request.signal.addEventListener('abort', () =>
            {
                enqueue = null;
                finish = null;
                stop();
            }, { once: true });

            // Run the producer; a throw ends the stream (the status already went out).
            void Promise.resolve()
                .then(() => producer(connection))
                .catch(() => connection.close());
        },
        cancel(): void
        {
            // The transport stopped reading (disconnect seen by the stream first).
            enqueue = null;
            finish = null;
            stop();
        }
    });

    return new Response(body, {
        status: 200,
        headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            'x-accel-buffering': 'no'
        }
    });
}
