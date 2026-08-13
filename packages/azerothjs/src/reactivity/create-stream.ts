/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * A chunked response as a reactive container: `partial()` grows as each chunk arrives and
 * `done()` flips when the stream ends. Where createResource resolves once and exposes
 * `data()`, this resolves incrementally, and the two share their error capture,
 * cancellation and refetch shapes.
 *
 * Parse modes: `'text'` appends each chunk verbatim; `'sse'` strips the `data:` prefix,
 * skips `:` comments and terminates on `data: [DONE]`; `'ndjson'` parses each line and
 * extracts `.text`, `.content` or `.delta` when present, otherwise stringifying the parsed
 * value; a function does whatever it likes. Built-in modes buffer across reads, so a delta
 * split over two chunks - `data: he` then `llo\n\n` - is reassembled into one event.
 *
 * cancel() aborts the request in flight, preserving `partial()` and flipping `done()`
 * without setting an error. refetch() cancels, resets `partial()` to `initial`, and starts
 * again on the same source value. Both converge on the driving effect's cleanup.
 *
 * Doing this by hand means driving a reader loop, decoding with `{ stream: true }` so
 * multi-byte UTF-8 split across reads is not corrupted, reassembling deltas across chunk
 * boundaries, and getting the abort race right so a superseded stream cannot keep writing.
 * The parser and driving-effect internals below carry their own comments; that logic is
 * subtle enough to be worth reading before changing.
 */

import type { Getter } from './types.ts';
import { createSignal } from './create-signal.ts';
import { createEffect, routeAsyncError } from './create-effect.ts';
import { onCleanup } from './on-cleanup.ts';
import { batch } from './batch.ts';
import { currentErrorHandler } from './catch-error.ts';
import { dtEnterPrimitive, dtExitPrimitive } from './devtools.ts';

/** Built-in parse modes. Pass a function instead for full control over each chunk. */
export type StreamParseMode = 'text' | 'sse' | 'ndjson';

/**
 * Options for {@link createStream}. The `source` and `fetcher` shapes mirror createResource.
 *
 * @typeParam S - The source value type, when `source` is set.
 */
export interface StreamOptions<S = void>
{
    /**
     * Changing this cancels the current request and starts a new one. Returning `null`,
     * `undefined` or `false` skips the fetch entirely, which is how "wait until the user is
     * logged in" is expressed.
     */
    source?: () => S | false | null | undefined;

    /**
     * Returns a Response whose body is a ReadableStream. Receives the resolved source value,
     * or `undefined` when `source` is omitted, and a signal that fires on cancel, refetch and
     * source change.
     */
    fetcher: (args: { source: S; signal: AbortSignal }) => Promise<Response>;

    /**
     * How to interpret incoming chunks. Defaults to `'text'`. A function receives the
     * already-decoded chunk and returns the text to append.
     */
    parse?: StreamParseMode | ((chunk: string) => string);

    /** `partial()`'s value before any chunk arrives, and what refetch resets it to. Default `''`. */
    initial?: string;

    /** Debug name for devtools; groups the stream's partial, done, error and drive nodes. */
    name?: string;
}

/** The reactive shape returned by {@link createStream}. */
export interface Stream
{
    /** The accumulated text, updated after every chunk the parser turns into output. */
    partial: Getter<string>;

    /**
     * True once the stream has ended, whether by normal close, cancellation or error. Read
     * `error()` to tell which.
     */
    done: Getter<boolean>;

    /**
     * The most recent failure, or null. Set when the fetcher throws, the body errors, or the
     * stream breaks for any reason other than cancellation - cancelling never populates it.
     */
    error: Getter<unknown>;

    /**
     * Aborts the stream in flight. `partial()` keeps whatever it had and `done()` flips true.
     * A no-op once the stream has ended.
     */
    cancel: () => void;

    /** Cancels, resets `partial()` to `initial`, and starts again on the current source value. */
    refetch: () => void;
}

// Each parser is a stateful transformer: `feed` takes a raw chunk and returns what is
// appendable plus a termination flag for SSE's `[DONE]`; `finish` runs once at end-of-stream
// to flush a buffered tail.

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

            const lines: string[] = [];
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

                // Per spec, exactly ONE optional space after `data:` is stripped - and no
                // more: a payload's own leading space (a tokenizer's separator) must survive
                // the frame, so trimming further would corrupt real token streams.
                const data = line.startsWith('data: ') ? line.slice(6) : line.slice(5);

                if (data === '[DONE]')
                {
                    terminated = true;
                    break;
                }

                lines.push(data);
            }
            // Spec: multiple data lines in ONE event reassemble joined by a single LF -
            // that is how the server framer's multi-line payload round-trips byte-exact.
            // Events themselves concatenate with nothing between them (token streaming).
            appended += lines.join('\n');
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
 * @internal Normalizes createStream's three call forms into one {@link StreamOptions} object.
 * A positional fetcher `(sourceValue, signal) => Response` is wrapped into the internal
 * `({ source, signal }) => Response` shape, so the object-form fetcher and the positional
 * form the `stream` keyword emits both feed the same driver. Discriminated exactly like
 * createResource: the second argument being a function means "source + fetcher".
 */
function normalizeStreamOptions<S>(
    a: StreamOptions<S> | (() => S | false | null | undefined) | PositionalStandaloneFetcher,
    b?: PositionalSourceFetcher<S> | StreamTail<void>,
    c?: StreamTail<S>
): StreamOptions<S>
{
    // Object form: the first argument is the options object.
    if (typeof a !== 'function')
    {
        return a;
    }
    const hasSource = typeof b === 'function';
    const tail = (hasSource ? c : b as StreamTail<S> | undefined) ?? {};
    if (hasSource)
    {
        const source = a as () => S | false | null | undefined;
        const fetcher = b;
        return { ...tail, source, fetcher: ({ source: value, signal }) => fetcher(value, signal) };
    }
    const fetcher = a as PositionalStandaloneFetcher;
    return { ...tail, fetcher: ({ signal }) => fetcher(signal) };
}

/** A positional fetcher with a source: receives the resolved source value and the abort signal. */
type PositionalSourceFetcher<S> = (source: S, signal: AbortSignal) => Promise<Response>;

/** A positional fetcher with no source: receives only the abort signal. */
type PositionalStandaloneFetcher = (signal: AbortSignal) => Promise<Response>;

/** The `parse` and `initial` tail shared by the positional forms. */
type StreamTail<S> = Omit<StreamOptions<S>, 'fetcher' | 'source'>;

/**
 * Wraps a chunked-response fetcher into a reactive {@link Stream}: `partial()` accumulates
 * text as chunks arrive, `done()` flips when the stream ends, `error()` captures failures,
 * and `cancel()` / `refetch()` control it.
 *
 * This positional form is what the `stream` keyword lowers to, mirroring
 * `createResource(source, fetcher)`. A source change cancels the current request and starts
 * a new one; a source returning `false`, `null` or `undefined` skips the fetch entirely and
 * resets to `initial`, while `0` and `''` remain valid keys.
 *
 * Create it inside a scope, or the reader loop and pending abort leak on unmount. The
 * fetcher should honour its AbortSignal - otherwise cancelling drops the output but does
 * not stop the network work.
 *
 * A superseded stream cannot write over a fresh one: the consume loop checks the abort
 * before appending, and a late-rejecting old request deliberately leaves `done()` alone,
 * since the effect has already set it for whatever caused the abort.
 *
 * Client-side only. The reader loop does not run inside a synchronous SSR render.
 *
 * @typeParam S - The source value type.
 * @param source - Getter for the fetch key. Falsy values skip the fetch.
 * @param fetcher - Returns a Response whose body is a ReadableStream.
 * @param options - Optional settings.
 * @param options.parse - `'text'` (default), `'sse'`, `'ndjson'`, or a `(chunk) => string`
 *                        function. Built-in parsers buffer across reads, so a delta split
 *                        over two chunks is reassembled into one event.
 * @param options.initial - `partial()`'s starting value, and what refetch resets it to.
 *                          Defaults to `''`.
 * @param options.name - Debug name for devtools.
 * @returns A reactive {@link Stream}.
 * @example
 * const [prompt, setPrompt] = createSignal('');
 *
 * const reply = createStream(
 *     () => prompt(),
 *     (text, signal) => fetch('/api/chat', {
 *         method: 'POST',
 *         body: JSON.stringify({ prompt: text }),
 *         signal
 *     }),
 *     { parse: 'sse' }
 * );
 *
 * h('div', {}, () => reply.partial()); // repaints per token
 *
 * @see {@link createResource} for one-shot fetches.
 */
export function createStream<S>(
    source: () => S | false | null | undefined,
    fetcher: PositionalSourceFetcher<S>,
    options?: StreamTail<S>
): Stream;
/**
 * Source-free positional form: the stream starts once, on creation.
 *
 * @param fetcher - Returns a Response whose body is a ReadableStream.
 * @param options - `parse`, `initial` and `name`, as in the source form.
 * @returns A reactive {@link Stream}.
 * @example
 * const logs = createStream((signal) => fetch('/api/logs', { signal }));
 * logs.partial(); // grows as lines arrive
 * logs.cancel();  // stops reading; partial() keeps what it had, done() flips true
 */
export function createStream(
    fetcher: PositionalStandaloneFetcher,
    options?: StreamTail<void>
): Stream;
/**
 * Options-object form, where the fetcher receives `{ source, signal }` as one argument.
 *
 * @typeParam S - The source value type.
 * @param options - Must include `fetcher`; `source`, `parse`, `initial` and `name` are
 *                  optional and behave as in the positional form.
 * @returns A reactive {@link Stream}.
 * @example
 * const reply = createStream({
 *     source: () => prompt(),
 *     fetcher: ({ source, signal }) => fetch('/api/chat', {
 *         method: 'POST',
 *         body: JSON.stringify({ prompt: source }),
 *         signal
 *     }),
 *     parse: 'sse'
 * });
 */
export function createStream<S = void>(options: StreamOptions<S>): Stream;
export function createStream<S = void>(
    a: StreamOptions<S> | (() => S | false | null | undefined) | PositionalStandaloneFetcher,
    b?: PositionalSourceFetcher<S> | StreamTail<void>,
    c?: StreamTail<S>
): Stream
{
    const options = normalizeStreamOptions<S>(a, b, c);
    const initial = options.initial ?? '';
    const source = options.source;
    const hasSource = source !== undefined;

    // Captured at construction, matching how an effect captures its catchError scope: a
    // subscriber that throws while a settle propagates (the batch flush rethrows it) is
    // otherwise an unhandled rejection, since the settle runs in a promise reaction.
    const settleErrorHandler = currentErrorHandler;

    const frame = dtEnterPrimitive('stream', options.name);
    const [partial, setPartial] = createSignal(initial, { name: 'partial' });
    const [done, setDone] = createSignal(true, { name: 'done' });  // true until first fetch starts
    const [error, setError] = createSignal<unknown>(null, { name: 'error' });

    // `tick` lets `refetch()` force the driving effect to re-run
    // even when the source hasn't changed - same trick as in
    // createResource. Internal, never exposed.
    const [tick, setTick] = createSignal(0, { name: 'tick' });

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
            )
            .catch((err: unknown) =>
            {
                // Both settle arms write signals (setDone / the error batch), and a
                // SUBSCRIBER throwing during that flush rethrows here - a promise
                // reaction with nothing downstream. Route it through the effect error
                // ladder; a FETCHER failure never reaches this (captured in error()
                // by the arm above).
                routeAsyncError(err, settleErrorHandler, options.name);
            });
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
    }, { name: 'drive' });
    dtExitPrimitive(frame);

    return {
        partial,
        done,
        error,
        cancel: cancelImpl,
        refetch
    };
}
