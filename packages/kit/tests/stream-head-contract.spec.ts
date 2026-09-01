// @vitest-environment node
//
// What a STREAMED page's head can and cannot carry, pinned end to end over the real
// mountPages server rather than at the frame.
//
// The shell's bytes are gone by the time a Suspense boundary settles, so a useHead declared
// inside a continuation cannot reach the served document - no mechanism can edit bytes that
// have already left. That is a property of streaming, not a bug, and it has one consequence
// worth pinning: the CRAWLER-visible head and the BROWSER-visible head would diverge, because
// the client applier still runs the same declaration after hydration. The arms below fix both
// halves of the contract so neither can drift silently - the drop is measured and diagnosed,
// and the path that DOES work (facts resolved during the synchronous main pass, which is where
// a route's loader data already is) is proven to reach the flushed head.
import { describe, it, expect, vi, afterAll } from 'vitest';
import { RouterProvider, Routes, Suspense, createMemoryHistory, createResource, createRouter, h, useHead, useLoader } from 'azerothjs';
import type { LoaderHandoff } from 'azerothjs';
import { resetHead } from 'azerothjs/internal';
import { App } from '@azerothjs/http';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHELL = '<!doctype html><html><head><title>Shell Title</title></head><body><div id="root"></div></body></html>';
const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

function serve(routes: PageRoute[], app: (props: { url?: string; handoff?: LoaderHandoff }) => HTMLElement): App
{
    const dir = mkdtempSync(join(tmpdir(), 'az-stream-head-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    dirs.push(dir);
    const server = new App();
    mountPages(server, { routes, clientDir: dir, renderer: createPageRenderer(app, routes) });
    return server;
}

function routedApp(routes: PageRoute[]): (props: { url?: string; handoff?: LoaderHandoff }) => HTMLElement
{
    return (props) => RouterProvider({
        router: createRouter({
            routes,
            history: createMemoryHistory(props.url ?? '/'),
            initialLoaderData: props.handoff
        }),
        children: () => Routes({ fallback: () => h('h1', {}, 'not found') })
    }) as HTMLElement;
}

async function readAll(response: Response): Promise<string>
{
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let out = '';
    for (;;)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            break;
        }
        out += decoder.decode(value, { stream: true });
    }
    return out;
}

describe('a streamed page head', () =>
{
    it('carries facts the route LOADER resolved, because those exist before the flush', async () =>
    {
        resetHead();
        let release!: (value: string) => void;
        const pending = new Promise<string>((resolve) =>
        {
            release = resolve;
        });

        const Page = (): HTMLElement =>
        {
            const loaded = useLoader() as { data: () => { name: string } | undefined };
            const name = loaded.data()?.name ?? 'MISSING';
            useHead({
                title: `Profile ${ name }`,
                meta: [{ name: 'description', content: `about ${ name }` }],
                links: [{ rel: 'canonical', href: `https://example.test/${ name }` }]
            });
            const late = createResource<string>(() => pending);
            return h('main', {},
                Suspense({
                    fallback: () => h('p', {}, 'wait'),
                    on: [late],
                    children: () => h('article', {}, () => late.data() ?? '')
                }));
        };

        const routes: PageRoute[] = [{ path: '/live', component: Page, render: 'stream', loader: async () => ({ name: 'ada' }) }];
        const response = await serve(routes, routedApp(routes)).handle(new Request('http://local/live'));
        release('LATE');
        const out = await readAll(response);

        const head = out.slice(0, out.indexOf('</head>'));
        // In the HEAD, not merely somewhere in the document: a meta a crawler finds in the body
        // is not a meta it honours.
        expect(head).toContain('>Profile ada</title>');
        expect(head).toContain('content="about ada"');
        expect(head).toContain('https://example.test/ada');
        // The name proves the LOADER reached the declaration. Without it this arm would pass on
        // any static string and prove nothing about data-derived SEO facts.
        expect(head).not.toContain('MISSING');
    });

    it('cannot carry a fact declared inside a CONTINUATION, and says so rather than dropping it silently', async () =>
    {
        resetHead();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            let release!: (value: string) => void;
            const pending = new Promise<string>((resolve) =>
            {
                release = resolve;
            });

            const Page = (): HTMLElement =>
            {
                useHead({ title: 'Shell-time Title' });
                const late = createResource<string>(() => pending);
                return h('main', {},
                    Suspense({
                        fallback: () => h('p', {}, 'wait'),
                        on: [late],
                        children: (): HTMLElement =>
                        {
                            useHead({ title: 'Too Late', meta: [{ name: 'description', content: 'deferred description' }] });
                            return h('article', {}, () => late.data() ?? '');
                        }
                    }));
            };

            const routes: PageRoute[] = [{ path: '/live', component: Page, render: 'stream' }];
            const response = await serve(routes, routedApp(routes)).handle(new Request('http://local/live'));
            release('LATE CONTENT');
            const out = await readAll(response);

            // The continuation's CONTENT streams, so this is a head-lifetime limit rather than a
            // broken boundary - and that distinction is the whole point of the arm.
            expect(out).toContain('LATE CONTENT');
            expect(out).not.toContain('Too Late');
            expect(out).not.toContain('deferred description');
            // The main pass's own head is untouched by the continuation being dropped.
            expect(out.slice(0, out.indexOf('</head>'))).toContain('>Shell-time Title</title>');

            // Diagnosed, with the remedy named. A silent drop is what would make this the SEO
            // failure that ships: the client applier still runs the same declaration after
            // hydration, so the page looks right in exactly the place a developer checks it.
            const said = warn.mock.calls.map((call) => String(call[0])).join('\n');
            expect(said).toMatch(/could not reach this response's document head/);
            expect(said).toMatch(/streamed Suspense continuation/);
        }
        finally
        {
            warn.mockRestore();
        }
    });
});
