// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'azerothjs';
import { App } from '@azerothjs/http';
import * as httpNode from '@azerothjs/http/node';
import { mountPages } from '@azerothjs/kit';
import { isPageArtifact } from '../src/page-artifact.ts';

let root: string;
const component = (): HTMLElement => h('div', {}, 'Public catalogue');
beforeEach(async () =>
{
    root = await mkdtemp(join(tmpdir(), 'az-page-files-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

async function put(file: string, bytes: string | Uint8Array = ''): Promise<void>
{
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), bytes);
}

describe('ownership of page files', () =>
{
    it.each([
        ['index.html', '/'],
        ['index.html.gz', '/'],
        ['exhibits/index.html.br', '/exhibits'],
        ['exhibits/index.en-US.html.BR', '/exhibits'],
        ['exhibits/café/index.fa.html.gz.br', '/exhibits/caf%C3%A9']
    ])('takes the owner of %s from its page directory', async (file, expected) =>
    {
        await put(file);
        const owns = vi.fn((url: string) => url === expected);
        const path = join(root, file);
        expect(await isPageArtifact(root, path, await realpath(path), owns)).toBe(true);
        expect(owns).toHaveBeenCalledWith(expected);
    });

    it.each(['assets/theme.css.br', 'guide.html.gz', 'index.html.br.map', 'index.htmlx.br'])(
        'keeps an ordinary asset outside the page-file rule: %s', async file =>
        {
            await put(file);
            const owns = vi.fn(() => true);
            const path = join(root, file);
            expect(await isPageArtifact(root, path, await realpath(path), owns)).toBe(false);
            expect(owns).not.toHaveBeenCalled();
        }
    );

    it('reserves stored page files for guarded and revalidating owners in the mounted file policies', async () =>
    {
        await put('index.html', '<html><body></body></html>');
        await put('exhibits/index.en.html.gz');
        await put('assets/catalogue/index.html.br');
        const mounts = vi.spyOn(httpNode, 'staticFiles');
        try
        {
            mountPages(new App(), {
                clientDir: root,
                routes: [
                    { path: '/exhibits', render: 'server', component, guard: () => true },
                    { path: '/assets/catalogue', render: 'static', component, revalidate: 60 }
                ],
                renderer: async () => ({ kind: 'html', status: 200, html: 'Public catalogue' })
            });
            for (const [directory, name] of [[root, 'exhibits/index.en.html.gz'], [join(root, 'assets'), 'catalogue/index.html.br']] as const)
            {
                const policy = mounts.mock.calls.find(([dir, options]) => dir === directory && options?.allowFile)?.[1]?.allowFile;
                const file = await httpNode.containedFile(directory, name);
                if (policy === undefined || file === null)
                {
                    throw new Error(`Missing file or static policy for ${ name }`);
                }
                expect(await policy(file, file.realPath)).toBe(false);
            }
        }
        finally
        {
            mounts.mockRestore();
        }
    });

    it.each(['exhibits', 'assets/exhibits'])('consults the page owner before serving a public copy under %s', async directory =>
    {
        const file = `${ directory }/index.en.html.gz`;
        const bytes = gzipSync('public catalogue');
        await put('index.html', '<html><body><div id="root"></div></body></html>');
        await put(file, bytes);
        const guarded = vi.fn(() => false);
        const app = new App();
        mountPages(app, {
            clientDir: root,
            routes: [{ path: '/' + directory, component, render: 'client' }],
            renderer: Object.assign(async () => ({ kind: 'html' as const, status: 200, html: 'public catalogue' }), { guarded })
        });
        guarded.mockClear();
        const response = await app.handle(new Request(`http://local/${ file }`));
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
        expect(guarded).toHaveBeenCalledWith('/' + directory);
    });

    it('consults the public page directory for both identity and negotiated files on an aliased asset mount', async () =>
    {
        const page = 'gallery/exhibits/index.en.html';
        const bytes = gzipSync('public catalogue');
        await put('index.html', '<html><body><div id="root"></div></body></html>');
        await put(page, 'public catalogue');
        await put(page + '.gz', bytes);
        await symlink(join(root, 'gallery'), join(root, 'assets'), 'junction');
        const guarded = vi.fn(() => false);
        const app = new App();
        mountPages(app, {
            clientDir: root,
            routes: [{ path: '/gallery/exhibits', component, render: 'client' }],
            renderer: Object.assign(async () => ({ kind: 'html' as const, status: 200, html: 'public catalogue' }), { guarded })
        });
        guarded.mockClear();
        const response = await app.handle(new Request('http://local/assets/exhibits/index.en.html', {
            headers: { 'accept-encoding': 'gzip' }
        }));
        expect(response.headers.get('content-encoding')).toBe('gzip');
        expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
        expect(guarded.mock.calls).toEqual([['/gallery/exhibits'], ['/gallery/exhibits']]);
    });
});
