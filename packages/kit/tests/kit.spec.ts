// @vitest-environment node
//
// The kit's production behaviors, driven the framework way: a real @azerothjs/http
// App via app.handle, a real temp client dist on disk, and a fake renderer where
// the SSR bundle would sit - so every mode (server/static/client), the 302 path,
// asset fallback, and the prerender pass are proven without a browser.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { App, json } from '@azerothjs/http';
import { flattenPages, mountPages, prerenderFileFor, type PageRoute } from '@azerothjs/kit';
import { prerender } from '@azerothjs/kit/prerender';
import type { PageResult } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>';

function makeClientDir(): string
{
    const dir = mkdtempSync(join(tmpdir(), 'az-kit-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    return dir;
}

const component = (): HTMLElement => (undefined as unknown as HTMLElement); // never rendered here

const fakeRenderer = (url: string, shell: string): Promise<PageResult> =>
{
    if (url.startsWith('/locked'))
    {
        return Promise.resolve({ kind: 'redirect', to: '/login', replace: true });
    }
    if (url.startsWith('/forbidden'))
    {
        return Promise.resolve({ kind: 'blocked', status: 403 });
    }
    return Promise.resolve({ kind: 'html', status: 200, html: shell.replace('<div id="root"></div>', `<div id="root">SSR:${ url }</div>`) });
};

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('flattenPages / prerenderFileFor', () =>
{
    it('flattens nesting to absolute paths, inheriting render modes downward', () =>
    {
        const routes: PageRoute[] = [
            { path: '/', component, render: 'static' },
            {
                path: '/docs', component, render: 'static',
                children: [{ path: 'intro', component }, { path: 'live', component, render: 'server' }]
            }
        ];
        expect(flattenPages(routes)).toEqual([
            { path: '/', render: 'static' },
            { path: '/docs/intro', render: 'static' },
            { path: '/docs/live', render: 'server' }
        ]);
        expect(prerenderFileFor('/')).toBe('index.html');
        expect(prerenderFileFor('/docs/intro')).toBe('docs/intro/index.html');
    });
});

describe('mountPages', () =>
{
    function build(routes: PageRoute[], withRenderer: boolean): { app: App; dir: string }
    {
        const dir = makeClientDir();
        dirs.push(dir);
        const app = new App();
        app.get('/api/ping', () => json({ ok: true }));
        mountPages(app, { routes, clientDir: dir, ...(withRenderer ? { renderer: fakeRenderer } : {}) });
        return { app, dir };
    }
    const fetch = (app: App, path: string): Promise<Response> => app.handle(new Request(`http://local${ path }`));

    it("render: 'server' SSRs per request through the renderer, shell assets intact", async () =>
    {
        const { app } = build([{ path: '/', component }], true);
        const response = await fetch(app, '/');
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain('SSR:/');
        expect(html).toContain('/assets/app.js'); // the built shell's tags survive
    });

    it('a guard/loader redirect becomes a REAL 302, never a rendered page', async () =>
    {
        const { app } = build([{ path: '/locked', component }], true);
        const response = await fetch(app, '/locked');
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('/login');
    });

    it('a guard VETO serves the status with the pristine shell, never the rendered component', async () =>
    {
        const { app } = build([{ path: '/forbidden', component }], true);
        const response = await fetch(app, '/forbidden');
        expect(response.status).toBe(403);
        const body = await response.text();
        expect(body).toContain('<div id="root"></div>'); // empty root - nothing protected rendered
        expect(body).not.toContain('SSR:'); // the component was never rendered
    });

    it("render: 'client' serves the pristine shell; API routes registered before keep priority", async () =>
    {
        const { app } = build([{ path: '/spa', component, render: 'client' }], true);
        const shellPage = await (await fetch(app, '/spa')).text();
        expect(shellPage).toContain('<div id="root"></div>'); // empty root: the browser renders
        expect(((await (await fetch(app, '/api/ping')).json()) as { ok: boolean }).ok).toBe(true);
    });

    it("render: 'static' serves the prerendered file; assets fall through; misses 404", async () =>
    {
        const routes: PageRoute[] = [{ path: '/about', component, render: 'static' }];
        const { app, dir } = build(routes, true);
        mkdirSync(join(dir, 'about'));
        writeFileSync(join(dir, 'about', 'index.html'), '<html><body>PRERENDERED</body></html>');

        expect(await (await fetch(app, '/about')).text()).toContain('PRERENDERED');
        expect((await fetch(app, '/assets/app.js')).status).toBe(200);
        expect((await fetch(app, '/assets/nope.js')).status).toBe(404);
    });

    it('a parameterized page SSRs per request even under an inherited static mode', async () =>
    {
        const { app } = build([{ path: '/users/:id', component, render: 'static' }], true);
        const html = await (await fetch(app, '/users/42')).text();
        expect(html).toContain('SSR:/users/42');
    });

    // The shell promise is created at mount and awaited per REQUEST, so its rejection had no
    // handler in the turn it happened and node's default policy killed the process: a wrong
    // CLIENT_DIR in a container was a crash loop reporting a bare ENOENT.
    it('a clientDir with no shell fails the request with a kit error, never an unhandled rejection', async () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'az-kit-noshell-'));
        dirs.push(dir);
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void =>
        {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);
        try
        {
            const observed: unknown[] = [];
            const app = new App({ onError: (error) => void observed.push(error) });
            mountPages(app, { routes: [{ path: '/', component }], clientDir: dir, renderer: fakeRenderer });
            // Two macrotask turns: long past the turn the readFile rejection settles in.
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(unhandled).toEqual([]);

            const response = await fetch(app, '/');
            expect(response.status).toBe(500);
            expect(String((observed[0] as Error | undefined)?.message)).toContain('kit mountPages: no client shell');
            expect(String((observed[0] as Error | undefined)?.message)).toContain(dir);
        }
        finally
        {
            process.off('unhandledRejection', onUnhandled);
        }
    });
});

describe('prerender', () =>
{
    it('writes every static page over the shell, preserves shell.html, reports paths', async () =>
    {
        const dir = makeClientDir();
        dirs.push(dir);
        const routes: PageRoute[] = [
            { path: '/', component, render: 'static' },
            { path: '/about', component, render: 'static' },
            { path: '/app', component, render: 'client' }
        ];
        const written = await prerender({ routes, clientDir: dir, renderer: fakeRenderer });
        expect(written).toEqual(['/', '/about']);
        expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('SSR:/');
        expect(readFileSync(join(dir, 'about', 'index.html'), 'utf8')).toContain('SSR:/about');
        expect(readFileSync(join(dir, 'shell.html'), 'utf8')).toContain('<div id="root"></div>'); // pristine
        expect(existsSync(join(dir, 'app', 'index.html'))).toBe(false); // client pages are not written
    });

    it('a redirecting static page is a loud BUILD error, and so is a parameterized one', async () =>
    {
        const dir = makeClientDir();
        dirs.push(dir);
        await expect(prerender({
            routes: [{ path: '/locked', component, render: 'static' }],
            clientDir: dir,
            renderer: fakeRenderer
        })).rejects.toThrow(/cannot redirect/);
        await expect(prerender({
            routes: [{ path: '/users/:id', component, render: 'static' }],
            clientDir: dir,
            renderer: fakeRenderer
        })).rejects.toThrow(/parameters/);
    });

    // Unchecked, `..` in a route path escapes the build output entirely: the write lands
    // two levels above dist, in whatever the parent directory happens to be.
    it('a route path that resolves outside the client dir is a BUILD error, not a write', async () =>
    {
        const dir = makeClientDir();
        dirs.push(dir);
        await expect(prerender({
            routes: [{ path: '/../../ESCAPED-PRERENDER', component, render: 'static' }],
            clientDir: dir,
            renderer: fakeRenderer
        })).rejects.toThrow(/outside the client dir/);
        expect(existsSync(join(dir, '..', '..', 'ESCAPED-PRERENDER'))).toBe(false);
    });
});
