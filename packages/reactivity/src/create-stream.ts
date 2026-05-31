// ============================================================================
// AZEROTHJS — createStream (Reactive Streaming Source)
// ============================================================================
//
// Wraps a chunked-response fetcher (typically `fetch()`) into a
// reactive container that updates `partial()` as each chunk
// arrives, then flips `done()` when the stream ends. The same
// shape AI products like ChatGPT use to render token-by-token
// responses, exposed as a one-line primitive.
//
//   const chat = createStream({
//       fetcher: ({ signal }) => fetch('/api/chat', { signal }),
//       parse:   'sse'
//   });
//
//   h('div', {}, () => chat.partial());
//   h('button', { onClick: chat.cancel }, 'Stop');
//
// FAMILY WITH createResource:
//
//   createResource resolves once, exposes `data()` when settled.
//   createStream resolves incrementally, exposes `partial()` that
//   updates per chunk. Both share `loading`-style flags, error
//   capture, cancellation, and a `refetch` method. Users who know
//   one know the other.
//
// PARSE MODES:
//
//   'text'    — each chunk is appended verbatim
//   'sse'     — Server-Sent Events: strips `data:` prefix, skips
//               comments (`: ...`), terminates on `data: [DONE]`
//   'ndjson'  — newline-delimited JSON; extracts `.text` /
//               `.content` / `.delta` if present, otherwise
//               stringifies the parsed value
//   custom    — a function `(chunk: string) => string`
//
//   Built-in modes buffer across reads so a delta split across
//   two chunks (`data: he` then `llo\n\n`) is correctly assembled
//   into one event.
//
// CANCELLATION:
//
//   `cancel()` aborts the in-flight fetch via AbortController.
//   `partial()` is preserved (the user's already-streamed content
//   stays on screen), `done()` flips true, no error.
//
//   `refetch()` cancels the current stream, resets `partial()` to
//   `initial`, and starts a new request. Same source value if
//   one is provided; otherwise a fresh fetch.
//
// ============================================================================

import type { Getter } from './types.ts';
import { createSignal } from './signal.ts';
import { createEffect } from './effect.ts';
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
     * entirely — same convention as `createResource`. Use this
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
     * Pass a function for full control — it receives the
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
     * `true` when the stream has ended — successfully (close /
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

// ── Parser machinery ─────────────────────────────────────────
//
// Each parser is a stateful "transformer": `feed` accepts a
// raw chunk and returns whatever's appendable plus a termination
// flag (for SSE's `[DONE]`). `finish` runs once at end-of-stream
// to flush any buffered tail.

interface ParserStream
{
    feed(chunk: string): { append: string; terminated: boolean };
    finish(): { append: string };
}

/** Built-in `'text'` mode — every chunk appended verbatim. */
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
                // Comment line.
                if (line.startsWith(':'))
                {
                    continue;
                }
                // We only care about data: lines for the partial
                // text. event:, id:, retry: ignored in v1.
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
            // last event is lost — same behaviour as every
            // browser's native EventSource.
            return { append: '' };
        }
    };
}

/**
 * Built-in `'ndjson'` mode — newline-delimited JSON. Each
 * complete line is parsed; we extract `text`/`content`/`delta`
 * fields if the parsed value is an object, otherwise stringify.
 *
 * Malformed lines are silently skipped — strict-error behaviour
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
        // Malformed JSON — silently skip rather than break the
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

    // Unknown shape — stringify so the user can at least see it.
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

// ── The primitive itself ────────────────────────────────────

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
 * Builds a streaming reactive source. `partial()` accumulates
 * text as chunks arrive; `done()` flips when the stream ends.
 *
 * Must be called inside a `createRoot()` so the in-flight abort
 * and the internal effect can clean up on unmount. AzerothJS's
 * top-level `render()` provides one automatically.
 *
 * @typeParam S - The source value's type (when `source` is set)
 *
 * @example
 * ```ts
 * // Simple text stream — every chunk appended verbatim.
 * const live = createStream({
 *     fetcher: ({ signal }) => fetch('/api/log', { signal }),
 *     parse: 'text'
 * });
 *
 * h('pre', {}, () => live.partial());
 * ```
 *
 * @example
 * ```ts
 * // OpenAI-style SSE streaming with a prompt-driven source.
 * const [prompt, setPrompt] = createSignal('');
 *
 * const reply = createStream({
 *     source: () => prompt(),
 *     fetcher: ({ source, signal }) => fetch('/api/chat', {
 *         method: 'POST',
 *         headers: { 'content-type': 'application/json' },
 *         body: JSON.stringify({ prompt: source }),
 *         signal
 *     }),
 *     parse: 'sse'
 * });
 *
 * h('div', { class: 'reply' }, () => reply.partial());
 * h('button', { onClick: reply.cancel,  disabled: () => reply.done() }, 'Stop');
 * h('button', { onClick: reply.refetch, disabled: () => !reply.done() }, 'Regenerate');
 * ```
 *
 * @example
 * ```ts
 * // Custom parser — unwrap whatever shape your endpoint emits.
 * const stream = createStream({
 *     fetcher: ({ signal }) => fetch('/api/odd', { signal }),
 *     parse: chunk => chunk.replace(/EVENT:/g, '').trim() + '\n'
 * });
 * ```
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
    // even when the source hasn't changed — same trick as in
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
        } // empty response — nothing to stream

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
                // by the driving effect — a stale run must not write
                // either. Returning here (rather than letting a late
                // chunk through) keeps a fetcher that ignores its
                // signal from corrupting the fresh stream's output.
                if (controller.signal.aborted)
                {
                    return;
                }

                // `{ stream: true }` is critical — keeps multi-byte
                // UTF-8 sequences split across reads from breaking.
                const text = decoder.decode(value, { stream: true });
                const out = parser.feed(text);
                if (out.append)
                {
                    appendPartial(out.append);
                }
                if (out.terminated)
                {
                    // SSE `[DONE]` sentinel — close the reader to
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
                    // effect run — don't fight it here.
                },
                err =>
                {
                    if (controller.signal.aborted)
                    {
                        // Superseded or cancelled — swallow the
                        // AbortError and preserve partial. Crucially,
                        // do NOT touch `done` here: the driving effect
                        // already set it correctly for whatever caused
                        // the abort (true for cancel/skip-source, and
                        // FALSE because a fresh stream started for
                        // refetch/source-change). Writing `done = true`
                        // here would clobber that fresh stream — the
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
     * closure) — instead, we bump tick which fires the effect's
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
        // Just bump tick — the effect will tear down (onCleanup
        // fires the controller.abort) and start fresh.
        setTick(t => t + 1);
    }

    let pendingCancel = false;

    // ── The reactive driver ──────────────────────────────────
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
            const v = source!();
            if (isSkipSource(v))
            {
                // No source → no fetch. Reset to initial state
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
