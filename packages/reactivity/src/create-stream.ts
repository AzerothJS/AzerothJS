/**
 * MODULE: reactivity/create-stream
 *
 * createStream wraps a chunked-response fetcher (typically fetch()) into a reactive
 * container that updates partial() as each chunk arrives and flips done() when the
 * stream ends - the token-by-token shape AI chat products use, as a one-line primitive.
 *
 * RELATIONSHIP TO createResource: createResource resolves once and exposes data();
 * createStream resolves incrementally and exposes partial() that updates per chunk. Both
 * share loading-style flags, error capture, cancellation, and refetch, so the two feel
 * like family.
 *
 * PARSE MODES:
 *   'text'   - each chunk appended verbatim.
 *   'sse'    - Server-Sent Events: strips the data: prefix, skips :-comments, terminates
 *              on data: [DONE].
 *   'ndjson' - newline-delimited JSON; extracts .text/.content/.delta if present, else
 *              stringifies the parsed value.
 *   custom   - a function (chunk: string) => string.
 * Built-in modes buffer across reads, so a delta split across two chunks (`data: he`
 * then `llo\n\n`) is reassembled into one event.
 *
 * CANCELLATION: cancel() aborts the in-flight fetch (partial() preserved, done() flips
 * true, no error set). refetch() cancels, resets partial() to `initial`, and starts a
 * new request (same source value if provided). All paths converge on the driving
 * effect's onCleanup -> controller.abort().
 *
 * The parser machinery and driving-effect internals below carry their own implementation
 * comments (the abort-race and chunk-buffering logic is subtle); the public surface is
 * createStream plus the StreamParseMode / StreamOptions / Stream types.
 */

import type { Getter } from './types.ts';
import { createSignal } from './create-signal.ts';
import { createEffect } from './create-effect.ts';
import { onCleanup } from './on-cleanup.ts';
import { batch } from './batch.ts';

/**
 * Built-in parse mode names. Pass a function instead for full
 * control over how each chunk is converted to appendable text.
 */
export type StreamParseMode = 'text' | 'sse' | 'ndjson';

/**
 * Options for createStream. The `source` and `fetcher` shapes
 * mirror createResource so the two primitives feel like family.
 *
 * @typeParam S - The source value's type (when `source` is set)
 */
export interface StreamOptions<S = void>
{
    /**
     * Optional source signal. When the source changes the stream
     * cancels its current request and starts a new one.
     *
     * Returning `null`, `undefined`, or `false` skips the fetch
     * entirely - same convention as `createResource`. Use this
     * for "wait until the user is logged in" patterns.
     */
    source?: () => S | false | null | undefined;

    /**
     * Returns a `Response` whose body is a ReadableStream.
     * Receives the resolved source value (or `undefined` when
     * `source` is omitted) and an AbortSignal that fires on
     * cancel/refetch/source-change.
     */
    fetcher: (args: { source: S; signal: AbortSignal }) => Promise<Response>;

    /**
     * How to interpret incoming chunks. Default: `'text'`.
     *
     * Pass a function for full control - it receives the
     * already-decoded chunk string and returns the text to
     * append to `partial()`.
     */
    parse?: StreamParseMode | ((chunk: string) => string);

    /**
     * Initial value for `partial()` before any chunks arrive,
     * and the value `partial()` resets to on `refetch()`.
     * Default: `''`.
     */
    initial?: string;
}

/**
 * The reactive shape returned by `createStream`.
 */
export interface Stream
{
    /**
     * The accumulated text so far. Updates after every chunk
     * the parser converts to non-empty output.
     */
    partial: Getter<string>;

    /**
     * `true` when the stream has ended - successfully (close /
     * SSE `[DONE]`), via cancellation, or via error. Pair with
     * `error()` to distinguish.
     */
    done: Getter<boolean>;

    /**
     * The most recent error, or `null`. Set when the fetcher
     * throws, the response body errors, or the stream is
     * interrupted by something other than cancellation.
     * Cancellation does NOT populate this.
     */
    error: Getter<unknown>;

    /**
     * Aborts the in-flight stream. `partial()` is preserved at
     * its current value; `done()` flips to true. No-op if the
     * stream has already ended.
     */
    cancel: () => void;

    /**
     * Cancels the current stream, resets `partial()` to
     * `initial`, and starts a new request with the current
     * source value (if any).
     */
    refetch: () => void;
}

// Parser machinery.
//
// Each parser is a stateful transformer: `feed` accepts a raw chunk and
// returns whatever is appendable plus a termination flag (for SSE's
// `[DONE]`). `finish` runs once at end-of-stream to flush any buffered tail.

interface ParserStream
{
    feed(chunk: string): { append: string; terminated: boolean };
    finish(): { append: string };
}

/** Built-in `'text'` mode - every chunk appended verbatim. */
function createTextParser(): ParserStream
{
    return {
        feed(chunk: string)
        {
            return { append: chunk, terminated: false };
        },
        finish()
        {
            return { append: '' };
        }
    };
}

/**
 * Built-in `'sse'` mode. SSE separates events with `\n\n`. Each
 * event is one or more lines; we extract `data:` lines, skip
 * `:`-comments, and terminate on `data: [DONE]`.
 *
 * Buffers across reads so a `data:` value split between two
 * network chunks is reassembled correctly.
 */
function createSseParser(): ParserStream
{
    let buffer = '';

    function process(): { append: string; terminated: boolean }
    {
        let appended = '';
        let terminated = false;

        // Pull complete events (those with a trailing `\n\n`)
        // out of the buffer one at a time.
        for (;;)
        {
            const eventEnd = buffer.indexOf('\n\n');
            if (eventEnd === -1)
            {
                break;
            }

            const event = buffer.slice(0, eventEnd);
            buffer = buffer.slice(eventEnd + 2);

            for (const line of event.split('\n'))
            {
                if (line.startsWith(':'))
                {
                    continue; // SSE comment line
                }
                // Only data: lines contribute to the partial text;
                // event:, id:, and retry: are ignored in v1.
                if (!line.startsWith('data:'))
                {
                    continue;
                }

                // Per spec, exactly one space after `data:` is
                // optional and stripped; we use `trimStart` to
                // also tolerate the rare extra-space producer.
                const data = line.slice(5).trimStart();

                if (data === '[DONE]')
                {
                    terminated = true;
                    break;
                }

                appended += data;
            }
            if (terminated)
            {
                break;
            }
        }

        return { append: appended, terminated };
    }

    return {
        feed(chunk: string)
        {
            buffer += chunk;
            return process();
        },
        finish()
        {
            // Strict SSE requires `\n\n` between events. If the
            // server forgot to send a trailing terminator the
            // last event is lost - same behaviour as every
            // browser's native EventSource.
            return { append: '' };
        }
    };
}

/**
 * Built-in `'ndjson'` mode - newline-delimited JSON. Each
 * complete line is parsed; we extract `text`/`content`/`delta`
 * fields if the parsed value is an object, otherwise stringify.
 *
 * Malformed lines are silently skipped - strict-error behaviour
 * would be too brittle for partial-chunk-arrival scenarios.
 */
function createNdjsonParser(): ParserStream
{
    let buffer = '';

    function processWithFinalLine(includeTail: boolean): string
    {
        let appended = '';

        // Pull complete lines.
        for (;;)
        {
            const newline = buffer.indexOf('\n');
            if (newline === -1)
            {
                break;
            }

            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);

            if (line === '')
            {
                continue;
            }
            appended += extractFromJsonLine(line);
        }

        // On end-of-stream, treat the remaining buffer (no
        // trailing newline) as a final line if non-empty.
        if (includeTail)
        {
            const tail = buffer.trim();
            buffer = '';
            if (tail !== '')
            {
                appended += extractFromJsonLine(tail);
            }
        }

        return appended;
    }

    return {
        feed(chunk: string)
        {
            buffer += chunk;
            return { append: processWithFinalLine(false), terminated: false };
        },
        finish()
        {
            return { append: processWithFinalLine(true) };
        }
    };
}

/**
 * Pulls appendable text out of a parsed JSON line. Designed for
 * the LLM-API conventions where chunks look like
 * `{"text": "Hello"}` or `{"delta": {"content": "Hello"}}`.
 *
 * @internal
 */
function extractFromJsonLine(line: string): string
{
    let parsed: unknown;
    try
    {
        parsed = JSON.parse(line);
    }
    catch
    {
        // Malformed JSON - silently skip rather than break the
        // whole stream over one bad line.
        return '';
    }

    if (typeof parsed === 'string')
    {
        return parsed;
    }
    if (parsed === null || typeof parsed !== 'object')
    {
        return String(parsed);
    }

    // Walk the most common LLM stream shapes. Stop on first hit.
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.text === 'string')
    {
        return obj.text;
    }
    if (typeof obj.content === 'string')
    {
        return obj.content;
    }
    if (obj.delta && typeof obj.delta === 'object')
    {
        const delta = obj.delta as Record<string, unknown>;
        if (typeof delta.text === 'string')
        {
            return delta.text;
        }
        if (typeof delta.content === 'string')
        {
            return delta.content;
        }
    }

    // Unknown shape - stringify so the user can at least see it.
    return JSON.stringify(parsed);
}

/**
 * Wraps a user-supplied chunk transformer in our internal
 * parser-stream interface.
 *
 * @internal
 */
function createCustomParser(fn: (chunk: string) => string): ParserStream
{
    return {
        feed(chunk: string)
        {
            return { append: fn(chunk), terminated: false };
        },
        finish()
        {
            return { append: '' };
        }
    };
}

/**
 * Picks the right parser implementation for the given mode.
 *
 * @internal
 */
function makeParser(
    mode: StreamParseMode | ((chunk: string) => string) | undefined
): ParserStream
{
    if (typeof mode === 'function')
    {
        return createCustomParser(mode);
    }
    if (mode === 'sse')
    {
        return createSseParser();
    }
    if (mode === 'ndjson')
    {
        return createNdjsonParser();
    }
    return createTextParser();
}

/**
 * Returns true for the values we treat as "no source": null,
 * undefined, or boolean false. `0` and `''` are valid source
 * values; we don't treat them as missing.
 *
 * @internal
 */
function isSkipSource(value: unknown): boolean
{
    return value === null || value === undefined || value === false;
}

/**
 * createStream
 *
 * PURPOSE:
 * Wraps a chunked-response fetcher into a reactive {@link Stream}: partial() accumulates
 * text as chunks arrive, done() flips when the stream ends, error() captures failures,
 * and cancel()/refetch() control it.
 *
 * WHY IT EXISTS:
 * Consuming a streamed response by hand means driving a reader loop, decoding bytes with
 * `{ stream: true }` so multi-byte UTF-8 split across reads is not corrupted, reassembling
 * SSE/ndjson deltas split across chunk boundaries, and getting the abort race right so a
 * superseded stream cannot keep writing. createStream packages all of that as reactive
 * getters, with built-in parsers for the common shapes.
 *
 * COMPILER / RUNTIME ROLE:
 * Runtime, reactivity stage. A client-side data primitive (it drives a network reader and
 * timers); it has no role in synchronous SSR. Must run inside a createRoot (a component or
 * render() provides one) so the in-flight abort and the internal effect clean up on unmount.
 *
 * INPUT CONTRACT:
 * - options.fetcher: returns a Response whose body is a ReadableStream; receives the
 *   resolved source value and an AbortSignal.
 * - options.source: optional getter; a change cancels and restarts. Falsy (false/null/
 *   undefined) skips the fetch (0 and '' are valid keys).
 * - options.parse: 'text' (default) | 'sse' | 'ndjson' | a (chunk) => string function.
 * - options.initial: partial()'s starting value and its reset value on refetch (default '').
 *
 * OUTPUT CONTRACT:
 * - Returns a {@link Stream}: partial() (accumulated text), done() (boolean), error()
 *   (unknown | null), cancel(), refetch(). All getters are reactive.
 *
 * WHY THIS DESIGN:
 * A single driving effect reads `source` and an internal `tick`; cancel/refetch/source-
 * change all route through it, and its onCleanup aborts the previous controller. The
 * consume loop checks signal.aborted before appending so a stale read never writes the new
 * stream's partial, and a late-rejecting old fetch deliberately does NOT touch done() (the
 * effect already set it for whatever caused the abort) - this is what avoids the classic
 * streaming race where an old request clobbers a fresh one.
 *
 * WHEN TO USE:
 * For incremental/streamed responses: LLM token streams (SSE/ndjson), live logs, any
 * chunked transfer where partial output should render as it arrives.
 *
 * WHEN NOT TO USE:
 * For one-shot fetches (use {@link createResource}). Not in SSR, where the reader loop does
 * not run within the synchronous render.
 *
 * EDGE CASES:
 * - Falsy source skips the fetch and resets to initial/done.
 * - cancel() preserves partial() and sets done() without an error; refetch() resets
 *   partial() to initial first.
 * - Malformed ndjson lines are skipped rather than failing the whole stream; SSE without a
 *   trailing `\n\n` drops the last event (matching native EventSource).
 *
 * PERFORMANCE NOTES:
 * One effect + four signals + one live AbortController/reader per stream. Built-in parsers
 * buffer only the incomplete tail between reads.
 *
 * DEVELOPER WARNING:
 * Must be created inside a root/component scope, or the reader loop and pending abort leak
 * on unmount. The fetcher should honor its AbortSignal; otherwise cancellation drops output
 * but does not stop the network work.
 *
 * @typeParam S - The source value type (when `source` is set).
 * @param options - The {@link StreamOptions}: fetcher (required), source, parse, initial.
 * @returns A reactive {@link Stream}.
 * @see {@link createResource}
 * @example
 * const [prompt, setPrompt] = createSignal('');
 * const reply = createStream({
 *     source: () => prompt(),
 *     fetcher: ({ source, signal }) => fetch('/api/chat', {
 *         method: 'POST', body: JSON.stringify({ prompt: source }), signal
 *     }),
 *     parse: 'sse'
 * });
 * h('div', {}, () => reply.partial());
 */
export function createStream<S = void>(options: StreamOptions<S>): Stream
{
    const initial = options.initial ?? '';
    const source = options.source;
    const hasSource = source !== undefined;

    const [partial, setPartial] = createSignal(initial);
    const [done, setDone] = createSignal(true);  // true until first fetch starts
    const [error, setError] = createSignal<unknown>(null);

    // `tick` lets `refetch()` force the driving effect to re-run
    // even when the source hasn't changed - same trick as in
    // createResource. Internal, never exposed.
    const [tick, setTick] = createSignal(0);

    /**
     * Resets the user-facing state to "fresh stream". Wrapped in
     * batch so consumers don't see a half-state where partial is
     * cleared but done is still true.
     */
    function resetState(): void
    {
        batch(() =>
        {
            setPartial(initial);
            setDone(false);
            setError(null);
        });
    }

    /**
     * Drains a Response.body ReadableStream through the parser,
     * pushing parser output into `partial()`. Resolves when the
     * stream ends; rejects only on actual errors (not on user-
     * cancelled aborts, which are silently absorbed).
     */
    async function consume(
        response: Response,
        controller: AbortController
    ): Promise<void>
    {
        const body = response.body;
        if (!body)
        {
            return;
        } // empty response - nothing to stream

        const reader = body.getReader();
        const decoder = new TextDecoder();
        const parser = makeParser(options.parse);

        try
        {
            for (;;)
            {
                const { done: readerDone, value } = await reader.read();
                if (readerDone)
                {
                    // Flush whatever the parser was holding back.
                    const final = parser.finish();
                    if (final.append)
                    {
                        appendPartial(final.append);
                    }
                    return;
                }

                // A re-run / cancel / source-change may have aborted
                // us mid-read. Stop WITHOUT appending: a new stream
                // (if any) now owns `partial`, and `done` is managed
                // by the driving effect - a stale run must not write
                // either. Returning here (rather than letting a late
                // chunk through) keeps a fetcher that ignores its
                // signal from corrupting the fresh stream's output.
                if (controller.signal.aborted)
                {
                    return;
                }

                // `{ stream: true }` is critical - keeps multi-byte
                // UTF-8 sequences split across reads from breaking.
                const text = decoder.decode(value, { stream: true });
                const out = parser.feed(text);
                if (out.append)
                {
                    appendPartial(out.append);
                }
                if (out.terminated)
                {
                    // SSE `[DONE]` sentinel - close the reader to
                    // free the underlying resource.
                    try
                    {
                        await reader.cancel();
                    }
                    catch
                    {
                        // Cancelling an already-closed reader can
                        // throw; harmless to ignore.
                    }
                    return;
                }
            }
        }
        finally
        {
            // If we exit through the catch (or via reader.cancel
            // succeeding) make sure no stale ref is held.
            void controller;
        }
    }

    function appendPartial(text: string): void
    {
        setPartial(prev => prev + text);
    }

    /**
     * Starts a fresh fetch under a new AbortController. Called
     * from the driving effect (on source change / refetch) and
     * is the only path that actually networks.
     */
    function startStream(sourceValue: S): void
    {
        const controller = new AbortController();
        resetState();

        // Wire the abort to the cleanup so a re-run / unmount /
        // explicit cancel() all converge here.
        onCleanup(() =>
        {
            // Aborting after completion is harmless; AbortController
            // itself is one-shot.
            controller.abort();
        });

        Promise.resolve()
            .then(() => options.fetcher({ source: sourceValue, signal: controller.signal }))
            .then(response => consume(response, controller))
            .then(
                () =>
                {
                    if (!controller.signal.aborted)
                    {
                        setDone(true);
                    }
                    // If aborted, `done()` was already flipped by
                    // the cancel() path or will be by the next
                    // effect run - don't fight it here.
                },
                (err: unknown) =>
                {
                    if (controller.signal.aborted)
                    {
                        // Superseded or cancelled - swallow the
                        // AbortError and preserve partial. Crucially,
                        // do NOT touch `done` here: the driving effect
                        // already set it correctly for whatever caused
                        // the abort (true for cancel/skip-source, and
                        // FALSE because a fresh stream started for
                        // refetch/source-change). Writing `done = true`
                        // here would clobber that fresh stream - the
                        // exact race a late-rejecting old fetch causes.
                        return;
                    }
                    batch(() =>
                    {
                        setError(() => err);
                        setDone(true);
                    });
                }
            );
    }

    /**
     * Externally-callable cancel. We can't reach the active
     * AbortController from here directly (it's in startStream's
     * closure) - instead, we bump tick which fires the effect's
     * onCleanup, which calls controller.abort. Net effect is the
     * same; one path covers cancel + refetch + source-change +
     * unmount.
     */
    function cancelImpl(): void
    {
        if (done())
        {
            return;
        }
        // Trigger the effect's onCleanup by re-running it with
        // `pendingCancel = true` so the next iteration sets done
        // without starting a new fetch.
        pendingCancel = true;
        setTick(t => t + 1);
    }

    function refetch(): void
    {
        // Just bump tick - the effect will tear down (onCleanup
        // fires the controller.abort) and start fresh.
        setTick(t => t + 1);
    }

    let pendingCancel = false;

    // The reactive driver.
    createEffect(() =>
    {
        tick(); // subscribe so refetch / cancel can force a re-run

        if (pendingCancel)
        {
            // The previous run's onCleanup already aborted. Mark
            // done and stay idle until the next refetch or
            // source change.
            pendingCancel = false;
            setDone(true);
            return;
        }

        let sourceValue: S = undefined as S;
        if (hasSource)
        {
            const v = source();
            if (isSkipSource(v))
            {
                // No source, no fetch. Reset to initial state
                // ("idle, nothing streamed yet").
                batch(() =>
                {
                    setPartial(initial);
                    setDone(true);
                    setError(null);
                });
                return;
            }
            sourceValue = v as S;
        }

        startStream(sourceValue);
    });

    return {
        partial,
        done,
        error,
        cancel: cancelImpl,
        refetch
    };
}
