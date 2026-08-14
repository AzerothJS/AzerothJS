// @vitest-environment node
//
// The kit half of the head runtime: shell surgery (title content-only replacement with
// the base stamp, keyed meta/canonical replacement, media-aware identity against the
// scaffold's paired theme-colors, $-pattern survival, malformed-shell degradation), the
// buffered success-path collect, the streamed sync-pass head with the normalized splice
// order, the continuation discard, and the CSP nonce on JSON-LD.
import { describe, it, expect, vi } from 'vitest';
import { Suspense, createResource, h, useHead, renderToString, renderToStream } from 'azerothjs';
import { resetHead, collectHead } from 'azerothjs/internal';
import { App } from '@azerothjs/http';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import { createPageRenderer, applyHeadToShell } from '@azerothjs/kit/ssr';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHELL = '<!doctype html><html><head>'
    + '<title data-x="keep">Shell Title</title>'
    + '<meta name="description" content="shell description"/>'
    + '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fff"/>'
    + '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000"/>'
    + '<link rel="canonical" href="https://old.example/"/>'
    + '</head><body><div id="root"></div></body></html>';

const dirs: string[] = [];
function makeClientDir(shell = SHELL): string
{
    const dir = mkdtempSync(join(tmpdir(), 'az-head-'));
    writeFileSync(join(dir, 'index.html'), shell);
    mkdirSync(join(dir, 'assets'));
    return dir;
}
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});
import { afterAll } from 'vitest';

function collectedFor(input: Parameters<typeof useHead>[0], nonce?: string): ReturnType<typeof collectHead>
{
    resetHead();
    // Register through a real string-mode render so the frame path is the one exercised.
    renderToString(() =>
    {
        useHead(input);
        return h('div', {}, 'x');
    });
    return collectHead(nonce !== undefined ? { scriptNonce: nonce } : {});
}

describe('applyHeadToShell: the shell matrix', () =>
{
    it('replaces the title CONTENT only, preserves shell attributes, stamps the base', () =>
    {
        const html = applyHeadToShell(SHELL, collectedFor({ title: 'Runtime Title' }));
        expect(html).toContain('data-x="keep"');
        expect(html).toContain('data-azeroth-title-base="Shell Title"');
        expect(html).toContain('>Runtime Title</title>');
        expect(html).not.toContain('>Shell Title</title>');
        expect((html.match(/<title/g) ?? []).length).toBe(1);
    });

    it('replaces the shell description and canonical by key; no duplicates', () =>
    {
        const html = applyHeadToShell(SHELL, collectedFor({
            meta: [{ name: 'description', content: 'runtime description' }],
            links: [{ rel: 'canonical', href: 'https://new.example/page' }]
        }));
        expect((html.match(/name="description"/g) ?? []).length).toBe(1);
        expect(html).toContain('content="runtime description"');
        expect((html.match(/rel="canonical"/g) ?? []).length).toBe(1);
        expect(html).toContain('https://new.example/page');
        expect(html).not.toContain('https://old.example/');
    });

    it('media joins the meta identity: a dark theme-color replaces ONLY its own; both shell elements survive otherwise', () =>
    {
        const html = applyHeadToShell(SHELL, collectedFor({
            meta: [{ name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#111' }]
        }));
        expect((html.match(/name="theme-color"/g) ?? []).length).toBe(2);
        expect(html).toContain('content="#fff"');
        expect(html).toContain('#111');
        expect(html).not.toContain('content="#000"');

        // A runtime theme-color WITHOUT media matches neither shell element: appended.
        const appended = applyHeadToShell(SHELL, collectedFor({
            meta: [{ name: 'theme-color', content: '#222' }]
        }));
        expect((appended.match(/name="theme-color"/g) ?? []).length).toBe(3);
    });

    it('a shell with no title APPENDS the runtime-marked title element (no duplicate)', () =>
    {
        const bare = SHELL.replace(/<title[\s\S]*?<\/title>/, '');
        const html = applyHeadToShell(bare, collectedFor({ title: 'Only Runtime' }));
        expect((html.match(/<title/g) ?? []).length).toBe(1);
        expect(html).toContain('<title data-azeroth-head="title">Only Runtime</title>');
    });

    it('$-patterns in runtime content survive the surgery literally', () =>
    {
        const html = applyHeadToShell(SHELL, collectedFor({ title: "pay $& now $' or $$" }));
        expect(html).toContain("pay $&amp; now $' or $$");
        expect(html).not.toContain('<head><title data-x="keep"><head>');
    });

    it('a shell without </head> receives no head work and survives untouched', () =>
    {
        const headless = '<html><body><div id="root"></div></body></html>';
        const html = applyHeadToShell(headless, collectedFor({ title: 'X' }));
        expect(html).toBe(headless);
    });
});

describe('the kit seams', () =>
{
    function rig(routes: PageRoute[], app: (props: { url?: string }) => HTMLElement, nonce?: string): App
    {
        const dir = makeClientDir();
        dirs.push(dir);
        const server = new App();
        mountPages(server, {
            routes,
            clientDir: dir,
            renderer: createPageRenderer(app, routes),
            ...(nonce !== undefined ? { scriptNonce: () => nonce } : {})
        });
        return server;
    }

    it('BUFFERED success path: the rendered document carries the declared head', async () =>
    {
        resetHead();
        const routes: PageRoute[] = [{
            path: '/page',
            component: (): HTMLElement => h('div', {}, 'x'),
            render: 'server'
        }];
        const app = (): HTMLElement =>
        {
            useHead({ title: 'Buffered Page', meta: [{ name: 'description', content: 'from runtime' }] });
            return h('main', {}, 'content');
        };
        const server = rig(routes, app);
        const response = await server.handle(new Request('http://local/page'));
        const html = await response.text();

        expect(html).toContain('>Buffered Page</title>');
        expect(html).toContain('data-azeroth-title-base="Shell Title"');
        expect(html).toContain('content="from runtime"');
        expect((html.match(/name="description"/g) ?? []).length).toBe(1);
    });

    it('STREAMED: sync-pass declarations reach the FLUSHED head; order is style -> handoff -> head', async () =>
    {
        resetHead();
        let release!: (value: string) => void;
        const pending = new Promise<string>((resolve) =>
        {
            release = resolve;
        });
        const routes: PageRoute[] = [{
            path: '/live',
            component: (): HTMLElement => h('div', {}, 'x'),
            render: 'stream',
            loader: async () => ({ name: 'Loaded Name' })
        }];
        const app = (): HTMLElement =>
        {
            useHead({ title: 'Streamed Title', jsonLd: { '@type': 'Thing', name: 'stream' } });
            const data = createResource<string>(() => pending);
            return h('main', {},
                Suspense({ fallback: () => h('p', {}, 'wait'), on: [data], children: () => h('i', {}, () => data.data() ?? '') }));
        };
        const server = rig(routes, app, 'NONCE123');
        const response = await server.handle(new Request('http://local/live'));
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let seen = '';
        while (!seen.includes('</head>'))
        {
            const { done, value } = await reader.read();
            expect(done).toBe(false);
            seen += decoder.decode(value, { stream: true });
        }

        // The declared head is IN the flushed bytes, before any boundary settles.
        expect(seen).toContain('>Streamed Title</title>');
        const json = seen.indexOf('application/ld+json');
        const handoffAt = seen.indexOf('__azeroth-loader-handoff');
        expect(json).toBeGreaterThan(-1);
        expect(handoffAt).toBeGreaterThan(-1);
        // Normalized order: handoff before the head additions.
        expect(handoffAt).toBeLessThan(json);
        // CSP: the JSON-LD block carries the per-request nonce.
        expect(seen).toMatch(/<script type="application\/ld\+json"[^>]*nonce="NONCE123"/);

        release('late');
        // Drain to completion so the kit stream closes cleanly (no mid-settle cancel).
        for (;;)
        {
            const { done } = await reader.read();
            if (done)
            {
                break;
            }
        }
    });

    it('a CONTINUATION useHead is discarded with the diagnostic and never leaks into a later collect', async () =>
    {
        resetHead();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            let releaseA!: (value: string) => void;
            let releaseB!: (value: string) => void;
            const pendingA = new Promise<string>((resolve) =>
            {
                releaseA = resolve;
            });
            const pendingB = new Promise<string>((resolve) =>
            {
                releaseB = resolve;
            });
            const app = (): HTMLElement =>
            {
                const alpha = createResource<string>(() => pendingA);
                const beta = createResource<string>(() => pendingB);
                return h('main', {},
                    Suspense({
                        fallback: () => h('p', {}, 'waitA'),
                        on: [alpha],
                        children: () =>
                        {
                            useHead({ title: 'Too Late' });
                            return h('i', {}, () => alpha.data() ?? '');
                        }
                    }),
                    Suspense({
                        fallback: () => h('p', {}, 'waitB'),
                        on: [beta],
                        children: () => h('u', {}, () => beta.data() ?? '')
                    }));
            };
            const stream = renderToStream(() => app());
            collectHead();
            releaseA('alpha-late');
            const reader = stream.getReader();
            const decoder = new TextDecoder();
            let out = '';
            // Read until boundary A's continuation chunk lands. Boundary B is still
            // pending, so the stream has NOT finalized: this is the concurrency
            // window only the SYNCHRONOUS drive discard covers (the finalize backstop
            // has not run) - an INTERLEAVED request collecting here must see nothing.
            while (!out.includes('alpha-late'))
            {
                const { done, value } = await reader.read();
                if (done)
                {
                    break;
                }
                out += decoder.decode(value, { stream: true });
            }
            expect(out).toContain('alpha-late');
            renderToString(() => h('div', {}, 'interleaved'));
            const windowCollect = collectHead();
            expect(windowCollect.title).toBeNull();

            releaseB('beta-late');
            for (;;)
            {
                const { done, value } = await reader.read();
                if (done)
                {
                    break;
                }
                out += decoder.decode(value, { stream: true });
            }
            expect(out).toContain('beta-late');

            renderToString(() => h('div', {}, 'clean'));
            const next = collectHead();
            expect(next.title).toBeNull();
            expect(warn.mock.calls.some((c) => /could not reach this response/.test(String(c[0])))).toBe(true);
        }
        finally
        {
            warn.mockRestore();
        }
    });
});

describe('SSG, ISR, and the streamed pending-resource degradation', () =>
{
    it('a prerendered file contains the route\'s declared head', async () =>
    {
        resetHead();
        const { prerender } = await import('@azerothjs/kit/prerender');
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const dir = makeClientDir();
        dirs.push(dir);
        const routes: PageRoute[] = [{
            path: '/about',
            component: (): HTMLElement => h('div', {}, 'x'),
            render: 'static'
        }];
        const app = (): HTMLElement =>
        {
            useHead({ title: 'About Us', meta: [{ property: 'og:title', content: 'About Us' }] });
            return h('main', {}, 'about');
        };
        const written = await prerender({ routes, clientDir: dir, renderer: createPageRenderer(app, routes) });
        expect(written).toEqual(['/about']);
        const file = readFileSync(join(dir, 'about', 'index.html'), 'utf8');
        expect(file).toContain('>About Us</title>');
        expect(file).toContain('property="og:title"');
    });

    it('ISR revalidation regenerates a loader-derived title', async () =>
    {
        resetHead();
        let version = 0;
        const routes: PageRoute[] = [{
            path: '/doc',
            component: (): HTMLElement => h('div', {}, 'x'),
            render: 'static',
            revalidate: 0.01,
            loader: async () => `Doc v${ ++version }`
        }];
        const { useLoader, createRouter, createMemoryHistory, RouterProvider, Routes } = await import('azerothjs');
        const Doc = (): HTMLElement =>
        {
            const data = useLoader<string>();
            useHead({ title: () => data.data() ?? 'Doc' });
            return h('main', {}, 'doc');
        };
        routes[0]!.component = Doc;
        const app = (props: { url?: string; handoff?: never }): HTMLElement =>
        {
            const router = createRouter({ routes: routes, history: createMemoryHistory(props.url ?? '/'), initialLoaderData: props.handoff });
            return RouterProvider({ router, children: () => Routes({}) }) as HTMLElement;
        };
        const dir = makeClientDir();
        dirs.push(dir);
        const server = new App();
        const rigErrors: unknown[] = [];
        mountPages(server, { routes, clientDir: dir, renderer: createPageRenderer(app as never, routes), onError: (error) => void rigErrors.push(error) });

        const first = await server.handle(new Request('http://local/doc'));
        if (rigErrors.length > 0)
        {
            throw new Error('RIG: ' + String(rigErrors[0]));
        }
        expect(await first.text()).toContain('>Doc v1</title>');

        await new Promise((resolve) => setTimeout(resolve, 30));
        // Past the window: stale served, ONE background regeneration kicks off.
        const stale = await server.handle(new Request('http://local/doc'));
        expect(await stale.text()).toContain('>Doc v1</title>');
        await new Promise((resolve) => setTimeout(resolve, 30));

        const fresh = await server.handle(new Request('http://local/doc'));
        expect(await fresh.text()).toContain('>Doc v2</title>');
    });

    it('PINNED DEGRADATION: a main-pass useHead reading a PENDING resource snapshots the fallback into the flushed head', async () =>
    {
        resetHead();
        let release!: (value: string) => void;
        const pending = new Promise<string>((resolve) =>
        {
            release = resolve;
        });
        const app = (): HTMLElement =>
        {
            const data = createResource<string>(() => pending);
            // The getter reads a resource the main pass cannot settle: the flushed
            // head carries 'Loading' PERMANENTLY (SEO-critical facts belong in
            // loaders - the documented, contractual degradation).
            useHead({ title: () => data.data() ?? 'Loading' });
            return h('main', {},
                Suspense({ fallback: () => h('p', {}, 'wait'), on: [data], children: () => h('i', {}, () => data.data() ?? '') }));
        };
        const stream = renderToStream(() => app());
        const collected = collectHead();
        expect(collected.title).toBe('Loading');

        release('Late Name');
        const reader = stream.getReader();
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
        // The settled boundary streams its BODY chunk; the head fact stays the snapshot.
        expect(out).toContain('Late Name');
    });
});
