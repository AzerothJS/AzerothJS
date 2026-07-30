/**
 * MODULE: http/sse - Server-Sent Events, the frontend stream keyword's server peer
 *
 * `sse(request, producer)` returns a `text/event-stream` Response whose body a producer
 * drives through a small typed connection - the exact wire format the frontend's `stream`
 * keyword (`createStream({ parse: 'sse' })`) and the browser's EventSource consume:
 *
 *   - `send(data)` emits one event; multi-line strings become multiple `data:` lines (the
 *     spec's framing - a payload line break never terminates an event early, and the spec
 *     counts CR, LF and CRLF alike, so relayed user text cannot forge fields); objects are
 *     JSON-stringified, so `send({ n: 1 })` pairs with a client-side JSON.parse.
 *   - `close()` emits the `data: [DONE]` terminator by default - the convention the
 *     frontend parser (and the OpenAI-style ecosystem) treats as end-of-stream - then ends
 *     the response. A producer that THROWS ends the stream without that terminator, so a
 *     truncated stream is never read as a complete one.
 *   - comment heartbeats (`:hb`) flow every 15s by default, keeping idle connections alive
 *     through proxies whose read timeouts kill silent sockets; the client parser skips
 *     comments by spec.
 *
 * DISCONNECT is first-class: the producer receives the connection's AbortSignal (fired by
 * client disconnect via request.signal, or by close()); registered abort listeners are the
 * producer's teardown. The heartbeat stops itself. Nothing leaks when a tab closes - and when
 * the request signal has ALREADY fired (the socket died while the handler was awaiting auth),
 * the producer never runs at all, because nothing would be left to tear it down.
 *
 * Response headers set `Cache-Control: no-cache, no-transform` (a cached or transformed
 * event stream is a broken one) and `X-Accel-Buffering: no` (nginx must not buffer);
 * compress.ts additionally refuses to compress event streams - zlib buffering would hold
 * events hostage until a flush boundary.
 */

export interface SseSendOptions
{
    /**
     * The `event:` name (the client's addEventListener key). Omit for the default channel.
     * A line break is not representable in a field value and is replaced with a space.
     */
    event?: string;

    /** The `id:` field - the client's Last-Event-ID resume cursor. Line breaks as above. */
    id?: string;
}

/** What a producer drives. All methods are safe after close (they become no-ops). */
export interface SseConnection
{
    /** Emits one event. Objects are JSON-stringified; multi-line strings frame correctly. */
    send(data: string | object, options?: SseSendOptions): void;

    /**
     * Emits a `:` comment line (invisible to consumers; useful for custom keep-alives).
     * Line breaks in `text` are replaced with spaces - a comment is exactly one line.
     */
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

    /**
     * Slow-client cutoff: when this many bytes sit unread in the stream's queue, the next
     * send DROPS the connection (default 1 MiB). Without a cap, a producer outpacing a
     * stalled client buffers unbounded - the transport's socket backpressure protects the
     * socket, not this queue. Dropping is the correct SSE semantic: EventSource reconnects
     * automatically and resumes via Last-Event-ID, and erroring the stream frees the
     * backlog immediately instead of holding it for a client that may never drain.
     */
    maxBufferedBytes?: number;

    /**
     * Where a producer's failure goes. The status line is long gone by the time a producer
     * throws, so the stream cannot become a 500: it ENDS, without the `[DONE]` terminator,
     * and the error arrives here (wire the app's error observer to it). Unset, the error is
     * rethrown on a fresh microtask so the runtime's unhandled-exception path reports it -
     * silently discarding it would let a client read a truncated stream as a complete one.
     */
    onError?: (error: unknown) => void;
}

const ENCODER = new TextEncoder();

/**
 * @internal The event-stream grammar ends a line on CRLF, LF *or a lone CR* - splitting on
 * '\n' alone leaves a payload CR terminating the `data:` line, which turns anything after it
 * into fresh event fields (a forged `event:` name on somebody else's client).
 */
const LINE_BREAK = /\r\n|[\r\n]/;

/** @internal A field value is one line: line breaks are not representable in it. */
function oneLine(value: string): string
{
    return value.split(LINE_BREAK).join(' ');
}

/** @internal One event in wire form: optional event/id lines, one data: line per payload line. */
function frame(data: string, options: SseSendOptions | undefined): string
{
    let out = '';
    if (options?.event !== undefined)
    {
        out += `event: ${ oneLine(options.event) }\n`;
    }
    if (options?.id !== undefined)
    {
        out += `id: ${ oneLine(options.id) }\n`;
    }
    for (const line of data.split(LINE_BREAK))
    {
        out += `data: ${ line }\n`;
    }
    return out + '\n';
}

/**
 * Builds the event-stream Response. The producer runs as soon as the transport starts
 * reading the body; its throw ends the stream with no `[DONE]` terminator and reports to
 * {@link SseOptions.onError} - an SSE stream that already sent bytes cannot change its
 * status line, so mid-stream errors END, not 500.
 */
export function sse(
    request: Request,
    producer: (connection: SseConnection) => void | Promise<void>,
    options: SseOptions = {}
): Response
{
    const heartbeatMs = options.heartbeatMs ?? 15_000;
    const doneMarker = options.doneMarker ?? true;
    const maxBufferedBytes = options.maxBufferedBytes ?? 1_048_576;
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

    /** Ends the response stream and tears the producer down; the `[DONE]` marker is close()'s alone. */
    const end = (): void =>
    {
        const done = finish;
        enqueue = null;
        finish = null;
        stop();
        done?.();
    };

    const report = (error: unknown): void =>
    {
        if (options.onError !== undefined)
        {
            options.onError(error);
            return;
        }
        // With no observer the error resurfaces on a fresh microtask, where the runtime's
        // unhandled-exception path reports it: swallowing it here is what would let a
        // truncated stream pass for a complete one with nobody the wiser.
        queueMicrotask(() =>
        {
            throw error;
        });
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
            enqueue?.(ENCODER.encode(`: ${ oneLine(text) }\n\n`));
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
            end();
        }
    };

    const body = new ReadableStream<Uint8Array>({
        start(streamController): void
        {
            if (request.signal.aborted)
            {
                // The socket is already gone - a disconnect while the handler was still
                // awaiting auth or a DB round trip. A listener added to a signal that has
                // already fired never runs, so a producer and heartbeat started here would
                // have nothing left to tear them down.
                stop();
                streamController.close();
                return;
            }

            enqueue = (chunk) =>
            {
                // Backpressure floor: desiredSize is maxBufferedBytes minus the unread
                // queue (the byte-length strategy below). At or under zero, the client is
                // maxBufferedBytes behind - drop it (see SseOptions.maxBufferedBytes).
                if (streamController.desiredSize !== null && streamController.desiredSize <= 0)
                {
                    enqueue = null;
                    finish = null;
                    stop();
                    try
                    {
                        streamController.error(new Error(`SSE client fell ${ maxBufferedBytes } bytes behind and was dropped`));
                    }
                    catch
                    {
                        // Already errored/cancelled - dropped is dropped.
                    }
                    return;
                }
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

            // Run the producer; a throw ends the stream (the status already went out) with NO
            // terminator, which is the client's only signal that it read a partial stream.
            void Promise.resolve()
                .then(() => producer(connection))
                .catch((error: unknown) =>
                {
                    end();
                    report(error);
                });
        },
        cancel(): void
        {
            // The transport stopped reading (disconnect seen by the stream first).
            enqueue = null;
            finish = null;
            stop();
        }
    }, new ByteLengthQueuingStrategy({ highWaterMark: maxBufferedBytes }));

    return new Response(body, {
        status: 200,
        headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            'x-accel-buffering': 'no'
        }
    });
}
