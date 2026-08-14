// @vitest-environment node
//
// Every head insertion - stylesheet, loader handoff, head-runtime additions - must land at
// the ONE `</head>` anchor located on the shell BEFORE any content is inserted. Collected
// CSS can legitimately contain a literal `</head>` (inside a `content:` string it is inert
// to the browser, since only `</style` leaves the style element's raw-text state), and a
// splice that re-searches the document after an insert finds THAT occurrence first: the
// handoff and every head addition then land inside the style element as dead CSS text -
// hydration's handoff and the canonical/OG/JSON-LD head silently lost.
import { describe, expect, it } from 'vitest';

import { RouterProvider, Routes, createMemoryHistory, createRouter, css, h, useHead } from 'azerothjs';
import type { LoaderHandoff, Route } from 'azerothjs';
import { createPageRenderer } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';
const HANDOFF_MARK = 'id="__azeroth-loader-handoff"';

const routes: Route[] = [{
    path: '/',
    component: () =>
    {
        // Per-render, so THIS render's collect drains it; the payload is the anchor text.
        const styles = css('.evil::after { content: "</head>"; }');
        useHead({ title: 'Anchored', meta: [{ property: 'og:title', content: 'OG-PIN' }] });
        return h('p', { class: styles.evil }, 'body');
    }
}];

const PageApp = (props: { url?: string; handoff?: LoaderHandoff }): HTMLElement =>
    RouterProvider({
        router: createRouter({
            routes,
            history: createMemoryHistory(props.url ?? '/'),
            initialLoaderData: props.handoff
        }),
        children: () => Routes({ fallback: () => h('h1', {}, 'nf') })
    }) as HTMLElement;

const render = createPageRenderer(PageApp, routes);

function expectIntactHead(document: string): void
{
    const styleClose = document.indexOf('</style>');
    const handoffAt = document.indexOf(HANDOFF_MARK);
    const metaAt = document.indexOf('content="OG-PIN"');
    const bodyAt = document.indexOf('<div id="root">');

    // The CSS carrier itself survives verbatim - it is valid, inert style content.
    expect(document).toContain('content: "</head>"');
    expect(styleClose).toBeGreaterThan(-1);

    // The handoff and the head addition follow the CLOSED style element; landing before
    // `</style>` means they were spliced into the CSS and the browser never parses them.
    expect(handoffAt).toBeGreaterThan(styleClose);
    expect(metaAt).toBeGreaterThan(styleClose);

    // Normalized order, all inside the real head: style -> handoff -> head additions.
    expect(metaAt).toBeGreaterThan(handoffAt);
    expect(metaAt).toBeLessThan(bodyAt);

    // Title surgery still ran against the shell's own head.
    expect(document).toContain('>Anchored</title>');
}

describe('a style payload containing </head> displaces no later splice', () =>
{
    it('buffered: handoff and head additions land in the real head', async () =>
    {
        const result = await render('/', SHELL);
        expect(result.kind).toBe('html');
        expectIntactHead((result as { html: string }).html);
    });

    it('streamed: the first chunk carries the same intact head', async () =>
    {
        const result = await render('/', SHELL, { stream: true });
        expect(result.kind).toBe('stream');

        const reader = (result as { stream: ReadableStream<Uint8Array> }).stream.getReader();
        const first = new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
        await reader.cancel();

        expectIntactHead(first);
    });
});
