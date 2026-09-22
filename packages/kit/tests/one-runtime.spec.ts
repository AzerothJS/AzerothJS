// @vitest-environment node
//
// One server process renders on one evaluation of azerothjs. A renderer carries the runtime it
// renders on, compiled code marks the runtime it bound to, and the kit's entry points refuse a
// renderer or an entry from another evaluation before the first request is served.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { h } from 'azerothjs';
import { RUNTIME_CONTRACT_VERSION, assertRuntimeContract } from 'azerothjs/internal';
import { App } from '@azerothjs/http';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import { prerender } from '@azerothjs/kit/prerender';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import type { PageRenderer, PageResult } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';
const NAVIGATE = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

const component = (): HTMLElement => (undefined as unknown as HTMLElement);
const routes: PageRoute[] = [{ path: '/', component, render: 'static' }];

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

// A fresh evaluation clears the global mark, so no arm leaves another copy bound for the next file.
afterEach(async () =>
{
    vi.resetModules();
    await import('azerothjs/internal');
});

function clientDir(): string
{
    const dir = mkdtempSync(join(tmpdir(), 'az-one-runtime-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    dirs.push(dir);
    return dir;
}

/** The runtime and the kit as a second evaluation of every module, like an inlined SSR bundle. */
interface Copy
{
    runtime: typeof import('azerothjs');
    internal: typeof import('azerothjs/internal');
    http: typeof import('@azerothjs/http');
    kit: typeof import('@azerothjs/kit');
    ssr: typeof import('@azerothjs/kit/ssr');
}

async function evaluate(): Promise<Copy>
{
    vi.resetModules();
    return {
        runtime: await import('azerothjs'),
        internal: await import('azerothjs/internal'),
        http: await import('@azerothjs/http'),
        kit: await import('@azerothjs/kit'),
        ssr: await import('@azerothjs/kit/ssr')
    };
}

/** A renderer from one copy's kit, over a page drawn with that copy's `h`. */
function rendererOn(make: typeof createPageRenderer, draw: typeof h, text: string): PageRenderer
{
    return make(() => draw('main', { id: 'page' }, text), routes);
}

async function page(app: { handle: (request: Request) => Promise<Response> }): Promise<{ status: number; body: string }>
{
    const response = await app.handle(new Request('http://local.test/', { headers: { accept: NAVIGATE } }));
    return { status: response.status, body: await response.text() };
}

describe('a renderer from another evaluation of azerothjs is refused', () =>
{
    it('a re-import after resetting the module registry is a second evaluation', async () =>
    {
        const two = await evaluate();

        expect(two.internal.assertRuntimeContract).not.toBe(assertRuntimeContract);
        expect(two.ssr.createPageRenderer).not.toBe(createPageRenderer);
        expect(two.kit.mountPages).not.toBe(mountPages);
        expect(two.http.App).not.toBe(App);
    });

    it('compiled code on the host copy passes createPageRenderer, mountPages and prerender', async () =>
    {
        assertRuntimeContract(RUNTIME_CONTRACT_VERSION);
        const renderer = rendererOn(createPageRenderer, h, 'ONE');
        const app = new App();
        mountPages(app, { routes, shell: SHELL, renderer });

        const served = await page(app);
        expect(served.status).toBe(200);
        expect(served.body).toContain('ONE');
        expect(await prerender({ routes, clientDir: clientDir(), renderer })).toEqual(['/']);
    });

    it('createPageRenderer refuses when the compiled code bound to another copy', async () =>
    {
        const two = await evaluate();
        two.internal.assertRuntimeContract(RUNTIME_CONTRACT_VERSION);

        expect(() => rendererOn(createPageRenderer, h, 'ONE')).toThrow(/^kit createPageRenderer: a second copy of azerothjs/);
    });

    it('mountPages refuses a renderer made on another copy', async () =>
    {
        const two = await evaluate();
        two.internal.assertRuntimeContract(RUNTIME_CONTRACT_VERSION);
        const renderer = rendererOn(two.ssr.createPageRenderer, two.runtime.h, 'TWO');

        expect(() => mountPages(new App(), { routes, shell: SHELL, renderer }))
            .toThrow(/^kit mountPages: a second copy of azerothjs[\s\S]*external: \['azerothjs'\]/);
    });

    it('prerender refuses a renderer made on another copy', async () =>
    {
        const two = await evaluate();
        two.internal.assertRuntimeContract(RUNTIME_CONTRACT_VERSION);
        const renderer = rendererOn(two.ssr.createPageRenderer, two.runtime.h, 'TWO');

        await expect(prerender({ routes, clientDir: clientDir(), renderer }))
            .rejects.toThrow(/^kit prerender: a second copy of azerothjs/);
    });

    it('a hand-written renderer carries no mark, so it mounts and prerenders unchecked', async () =>
    {
        assertRuntimeContract(RUNTIME_CONTRACT_VERSION);
        const renderer = (_url: string, shell: string): Promise<PageResult> =>
            Promise.resolve({ kind: 'html', status: 200, html: shell.replace('<div id="root"></div>', '<div id="root">PLAIN</div>') });
        const app = new App();
        mountPages(app, { routes, shell: SHELL, renderer });

        const served = await page(app);
        expect(served.status).toBe(200);
        expect(served.body).toContain('PLAIN');
        expect(await prerender({ routes, clientDir: clientDir(), renderer })).toEqual(['/']);
    });

    it('a fresh evaluation starts unbound, so a mark left by an earlier one does not refuse it', async () =>
    {
        assertRuntimeContract(RUNTIME_CONTRACT_VERSION);
        const fresh = await evaluate();
        const renderer = rendererOn(fresh.ssr.createPageRenderer, fresh.runtime.h, 'FRESH');
        const app = new fresh.http.App();
        fresh.kit.mountPages(app, { routes, shell: SHELL, renderer });

        const served = await page(app);
        expect(served.status).toBe(200);
        expect(served.body).toContain('FRESH');
    });

    it('mountPages refuses by the renderer\'s mark even after a later evaluation clears the slot', async () =>
    {
        const two = await evaluate();
        two.internal.assertRuntimeContract(RUNTIME_CONTRACT_VERSION);
        const renderer = rendererOn(two.ssr.createPageRenderer, two.runtime.h, 'TWO');
        const host = await evaluate();

        expect(() => host.kit.mountPages(new host.http.App(), { routes, shell: SHELL, renderer }))
            .toThrow(/^kit mountPages: a second copy of azerothjs/);
    });
});
