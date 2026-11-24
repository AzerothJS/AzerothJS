// @vitest-environment node
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '@azerothjs/http';
import { FilePageCache, mountPages, type PageRoute } from '@azerothjs/kit';
import { createPageRenderer, type PageRenderer } from '@azerothjs/kit/ssr';
import { prerender } from '@azerothjs/kit/prerender';
import { h, useLocale } from 'azerothjs';

const shell = '<!doctype html><html lang="en"><head></head><body><div id="root"></div></body></html>';
const bin = fileURLToPath(new URL('../dist/prerender-cli.js', import.meta.url));
const dirs: string[] = [];
const Page = (): HTMLElement => h('p', {}, useLocale()());
const locales = { supported: ['en', 'fa'], default: 'FA-ir', routing: 'prefix' } as const;

function clientDir(): string
{
    const dir = mkdtempSync(join(tmpdir(), 'az-entry-locale-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), shell);
    return dir;
}

afterEach(() =>
{
    for (const dir of dirs.splice(0))
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

// The real binary loads an ESM application. Expose exactly what the renderer received from it.
function runBin(dir: string, exports: string): SpawnSyncReturns<string>
{
    const entry = join(dir, 'entry.mjs');
    writeFileSync(entry, [
        'export const routes = [{ path: "/about", component: () => {}, render: "static" }];',
        'export async function renderPage(path, shell, options) {',
        '  const base = options.base ? \' data-azeroth-base="\' + options.base + \'"\' : "";',
        '  return { kind: "html", status: 200, html: "<html" + base + "><body>" + JSON.stringify(options) + "</body></html>" };',
        '}', exports
    ].join('\n'));
    return spawnSync(process.execPath, [bin, '--entry', entry, '--client', dir], { encoding: 'utf8' });
}

function renderInput(dir: string, file: string): Record<string, unknown>
{
    const html = readFileSync(join(dir, 'about', file), 'utf8');
    return JSON.parse(html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))) as Record<string, unknown>;
}

describe('locale configuration from the public SSR entry', () =>
{
    it('uses the resolved default at the bare URL and the correct base at every prefixed URL', async () =>
    {
        const dir = clientDir();
        const run = runBin(dir, `export const locales = ${ JSON.stringify(locales) }; export const origin = 'HTTPS://EXAMPLE.TEST:443/';`);
        expect(run.status, run.stderr).toBe(0);
        const alternates = [
            { hreflang: 'en', href: 'https://example.test/en/about' },
            { hreflang: 'fa', href: 'https://example.test/fa/about' },
            { hreflang: 'x-default', href: 'https://example.test/about' }
        ];
        const bare = renderInput(dir, 'index.html');
        expect(bare).toMatchObject({ locale: 'fa', alternates });
        expect(bare).not.toHaveProperty('base');
        for (const tag of locales.supported)
        {
            expect(renderInput(dir, `index.${ tag }.html`)).toMatchObject({ locale: tag, base: `/${ tag }`, alternates });
        }
        // Compare the handoff identities at the two public boundaries using the same shell.
        const app = new App();
        mountPages(app, {
            routes: [{ path: '/live', render: 'server', component: Page }], shell, locales, origin: 'https://example.test',
            renderer: async (_path, _shell, options) => ({ kind: 'html', status: 200, html: options?.handoffMeta?.build ?? '' })
        });
        const response = await app.handle(new Request('https://visitor.test/en/live'));
        expect(response.status).toBe(200);
        expect(bare.handoffMeta).toMatchObject({ build: await response.text() });
    });

    it.each(['', 'export const locales = { supported: [], default: "fa", routing: "prefix" };'])(
        'preserves the legacy build identity and single output with absent or empty configuration (%s)', (exports) =>
        {
            const dir = clientDir();
            const run = runBin(dir, exports);
            expect(run.status, run.stderr).toBe(0);
            expect(readdirSync(join(dir, 'about'))).toEqual(['index.html']);
            expect(renderInput(dir, 'index.html')).toEqual({
                handoffMeta: { build: createHash('sha256').update(shell).digest('hex').slice(0, 16), static: true }
            });
        });

    it('rejects a list exported by an SSR entry before writing any files', () =>
    {
        const dir = clientDir();
        const run = runBin(dir, 'export const locales = ["en", "fa"];');
        expect(run.status).toBe(1);
        expect(run.stderr).toContain('supported array');
        expect(existsSync(join(dir, 'shell.html'))).toBe(false);
    });

    it('rejects supported tag spellings that collide in the output directory', async () =>
    {
        const dir = clientDir();
        const colliding = { supported: ['fa', 'FA'] };
        const run = runBin(dir, `export const locales = ${ JSON.stringify(colliding) };`);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain('same artifact');
        expect(existsSync(join(dir, 'shell.html'))).toBe(false);
        expect(() => mountPages(new App(), { shell, routes: [], locales: colliding })).toThrow('same artifact');
    });

    it('rolls back every write when routes share an artifact and a later render fails', async () =>
    {
        const dir = clientDir();
        const routes: PageRoute[] = [
            { path: '/', component: Page, render: 'static' },
            { path: '/:id', component: Page, render: 'static', staticParams: async () => [{ id: 'same' }] },
            { path: '/same', component: Page, render: 'static' },
            { path: '/fail', component: Page, render: 'static' }
        ];
        const renderer: PageRenderer = async (path, _shell, options) =>
        {
            if (path === '/fail')
            {
                throw new Error('later render failed');
            }
            return { kind: 'html', status: 200, html: `<html lang="${ options?.locale }"></html>` };
        };
        await expect(prerender({ routes, clientDir: dir, renderer, locales: ['en', 'fa', 'fa'] })).rejects.toThrow('later render failed');
        expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe(shell);
        expect(existsSync(join(dir, 'index.en.html'))).toBe(false);
        expect(readdirSync(join(dir, 'same'))).toEqual([]);
    });

    it.each(['ftp://files.test', 'https://secret@site.test', 'https://site.test/news', 'https://site.test/?', 'https://site.test/#', 'https://site.test\0'])(
        'rejects an invalid origin before building or mounting (%j)', async (origin) =>
        {
            const dir = clientDir();
            const renderer = createPageRenderer(Page, []);
            await expect(prerender({ routes: [], clientDir: dir, renderer, origin })).rejects.toThrow(/origin must be.*HTTP/);
            expect(existsSync(join(dir, 'shell.html'))).toBe(false);
            expect(() => mountPages(new App(), { routes: [], shell, origin })).toThrow(/^kit: origin must be an absolute public HTTP or HTTPS origin without credentials, path, query or fragment\.$/);
        });

    it('uses the configured origin for live pages and invalidates persistent ISR output after an origin change', async () =>
    {
        const dir = clientDir();
        const cacheDir = join(dir, 'cached-pages');
        const routes: PageRoute[] = [
            { path: '/live', component: Page, render: 'server' },
            { path: '/news', component: Page, render: 'static', revalidate: 3600 }
        ];
        const renderer = createPageRenderer(Page, routes);
        const mount = (origin: string): App =>
        {
            const app = new App();
            mountPages(app, { routes, clientDir: dir, renderer, locales, origin, cache: new FilePageCache(cacheDir) });
            return app;
        };
        const fetch = (app: App, path: string): Promise<Response> => app.handle(new Request(`https://visitor.test/fa/${ path }`));
        const first = mount('https://first.test');
        const live = await fetch(first, 'live');
        expect(live.status).toBe(200);
        expect(await live.text()).toContain('href="https://first.test/en/live"');
        const initial = await fetch(first, 'news');
        expect(initial.headers.get('x-azeroth-cache')).toBe('miss');
        expect(await initial.text()).toContain('href="https://first.test/en/news"');
        const equivalent = await fetch(mount('HTTPS://FIRST.TEST:443/'), 'news');
        expect(equivalent.headers.get('x-azeroth-cache')).toBe('hit');
        const changed = await fetch(mount('https://second.test'), 'news');
        expect(changed.headers.get('x-azeroth-cache')).toBe('miss');
        const html = await changed.text();
        expect(html).toContain('href="https://second.test/en/news"');
        expect(html).not.toContain('first.test');
        expect(html).not.toContain('visitor.test');
    });

    it('regenerates shared HTML when its routing mode or ordered alternate languages change', async () =>
    {
        const dir = clientDir();
        const routes: PageRoute[] = [{ path: '/news', component: Page, render: 'static', revalidate: 3600 }];
        const renderer = createPageRenderer(Page, routes);
        const visit = (routing: 'negotiate' | 'prefix', supported: string[]): Promise<Response> =>
        {
            const app = new App();
            mountPages(app, {
                routes, clientDir: dir, renderer, locales: { routing, supported, default: 'fa' },
                cache: new FilePageCache(join(dir, 'cached-pages'))
            });
            const path = routing === 'prefix' ? '/fa/news' : '/news';
            // This fixture has no seed. A queryless render earns a persistent slot on the first request.
            return app.handle(new Request(`https://visitor.test${ path }`));
        };
        const initial = await visit('negotiate', ['en', 'fa']);
        expect(initial.headers.get('x-azeroth-cache')).toBe('miss');
        expect(await initial.text()).not.toContain('hreflang=');
        const prefixed = await visit('prefix', ['en', 'fa']);
        expect(prefixed.headers.get('x-azeroth-cache')).toBe('miss');
        expect(await prefixed.text()).toContain('data-azeroth-base="/fa"');
        const rebuilt = await visit('prefix', ['fr', 'fa']);
        expect(rebuilt.headers.get('x-azeroth-cache')).toBe('miss');
        expect(await rebuilt.text()).toContain('href="/fr/news"');
        const reordered = await visit('prefix', ['fa', 'fr']);
        expect(reordered.headers.get('x-azeroth-cache')).toBe('miss');
        expect(await reordered.text()).toMatch(/hreflang="fa".+hreflang="fr"/s);
        const warm = await visit('prefix', ['fa', 'fr']);
        expect(warm.headers.get('x-azeroth-cache')).toBe('hit');
    });
});
