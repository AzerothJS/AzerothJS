// @vitest-environment node
//
// `mountPages` with no built client: the dev session hands over the shell TEXT instead of a
// directory, so nothing is read from disk - no assets, no prerendered files, no images and no
// page cache. What survives is pinned here (every mode-conditioned mount error, every locale
// redirect, the live render for a page production would serve as a file), and so is every
// divergence the design lists.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { RouterProvider, Routes, createMemoryHistory, createRouter, forbidden, h, useLoader } from 'azerothjs';
import type { GuardVerdict, LoaderHandoff } from 'azerothjs';
import { App } from '@azerothjs/http';
import { mountPages, type KitOptions, type PageCache, type PageRoute } from '@azerothjs/kit';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import type { PageRenderer } from '@azerothjs/kit/ssr';
import * as kitBySource from '../src/index.ts';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';

/** What a browser sends navigating, and what a module fetch or an image sends. */
const NAVIGATE = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const ASSET = '*/*';

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A production client on disk, for the arms that compare the two mounts. */
function clientDir(): string
{
    const dir = mkdtempSync(join(tmpdir(), 'az-shell-mode-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    dirs.push(dir);
    return dir;
}

const Value = (): HTMLElement =>
{
    const data = useLoader<string>();
    return h('main', { id: 'value' }, () => data.data() ?? '');
};

const Plain = (): HTMLElement => h('main', { id: 'plain' }, 'plain');

function rendererFor(routes: PageRoute[]): PageRenderer
{
    const view = (props: { url?: string; handoff?: LoaderHandoff }): HTMLElement =>
        RouterProvider({
            router: createRouter({ routes, history: createMemoryHistory(props.url ?? '/'), initialLoaderData: props.handoff }),
            children: () => Routes({ fallback: () => h('h1', { id: 'missing' }, 'NOT FOUND') })
        }) as HTMLElement;
    return createPageRenderer(view, routes);
}

type Extra = Partial<Omit<KitOptions, 'clientDir' | 'shell'>>;

function shellMount(routes: PageRoute[], extra: Extra = {}): App
{
    const app = new App();
    mountPages(app, { routes, shell: SHELL, ...extra });
    return app;
}

function clientMount(routes: PageRoute[], extra: Extra = {}): App
{
    const app = new App();
    mountPages(app, { routes, clientDir: clientDir(), ...extra });
    return app;
}

/** The message a mount that must refuse threw, or a failure saying it did not refuse. */
function mountError(build: () => App): string
{
    try
    {
        build();
    }
    catch (error)
    {
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error('the mount was expected to throw and did not');
}

const get = (app: App, path: string, headers: Record<string, string> = {}): Promise<Response> =>
    app.handle(new Request(`http://local${ path }`, { headers }));

const body = async (app: App, path: string, headers: Record<string, string> = {}): Promise<string> =>
    (await get(app, path, headers)).text();

describe('gate: the spec binds what the mount binds', () =>
{
    it('@azerothjs/kit by name is the module this repository builds it from', () =>
    {
        // Every arm below mounts through the name. If the alias ever stopped pointing at src,
        // they would pin the built package instead of the code this unit changes.
        expect(mountPages).toBe(kitBySource.mountPages);
    });
});

describe('a page mounted over the shell text renders live', () =>
{
    it("a 'static' page with revalidate mounts and renders on every request", async () =>
    {
        // In production this is ISR: one render, then the cache. With no client dist there is
        // nothing to seed from and nothing to cache into, so every request is its own render.
        let hits = 0;
        const routes: PageRoute[] = [{
            path: '/pricing',
            component: Value,
            render: 'static',
            revalidate: 60,
            loader: () => Promise.resolve(`v${ ++hits }`)
        }];
        const app = shellMount(routes, { renderer: rendererFor(routes) });

        expect(await body(app, '/pricing')).toContain('v1');
        expect(await body(app, '/pricing')).toContain('v2');
    });

    it("a locale-prefixed 'static' page keeps its redirect", async () =>
    {
        const routes: PageRoute[] = [{
            path: '/about',
            component: Value,
            render: 'static',
            loader: () => Promise.resolve('about')
        }];
        const app = shellMount(routes, {
            renderer: rendererFor(routes),
            locales: { supported: ['en', 'fa'], routing: 'prefix' }
        });

        const bare = await get(app, '/about', { 'accept-language': 'fa' });
        expect(bare.status).toBe(302);
        expect(bare.headers.get('location')).toBe('/fa/about');

        const prefixed = await get(app, '/fa/about');
        expect(prefixed.status).toBe(200);
        const html = await prefixed.text();
        expect(html).toContain('about');
        expect(html).toContain('lang="fa"');
    });

    it('a plain, an enumerated and a localized static page all render live with a renderer', async () =>
    {
        const plain: PageRoute[] = [{ path: '/', component: Value, render: 'static', loader: () => Promise.resolve('home') }];
        expect(await body(shellMount(plain, { renderer: rendererFor(plain) }), '/')).toContain('home');

        // The enumeration names one param set in production and writes a file for it; with no
        // dist, the listed set and an unlisted one take the same live path.
        const enumerated: PageRoute[] = [{
            path: '/docs/:slug',
            component: Value,
            render: 'static',
            staticParams: () => Promise.resolve([{ slug: 'intro' }]),
            loader: ({ params }) => Promise.resolve(`doc:${ params.slug ?? '' }`)
        }];
        const docs = shellMount(enumerated, { renderer: rendererFor(enumerated) });
        expect(await body(docs, '/docs/intro')).toContain('doc:intro');
        expect(await body(docs, '/docs/unlisted')).toContain('doc:unlisted');

        const localized: PageRoute[] = [{ path: '/about', component: Value, render: 'static', loader: () => Promise.resolve('about') }];
        const site = shellMount(localized, { renderer: rendererFor(localized), locales: { supported: ['en', 'fa'] } });
        const persian = await get(site, '/about', { 'accept-language': 'fa' });
        expect(persian.status).toBe(200);
        const html = await persian.text();
        expect(html).toContain('about');
        expect(html).toContain('lang="fa"');
    });

    it('the same three pages answer the shell itself when there is no renderer', async () =>
    {
        const plain: PageRoute[] = [{ path: '/', component: Plain, render: 'static' }];
        const home = await get(shellMount(plain), '/');
        expect(home.status).toBe(200);
        expect(await home.text()).toBe(SHELL);

        const enumerated: PageRoute[] = [{
            path: '/docs/:slug',
            component: Plain,
            render: 'static',
            staticParams: () => Promise.resolve([{ slug: 'intro' }])
        }];
        const doc = await get(shellMount(enumerated), '/docs/intro');
        expect(doc.status).toBe(200);
        expect(await doc.text()).toBe(SHELL);

        const localized: PageRoute[] = [{ path: '/about', component: Plain, render: 'static' }];
        const about = await get(shellMount(localized, { locales: { supported: ['en', 'fa'] } }), '/about', { 'accept-language': 'fa' });
        expect(about.status).toBe(200);
        // The shell, with the one thing the host decided about it: this reader's language.
        const served = await about.text();
        expect(served).toContain('<div id="root"></div>');
        expect(served).toContain('lang="fa"');
    });
});

describe('the shell mount refuses exactly what a client mount refuses', () =>
{
    it("a 'static' page under a guarded chain throws the same mount error either way", () =>
    {
        const guard = (): GuardVerdict => forbidden();
        const table = (): PageRoute[] => [{ path: '/admin', component: Plain, render: 'static', guard }];

        const underShell = mountError(() => shellMount(table()));
        expect(underShell).toBe(mountError(() => clientMount(table())));
        expect(underShell).toContain('is guarded at "/admin"');
    });

    it("a 'static' page with an action throws the same mount error either way", () =>
    {
        const table = (): PageRoute[] => [{
            path: '/contact',
            component: Plain,
            render: 'static',
            action: () => Promise.resolve(undefined)
        }];

        const underShell = mountError(() => shellMount(table()));
        expect(underShell).toBe(mountError(() => clientMount(table())));
        expect(underShell).toContain('declares an action');
    });

    it('images needs a built client', () =>
    {
        expect(() => shellMount([{ path: '/', component: Plain }], { images: true }))
            .toThrow('images needs a built client - omit it under shell and register /_image on the server');
    });

    it('neither clientDir nor shell, or both at once, is a mount-time throw naming both keys', () =>
    {
        const routes: PageRoute[] = [{ path: '/', component: Plain }];
        const dir = clientDir();

        // An untyped caller reaches the mount, and hears which key is missing rather than an
        // ENOENT for a directory named `undefined`.
        const neither = mountError(() =>
        {
            const app = new App();
            mountPages(app, { routes } as unknown as KitOptions);
            return app;
        });
        expect(neither).toContain('clientDir');
        expect(neither).toContain('shell');
        expect(neither).toContain('neither');

        const both = mountError(() =>
        {
            const app = new App();
            mountPages(app, { routes, clientDir: dir, shell: SHELL } as unknown as KitOptions);
            return app;
        });
        expect(both).toContain('clientDir');
        expect(both).toContain('shell');
        expect(both).toContain('both');

        // A typed caller cannot write either one: these two lines fail `npm run typecheck` the
        // moment the union stops refusing them.
        // @ts-expect-error a mount with neither clientDir nor shell does not typecheck
        expect(() => mountPages(new App(), { routes })).toThrow('exactly one of clientDir');
        // @ts-expect-error a mount with both clientDir and shell does not typecheck
        expect(() => mountPages(new App(), { routes, clientDir: dir, shell: SHELL })).toThrow('exactly one of clientDir');
    });
});

describe('what the shell mount does not serve', () =>
{
    it("/index.html answers the app's 404", async () =>
    {
        const routes: PageRoute[] = [{ path: '/', component: Plain }];
        const app = shellMount(routes, { renderer: rendererFor(routes) });

        const response = await get(app, '/index.html', { accept: NAVIGATE });
        expect(response.status).toBe(404);
        expect(await response.text()).toContain('NOT FOUND');
    });

    it("an unrouted navigation gets the app's 404 page, a non-document request the kernel's", async () =>
    {
        const routes: PageRoute[] = [{ path: '/', component: Plain }];
        const app = shellMount(routes, { renderer: rendererFor(routes) });

        const navigation = await get(app, '/nowhere', { accept: NAVIGATE });
        expect(navigation.status).toBe(404);
        expect(navigation.headers.get('content-type')).toContain('text/html');
        expect(await navigation.text()).toContain('NOT FOUND');

        // Nothing on disk to miss, so a module fetch or an image is simply not found.
        const asset = await get(app, '/assets/app.js', { accept: ASSET });
        expect(asset.status).toBe(404);
        expect(asset.headers.get('content-type')).toContain('application/json');
        expect((await asset.json() as { error: { code: string } }).error.code).toBe('not-found');
    });

    it('an actionless page answers a POST with the same Allow a client mount answers', async () =>
    {
        const routes: PageRoute[] = [{ path: '/about', component: Plain, render: 'server' }];
        const both = [shellMount(routes, { renderer: rendererFor(routes) }), clientMount(routes, { renderer: rendererFor(routes) })];

        for (const app of both)
        {
            const response = await app.handle(new Request('http://local/about', { method: 'POST' }));
            expect(response.status).toBe(405);
            expect(response.headers.get('allow')).toBe('GET, HEAD');
        }
    });

    it('Regression: a shell mount writes the page cache it was given', async () =>
    {
        const writes: string[] = [];
        const cache: PageCache = {
            get: () => Promise.resolve(undefined),
            set: (key) =>
            {
                writes.push(key);
                return Promise.resolve();
            },
            delete: () => Promise.resolve()
        };
        const routes: PageRoute[] = [{
            path: '/pricing',
            component: Value,
            render: 'static',
            revalidate: 60,
            loader: () => Promise.resolve('priced')
        }];
        const app = shellMount(routes, { renderer: rendererFor(routes), cache });

        expect(await body(app, '/pricing')).toContain('priced');
        expect(await body(app, '/pricing')).toContain('priced');
        expect(writes).toEqual([]);
    });
});
