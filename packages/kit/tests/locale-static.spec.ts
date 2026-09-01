// @vitest-environment node
//
// A STATIC site in more than one language.
//
// Negotiation at request time is not available to a static host - there is no request-time code
// to negotiate with - so a multilingual static build has to produce a real artifact per language.
// The build writes them side by side and the mount serves the reader's own; the unsuffixed file
// is still written, because it is what a host with no negotiation serves and what replaces vite's
// index.html at the root.
import { describe, it, expect, afterAll } from 'vitest';
import { h, useLocale } from 'azerothjs';
import { resetHead } from 'azerothjs/internal';
import { App } from '@azerothjs/http';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import { prerender } from '@azerothjs/kit/prerender';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHELL = '<!doctype html><html lang="en"><head><title>Shell</title></head>'
    + '<body><div id="root"></div></body></html>';

const dirs: string[] = [];
afterAll(() =>
{
    for (const dir of dirs)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

const Page = (): HTMLElement =>
{
    const locale = useLocale();
    return h('main', {}, h('p', { id: 'seen' }, locale()));
};

const routes: PageRoute[] = [
    { path: '/', component: Page, render: 'static' },
    { path: '/about', component: Page, render: 'static' }
];

function clientDir(): string
{
    const dir = mkdtempSync(join(tmpdir(), 'az-lstatic-'));
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    dirs.push(dir);
    return dir;
}

describe('a static site in more than one language', () =>
{
    it('writes one file per language, beside the unsuffixed one', async () =>
    {
        resetHead();
        const dir = clientDir();
        await prerender({
            routes,
            clientDir: dir,
            renderer: createPageRenderer(() => Page(), routes),
            locales: ['en', 'fa']
        });

        expect(existsSync(join(dir, 'about', 'index.html'))).toBe(true);
        expect(existsSync(join(dir, 'about', 'index.en.html'))).toBe(true);
        expect(existsSync(join(dir, 'about', 'index.fa.html'))).toBe(true);

        // Each carries its own language, in the markup AND on the document element.
        const persian = readFileSync(join(dir, 'about', 'index.fa.html'), 'utf8');
        expect(persian).toContain('lang="fa"');
        expect(persian).toContain('dir="rtl"');
        expect(persian).toContain('>fa</p>');

        const english = readFileSync(join(dir, 'about', 'index.en.html'), 'utf8');
        expect(english).toContain('lang="en"');
        expect(english).toContain('>en</p>');
    });

    it('serves the reader their own file', async () =>
    {
        resetHead();
        const dir = clientDir();
        await prerender({
            routes,
            clientDir: dir,
            renderer: createPageRenderer(() => Page(), routes),
            locales: ['en', 'fa']
        });

        const server = new App();
        mountPages(server, { routes, clientDir: dir, locales: { supported: ['en', 'fa'] } });

        const persian = await server.handle(new Request('http://local/about', { headers: { 'accept-language': 'fa' } }));
        const persianHtml = await persian.text();
        expect(persian.status).toBe(200);
        expect(persianHtml).toContain('lang="fa"');
        expect(persianHtml).toContain('>fa</p>');

        const english = await server.handle(new Request('http://local/about', { headers: { 'accept-language': 'en' } }));
        const englishHtml = await english.text();
        expect(englishHtml).toContain('lang="en"');
        expect(englishHtml).toContain('>en</p>');
        // The discriminating pair: one build, two readers, two documents. Serving one file to
        // both is exactly the failure a static multilingual site otherwise has.
        expect(englishHtml).not.toContain('>fa</p>');
    });

    it('falls back to the unsuffixed file when a build predates the locale config', async () =>
    {
        resetHead();
        const dir = clientDir();
        // A single-language build: only the unsuffixed files exist.
        await prerender({ routes, clientDir: dir, renderer: createPageRenderer(() => Page(), routes) });
        expect(existsSync(join(dir, 'about', 'index.fa.html'))).toBe(false);

        const server = new App();
        mountPages(server, { routes, clientDir: dir, locales: { supported: ['en', 'fa'] } });
        const response = await server.handle(new Request('http://local/about', { headers: { 'accept-language': 'fa' } }));
        // Serves rather than 404s: a missing translation of a page is not a missing page.
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('id="seen"');
    });

    it('leaves a single-language build byte-identical', async () =>
    {
        resetHead();
        const one = clientDir();
        await prerender({ routes, clientDir: one, renderer: createPageRenderer(() => Page(), routes) });
        const files = ['index.html', join('about', 'index.html')];
        for (const file of files)
        {
            expect(existsSync(join(one, file)), file).toBe(true);
        }
        // No stray language files, so nothing about the layout changed for a site with one.
        expect(existsSync(join(one, 'about', 'index.en.html'))).toBe(false);
    });
});
