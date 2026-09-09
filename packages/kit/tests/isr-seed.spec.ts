// @vitest-environment node
//
// The prerendered seed is a FILE the build wrote, found under the client dir by the same
// containment rule the asset handler applies. The seed lookup used to check a string prefix
// only, so a junction inside the dist pointing outside it seeded the cache with a file the
// build never wrote - served from the cache, at 200, to everyone.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { App } from '@azerothjs/http';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import type { PageResult } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';
const component = (): HTMLElement => (undefined as unknown as HTMLElement);

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

function scratch(): string
{
    const base = mkdtempSync(join(tmpdir(), 'az-isr-seed-'));
    dirs.push(base);
    return base;
}

function mount(clientDir: string, routes: PageRoute[]): { app: App; calls: () => number }
{
    let count = 0;
    const app = new App();
    mountPages(app, {
        routes,
        clientDir,
        renderer: (url: string): Promise<PageResult> =>
        {
            count++;
            return Promise.resolve({ kind: 'html', status: 200, html: `<html><body>RENDERED:${ url }</body></html>` });
        },
        onError: () => undefined
    });
    return { app, calls: () => count };
}

const fetch = (app: App, path: string): Promise<Response> => app.handle(new Request(`http://local${ path }`));

describe('the prerendered seed stays inside the dist', () =>
{
    it('a dist reached through a junction still seeds (real root against real file)', async () =>
    {
        const base = scratch();
        const dist = join(base, 'dist');
        mkdirSync(join(dist, 'about'), { recursive: true });
        writeFileSync(join(dist, 'index.html'), SHELL);
        writeFileSync(join(dist, 'about', 'index.html'), '<html><body>SEEDED</body></html>');
        const alias = join(base, 'alias');
        symlinkSync(dist, alias, 'junction');

        const rig = mount(alias, [{ path: '/about', component, render: 'static', revalidate: 60 }]);
        const response = await fetch(rig.app, '/about');
        expect(response.headers.get('x-azeroth-cache')).toBe('hit');
        expect(await response.text()).toContain('SEEDED');
        expect(rig.calls()).toBe(0);
    });

    it('a junction INSIDE the dist that points outside it seeds nothing: the page renders live', async () =>
    {
        const base = scratch();
        const dist = join(base, 'dist');
        mkdirSync(dist, { recursive: true });
        writeFileSync(join(dist, 'index.html'), SHELL);
        const outside = join(base, 'outside');
        mkdirSync(outside);
        writeFileSync(join(outside, 'index.html'), '<html><body>LEAKED</body></html>');
        // The build never wrote dist/about; something else planted a junction there.
        symlinkSync(outside, join(dist, 'about'), 'junction');

        const rig = mount(dist, [{ path: '/about', component, render: 'static', revalidate: 60 }]);
        const response = await fetch(rig.app, '/about');
        expect(response.headers.get('x-azeroth-cache')).toBe('miss');
        const body = await response.text();
        expect(body).toContain('RENDERED:/about');
        expect(body).not.toContain('LEAKED');
        expect(rig.calls()).toBe(1);
    });
});
