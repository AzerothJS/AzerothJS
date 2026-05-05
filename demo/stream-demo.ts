// ============================================================================
// AZEROTHJS — AI Streaming Demo
// ============================================================================
//
// A self-contained "AI chat" UI that demonstrates `createStream`.
// No real network — the fetcher returns a `ReadableStream` that
// emits SSE chunks via setTimeout, simulating what an OpenAI /
// Anthropic / similar endpoint would push at ~30 tokens / second.
//
// What this exercises end-to-end:
//   - createStream with `parse: 'sse'`
//   - Source-driven re-fetching (new prompt → new stream)
//   - Cancellation via `signal.aborted` (Stop button)
//   - Manual refetch (Regenerate button)
//   - Reactive partial() rendering token-by-token
//
// ============================================================================

import {
    defineComponent,
    h,
    createSignal,
    createStream
} from '@azerothjs/core';

// ── Canned responses ─────────────────────────────────────────
//
// Three "personalities" picked by simple keyword matching on the
// prompt. Keeps the demo entertaining without pretending to be
// an actual model.

const RESPONSES: Record<string, string> =
{
    code:
        'Here is a clean implementation in TypeScript. We define a type for the input, ' +
        'a pure function that handles the transformation, and a small test that confirms ' +
        'the behaviour at the boundaries. The reactive layer wires the result into the ' +
        'UI without any virtual-DOM diffing — every signal read becomes a direct DOM update.',
    weather:
        'Today the forecast looks bright with light winds and high pressure settling in. ' +
        'Expect partly cloudy skies through midday, clearing by late afternoon. ' +
        'Overnight lows around twelve degrees with a gentle breeze from the south-west.',
    default:
        'That is an interesting question. Let me think through the details. ' +
        'There are several approaches you could take, each with its own trade-offs. ' +
        'The most common path is the one that minimises moving parts while keeping ' +
        'the cognitive overhead low for everyone reading the code six months from now.'
};

function pickResponse(prompt: string): string
{
    const p = prompt.toLowerCase();
    if (p.includes('code') || p.includes('script') || p.includes('typescript')) return RESPONSES.code;
    if (p.includes('weather') || p.includes('rain') || p.includes('sun')) return RESPONSES.weather;
    return RESPONSES.default;
}

// ── Fake streaming endpoint ──────────────────────────────────

const TOKEN_DELAY_MS = 30;

/**
 * Builds a `Response` whose body emits SSE-formatted token chunks
 * at TOKEN_DELAY_MS intervals. Honours the AbortSignal so a
 * `cancel()` on the consumer side stops the timer chain instead
 * of running the canned response to completion.
 */
function fakeAiStream(prompt: string, signal: AbortSignal): Response
{
    const text = pickResponse(prompt);

    // Tokenise into "word + trailing whitespace" units so each
    // SSE event ships one whole word and the joined output keeps
    // the original spacing.
    const tokens = text.match(/\S+\s*/g) ?? [];

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
        start(controller)
        {
            let index = 0;
            let timer: ReturnType<typeof setTimeout> | null = null;

            function emitNext(): void
            {
                if (signal.aborted)
                {
                    // Consumer cancelled — close the stream so the
                    // reader resolves cleanly. The createStream
                    // primitive will absorb the close and preserve
                    // partial().
                    try
                    {
                        controller.close();
                    }
                    catch
                    {
                        // Already closed — harmless.
                    }
                    return;
                }

                if (index >= tokens.length)
                {
                    // End of canned response. Emit the SSE [DONE]
                    // sentinel so the createStream parser stops
                    // cleanly without waiting for a close.
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    controller.close();
                    return;
                }

                const token = tokens[index++];
                controller.enqueue(encoder.encode(`data: ${ token }\n\n`));
                timer = setTimeout(emitNext, TOKEN_DELAY_MS);
            }

            // Stop the timer chain immediately on abort so we
            // don't keep enqueueing into a closed stream.
            signal.addEventListener('abort', () =>
            {
                if (timer !== null) clearTimeout(timer);
                try
                {
                    controller.close();
                }
                catch
                {
                    // Already closed — harmless.
                }
            });

            // Small initial delay so the user sees "Streaming…"
            // for a beat before tokens start arriving.
            timer = setTimeout(emitNext, 120);
        }
    });

    return new Response(stream);
}

// ── Component ────────────────────────────────────────────────

export const StreamDemo = defineComponent(() =>
{
    const [prompt, setPrompt] = createSignal('Tell me about TypeScript');
    const [submitted, setSubmitted] = createSignal('');

    const chat = createStream({
        // Source-falsy short-circuits before the user sends.
        source: () => submitted() === '' ? null : submitted(),
        fetcher: ({ source, signal }) =>
            Promise.resolve(fakeAiStream(source as string, signal)),
        parse: 'sse',
        initial: ''
    });

    function handleSend(event: Event): void
    {
        event.preventDefault();
        const text = prompt().trim();
        if (text.length === 0) return;
        // Bump submitted() — even if the prompt text matches the
        // last value, signals only re-fire on a real change. To
        // force a fresh stream for the same prompt, the user can
        // hit Regenerate (which calls chat.refetch directly).
        setSubmitted(text);
    }

    function handleClear(): void
    {
        chat.cancel();
        setSubmitted('');
    }

    return h('div', { class: 'glass' },
        h('div', { class: 'feature-tags' },
            ...['createStream', 'parse:sse', 'AbortSignal', 'partial()',
                'done()', 'cancel()', 'refetch()']
                .map(tag => h('span', { class: 'feature-tag' }, tag))
        ),
        h('h2', {}, '🤖 AI Streaming — token-by-token chat UI'),

        h('p', { class: 'stream-demo-intro' },
            'Built on `createStream` with the SSE parser. The fetcher returns a ',
            h('code', {}, 'ReadableStream'),
            ' that emits `data: <token>\\n\\n` events at ~30 ms intervals — same shape as ',
            'every real LLM API. No server, no network: this entire demo is client-side.'
        ),

        h('form',
            {
                class: 'stream-demo-form',
                onSubmit: handleSend,
                novalidate: true
            },
            h('input',
                {
                    class: 'stream-demo-input',
                    type: 'text',
                    value: () => prompt(),
                    onInput: (e: Event) =>
                        setPrompt((e.target as HTMLInputElement).value),
                    placeholder: 'Try: "weather" or "code" or anything else',
                    autocomplete: 'off'
                }
            ),
            h('div', { class: 'stream-demo-buttons' },
                h('button',
                    {
                        type: 'submit',
                        class: 'btn-primary btn-sm',
                        disabled: () => !chat.done()
                    },
                    () => chat.done() ? 'Send' : 'Streaming…'
                ),
                h('button',
                    {
                        type: 'button',
                        class: 'btn-ghost btn-sm',
                        onClick: () => chat.cancel(),
                        disabled: () => chat.done()
                    },
                    'Stop'
                ),
                h('button',
                    {
                        type: 'button',
                        class: 'btn-ghost btn-sm',
                        onClick: () => chat.refetch(),
                        disabled: () =>
                            !chat.done() || submitted() === ''
                    },
                    'Regenerate'
                ),
                h('button',
                    {
                        type: 'button',
                        class: 'btn-ghost btn-sm',
                        onClick: handleClear
                    },
                    'Clear'
                )
            )
        ),

        h('div', { class: 'stream-demo-output' },
            // Status pill — reflects the live stream state.
            h('div', { class: 'stream-demo-status' }, () =>
            {
                if (chat.error())
                {
                    return `❌ ${ chat.error() instanceof Error
                        ? (chat.error() as Error).message
                        : String(chat.error()) }`;
                }
                if (submitted() === '') return 'Idle — enter a prompt and press Send';
                if (!chat.done()) return '✨ Streaming…';
                return '✓ Done';
            }),

            // The actual streaming text — partial() updates token
            // by token as chunks arrive.
            h('div', { class: 'stream-demo-bubble' }, () =>
                chat.partial() === '' && chat.done()
                    ? '(awaiting your prompt)'
                    : chat.partial() || '…'
            )
        )
    );
});
