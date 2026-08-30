// @vitest-environment node
//
// A streamed page that fails AFTER the shell has flushed cannot change its status - the head
// left with a 200 - so the failure has to be reported out of band or it reaches nobody. It used
// to reach nobody: `renderToStream` reports a boundary rejection through its `onError`, and kit
// constructed it without one, so the client got a page missing a boundary and the server
// recorded a clean 200. That is the one shape no observability seam can see.
//
// This pins the wiring rather than the renderer's own behaviour, which azerothjs already tests.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { App } from '@azerothjs/http';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import type { PageRenderOptions, PageResult } from '@azerothjs/kit/ssr';

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

interface Seen
{
    phase: string;
    path: string;
    message: string;
}

function rig(): { app: App; seen: Seen[]; captured: () => PageRenderOptions | undefined }
{
    const dir = mkdtempSync(join(tmpdir(), 'az-streamfault-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), SHELL);

    const seen: Seen[] = [];
    let captured: PageRenderOptions | undefined;
    const app = new App();
    const routes: PageRoute[] = [{ path: '/live', component, render: 'stream' }];
    mountPages(app, {
        routes,
        clientDir: dir,
        renderer: (_url, _shell, options): Promise<PageResult> =>
        {
            captured = options;
            return Promise.resolve<PageResult>({
                kind: 'stream',
                status: 200,
                stream: new ReadableStream<Uint8Array>({
                    start(controller)
                    {
                        controller.enqueue(new TextEncoder().encode('<div id="root">'));
                        controller.close();
                    }
                })
            });
        },
        onError: (error, context) => void seen.push({
            phase: context.phase,
            path: context.path,
            message: (error as Error).message
        })
    });
    return { app, seen, captured: () => captured };
}

describe('a streamed page fault after the shell has flushed', () =>
{
    it('reaches the app\'s observer, tagged with the stream phase and the path', async () =>
    {
        const r = rig();
        const response = await r.app.handle(new Request('http://local/live'));
        expect(response.status).toBe(200);
        await response.text();

        // The renderer is handed a reporter, which is the wiring under test.
        const onError = r.captured()?.onError;
        expect(typeof onError).toBe('function');

        // Fire it exactly as renderToStream does for a boundary rejection.
        onError?.(new Error('a suspense boundary rejected mid-stream'));

        expect(r.seen).toEqual([{
            phase: 'stream',
            path: '/live',
            message: 'a suspense boundary rejected mid-stream'
        }]);
    });

    it('CONTROL: the buffered path is unaffected - a failure there still becomes a real status', async () =>
    {
        // Nothing to report out of band when the status can still carry it.
        const dir = mkdtempSync(join(tmpdir(), 'az-streamfault2-'));
        dirs.push(dir);
        writeFileSync(join(dir, 'index.html'), SHELL);
        const seen: Seen[] = [];
        const app = new App();
        mountPages(app, {
            routes: [{ path: '/buffered', component, render: 'server' }],
            clientDir: dir,
            renderer: (): Promise<PageResult> =>
                Promise.resolve({ kind: 'html', status: 500, html: '<html><body>failed</body></html>' }),
            onError: (error, context) => void seen.push({
                phase: context.phase,
                path: context.path,
                message: (error as Error).message
            })
        });

        const response = await app.handle(new Request('http://local/buffered'));
        expect(response.status).toBe(500);
        expect(seen).toEqual([]);
    });
});
