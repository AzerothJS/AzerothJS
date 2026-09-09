// @vitest-environment node
//
// A loader that throws BEFORE returning, driven through the real mount in every render mode.
// The throwing spelling used to escape the loader settle and leave the renderer as an ordinary
// throw, so the kernel answered its JSON envelope with no cache-control at all - a 500 a shared
// cache may store and replay - and the page's own error UI never rendered.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { App } from '@azerothjs/http';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import { RouterProvider, Routes, createMemoryHistory, createRouter, h, useLoader } from 'azerothjs';
import type { LoaderHandoff, MountNode } from 'azerothjs';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';

const INTERNALS = 'connect ECONNREFUSED 10.0.0.7:5432 (user=svc_orders password=hunter2)';

const Page = (): MountNode =>
{
    const item = useLoader<string>();
    return h('main', { id: 'page' }, () => (item.error() !== null ? 'THIS PAGE COULD NOT BE LOADED' : (item.data() ?? '')));
};

const boom = (): never =>
{
    throw new Error(INTERNALS);
};

const routes: PageRoute[] = [
    { path: '/server', component: Page, render: 'server', loader: boom },
    { path: '/stream', component: Page, render: 'stream', loader: boom },
    { path: '/static', component: Page, render: 'static', revalidate: 60, loader: boom }
];

const View = (props: { url?: string; handoff?: LoaderHandoff }): HTMLElement =>
    RouterProvider({
        router: createRouter({ routes, history: createMemoryHistory(props.url ?? '/'), initialLoaderData: props.handoff }),
        children: () => Routes({ fallback: () => h('h1', {}, 'not found') })
    }) as HTMLElement;

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

function serve(): { app: App; onError: ReturnType<typeof vi.fn> }
{
    const dir = mkdtempSync(join(tmpdir(), 'az-lthrow-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    dirs.push(dir);
    const onError = vi.fn();
    const app = new App();
    mountPages(app, { routes, clientDir: dir, renderer: createPageRenderer(View, routes), onError });
    return { app, onError };
}

const navigate = (app: App, path: string): Promise<Response> =>
    app.handle(new Request(`http://local${ path }`, { headers: { accept: 'text/html' } }));

describe('a loader that throws synchronously, through the real mount', () =>
{
    it.each([
        ['server', 'render'],
        ['stream', 'stream']
    ] as const)("render: '%s' answers the page's error UI at 500, never stored, and reports the cause", async (mode, phase) =>
    {
        const { app, onError } = serve();
        const response = await navigate(app, `/${ mode }`);
        expect(response.status).toBe(500);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.get('content-type')).toContain('text/html');
        const body = await response.text();
        expect(body).toContain('THIS PAGE COULD NOT BE LOADED');
        expect(body).not.toContain('hunter2');
        expect(onError).toHaveBeenCalledTimes(1);
        expect((onError.mock.calls[0]?.[0] as Error).message).toBe(INTERNALS);
        expect(onError.mock.calls[0]?.[1]).toEqual({ path: `/${ mode }`, phase });
    });

    // The ISR handler hands its renderer no observer, so the cause is asserted nowhere here:
    // the page's answer is the whole contract on this path.
    it("render: 'static' through the live path answers the page's error UI at 500, never stored", async () =>
    {
        const { app } = serve();
        const response = await navigate(app, '/static');
        expect(response.status).toBe(500);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        const body = await response.text();
        expect(body).toContain('THIS PAGE COULD NOT BE LOADED');
        expect(body).not.toContain('hunter2');
    });
});
