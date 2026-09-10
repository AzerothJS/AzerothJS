// @vitest-environment node
//
// The url prefix is pinned for a streamed response the way the language is: a router built
// inside a Suspense continuation adopts it, and the pin refuses anything but a language prefix.
import { describe, expect, it } from 'vitest';
import { Link, Suspense, createMemoryHistory, createResource, createRouter, h, renderToStream } from 'azerothjs';
import type { Route } from 'azerothjs';

const routes: Route[] = [{ path: '/about', component: (): HTMLElement => h('p', {}, 'about') }];

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string>
{
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let out = '';
    for (;;)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            return out;
        }
        out += decoder.decode(value, { stream: true });
    }
}

function page(): { app: () => HTMLElement; release: () => void }
{
    let release!: () => void;
    const pending = new Promise<string>((resolve) =>
    {
        release = (): void => resolve('late');
    });
    const app = (): HTMLElement =>
    {
        const late = createResource<string>(() => pending);
        return h('main', {},
            Suspense({
                fallback: () => h('p', {}, 'wait'),
                on: [late],
                // Built INSIDE the continuation: the only reader of a continuation-scoped pin.
                children: (): HTMLElement =>
                {
                    const router = createRouter({ routes, history: createMemoryHistory('/fa/about') });
                    return h('section', {}, Link({ to: '/about', router, children: late.data() ?? '' }));
                }
            }));
    };
    return { app, release };
}

describe('renderToStream with a base', () =>
{
    it('a router constructed inside a continuation adopts the pin', async () =>
    {
        const { app, release } = page();
        const errors: unknown[] = [];
        const stream = renderToStream(app, { base: '/fa', onError: (error) => errors.push(error) });
        release();
        const out = await readAll(stream);
        expect(errors).toEqual([]);
        expect(out).toContain('<template data-azs=');
        expect(out).toContain('href="/fa/about"');
        expect(out).toContain('late');
    });

    it('without a base the same router has none', async () =>
    {
        const { app, release } = page();
        const stream = renderToStream(app, {});
        release();
        const out = await readAll(stream);
        expect(out).toContain('href="/about"');
        expect(out).not.toContain('href="/fa/about"');
    });

    it.each(['//evil.example', '/fa/x', 'fa', '/pt_BR', 'https://x', ''])('refuses the base %j before any byte', (junk) =>
    {
        expect(() => renderToStream(() => h('main', {}, 'x'), { base: junk })).toThrow(/one language tag/);
    });
});
