// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '@azerothjs/http';
import { mountPages } from '@azerothjs/kit';

const bin = fileURLToPath(new URL('../dist/prerender-cli.js', import.meta.url));
const temporary: string[] = [];

function project(staticPage: boolean): { dist: string; assets: string; run: () => void }
{
    const root = mkdtempSync(join(tmpdir(), 'az-asset-'));
    temporary.push(root);
    const dist = join(root, 'dist');
    const assets = join(dist, 'assets');
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<html><body><div id="root"></div></body></html>');
    const entry = join(root, 'server.mjs');
    writeFileSync(entry, [
        `export const routes = ${ staticPage ? '[{ path: "/assets/page", component() {}, render: "static" }]' : '[]' };`,
        'export async function renderPage() { return { kind: "html", status: 200, html: "<html>Page</html>" }; }'
    ].join('\n'));
    return { dist, assets, run: () =>
    {
        const result = spawnSync(process.execPath, [bin, '--entry', entry, '--client', dist], { encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
    } };
}

afterEach(() =>
{
    for (const dir of temporary.splice(0))
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('compressed build assets', () =>
{
    it.each([true, false])('generates sidecars after prerender and refreshes them on rebuild (static pages=%s)', staticPage =>
    {
        const { assets, dist, run } = project(staticPage);
        const nested = join(assets, 'chunks');
        mkdirSync(nested);
        const file = join(nested, 'client-abc.js');
        writeFileSync(join(assets, 'photo.webp'), 'photo');
        writeFileSync(join(assets, 'index.fa.html'), 'translated page');
        writeFileSync(join(dist, 'public.js'), 'public asset');
        for (const label of ['First', 'Second'])
        {
            const bytes = Buffer.from(`console.log("${ label }");\n`.repeat(1500));
            writeFileSync(file, bytes);
            run();
            const br = readFileSync(file + '.br');
            const gz = readFileSync(file + '.gz');
            expect(brotliDecompressSync(br).equals(bytes)).toBe(true);
            expect(gunzipSync(gz).equals(bytes)).toBe(true);
            expect(br.equals(brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }))).toBe(true);
            expect(gz.equals(gzipSync(bytes, { level: 9 }))).toBe(true);
            expect(statSync(file + '.br').mtimeMs).toBeGreaterThanOrEqual(statSync(file).mtimeMs);
        }
        expect(readdirSync(nested).sort()).toEqual(['client-abc.js', 'client-abc.js.br', 'client-abc.js.gz']);
        for (const excluded of [join(dist, 'public.js'), join(assets, 'photo.webp'), join(assets, 'index.fa.html'), join(assets, 'page', 'index.html')])
        {
            expect(existsSync(excluded + '.gz')).toBe(false);
            expect(existsSync(excluded + '.br')).toBe(false);
        }
        expect(existsSync(join(assets, 'page', 'index.html'))).toBe(staticPage);
    });

    it('leaves a linked asset directory alone', () =>
    {
        const { dist, assets, run } = project(false);
        const shared = join(dist, 'shared');
        mkdirSync(shared);
        writeFileSync(join(shared, 'external.css'), '.external {}');
        symlinkSync(shared, join(assets, 'shared'), 'junction');
        run();
        expect(readdirSync(shared)).toEqual(['external.css']);
    });

    it('uses precompressed files only on the immutable assets mount', async () =>
    {
        const { assets, dist, run } = project(false);
        const bytes = Buffer.from('h1 { color: plum }\n'.repeat(300));
        writeFileSync(join(assets, 'style.css'), bytes);
        writeFileSync(join(dist, 'public.css'), bytes);
        writeFileSync(join(dist, 'public.css.gz'), gzipSync(bytes));
        run();
        const app = new App();
        mountPages(app, { clientDir: dist, routes: [] });
        const get = (path: string): Promise<Response> => app.handle(new Request(`http://local/${ path }`, { headers: { 'accept-encoding': 'gzip' } }));
        const asset = await get('assets/style.css');
        expect(asset.headers.get('content-encoding')).toBe('gzip');
        expect(asset.headers.get('cache-control')).toContain('immutable');
        expect(asset.headers.get('content-type')).toContain('text/css');
        expect(Buffer.from(await asset.arrayBuffer()).equals(readFileSync(join(assets, 'style.css.gz')))).toBe(true);
        const plain = await get('public.css');
        expect(plain.headers.get('content-encoding')).toBe(null);
        expect(Buffer.from(await plain.arrayBuffer()).equals(bytes)).toBe(true);
        expect((await get('assets/missing.css')).status).toBe(404);
    });
});
