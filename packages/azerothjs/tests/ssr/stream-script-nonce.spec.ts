// @vitest-environment node
//
// The CSP nonce a streamed page stamps onto its inline scripts crosses an attribute
// boundary, and its producer is the host's per-request code over the live request. Both
// emitters - the one-time swap runtime and every chunk's swap call - must write it through
// the attribute escaper, or a hostile value walks out of the attribute and into markup.
import { describe, expect, it } from 'vitest';
import { Suspense, createResource, h, renderToStream } from 'azerothjs';

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string>
{
    const decoder = new TextDecoder();
    let text = '';
    const reader = stream.getReader();
    for (;;)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            break;
        }
        text += decoder.decode(value, { stream: true });
    }
    return text;
}

function pendingPage(gate: Promise<string>): () => HTMLElement
{
    return (): HTMLElement =>
    {
        const resource = createResource<string>(() => gate);
        return h('main', {},
            Suspense({
                fallback: () => h('p', {}, 'loading'),
                on: [resource],
                children: () => h('section', {}, () => resource.data() ?? '')
            }));
    };
}

describe('renderToStream escapes the nonce on every inline script', () =>
{
    it('a hostile nonce cannot break out of the attribute on the runtime or the swap script', async () =>
    {
        let release!: (value: string) => void;
        const gate = new Promise<string>((resolve) =>
        {
            release = resolve;
        });
        const stream = renderToStream(pendingPage(gate), { scriptNonce: 'abc" onload="evil' });
        release('done');
        const streamed = await readAll(stream);

        // Never written raw - that spelling IS the attribute breakout.
        expect(streamed).not.toContain('nonce="abc" onload="evil"');
        // Written escaped on BOTH emitters: the runtime script and the chunk's swap call.
        const escaped = streamed.match(/nonce="abc&quot; onload=&quot;evil"/g) ?? [];
        expect(escaped.length).toBe(2);
    });

    it('a legitimate base64 nonce passes through unchanged', async () =>
    {
        let release!: (value: string) => void;
        const gate = new Promise<string>((resolve) =>
        {
            release = resolve;
        });
        const stream = renderToStream(pendingPage(gate), { scriptNonce: 'n0nCe+/=' });
        release('done');
        const streamed = await readAll(stream);

        const stamped = streamed.match(/nonce="n0nCe\+\/="/g) ?? [];
        expect(stamped.length).toBe(2);
    });
});
