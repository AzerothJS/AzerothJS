// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { h, useDirection, useLocale, Suspense, createResource } from 'azerothjs';
import { App } from '@azerothjs/http';
import { mountPages, type PageRoute } from '@azerothjs/kit';
import { prerender } from '@azerothjs/kit/prerender';
import { applyDocumentContext, createPageRenderer } from '@azerothjs/kit/ssr';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carriesBaseStamp } from '../src/isr.ts';

const body = '<head></head><body><div id="root"></div></body></html>';
const page = (): HTMLElement => h('p', {}, useLocale()(), '/', useDirection()());
const render = createPageRenderer(page, [{ path: '/', component: page }]);

describe('the shell language on an unconfigured site', () =>
{
    const documents = [
        ['Persian', '<html lang="fa" dir="rtl">', 'fa/rtl'],
        ['a regional tag', "<HTML title='the > sign' LANG = 'FA-IR'>", 'FA-IR/rtl'],
        ['unquoted script subtag', '<html lang=zh-Hant>', 'zh-Hant/ltr'],
        ['encoded language letters', '<html lang="&#x66;&#97;-IR">', 'fa-IR/rtl'],
        ['named language letters', '<html lang="&fjlig;">', 'fj/ltr'],
        ['first duplicate', '<html lang="ar" LANG="en">', 'ar/rtl'],
        ['no language', '<html dir="rtl">', 'en/ltr'],
        ['empty first language', '<html lang LANG=fa>', 'en/ltr'],
        ['prefixed attribute names', '<html data-lang="fa" xml:lang="fa">', 'en/ltr'],
        ['comment and quoted decoys', '<!-- <html lang="de"> --><html title=\' lang="en" \' lang=fa>', 'fa/rtl'],
        ['implicit root', '<script>const x = \'<html lang="fa">\'</script>', 'en/ltr']
    ] as const;
    it.each(documents)('%s pins the content while preserving the document bytes', async (_name, header, seen) =>
    {
        const opening = '<!DOCTYPE html>\n' + header;
        const result = await render('/', opening + body);
        expect(result.kind).toBe('html');
        if (result.kind !== 'html')
        {
            throw new Error('expected a buffered document');
        }
        expect(result.html.startsWith(opening)).toBe(true);
        expect(result.html).toContain(`<p>${ seen }</p>`);
    });

    it('stamps the real root and keeps attribute-like text inside another attribute', async () =>
    {
        const before = '<!doctype html><!-- <html data-azeroth-base="/old" lang="es"> -->';
        const attr = ' title=\'use > lang="en" dir="ltr" data-azeroth-base="/hint"\'';
        const shell = before + '<html' + attr + ' LANG=ar lang=de DIR="rtl" data-azeroth-base="/stale">' + body;
        const result = await render('/', shell, { locale: 'en', base: '/en' });
        expect(result.kind).toBe('html');
        if (result.kind !== 'html')
        {
            throw new Error('expected a buffered document');
        }
        expect(result.html.startsWith(before + '<html lang="en" dir="ltr" data-azeroth-base="/en"' + attr + '>')).toBe(true);
        expect(result.html).toContain('<p>en/ltr</p>');
    });

    it('checks prefix artifacts at the document element and excludes comments and attribute text', () =>
    {
        expect(carriesBaseStamp('<!doctype html><HTML title="a>b" DATA-AZEROTH-BASE="/fa">')).toBe(true);
        expect(carriesBaseStamp('<!-- <html data-azeroth-base="/fa"> --><html lang=fa>')).toBe(false);
        expect(carriesBaseStamp('<html title=\' data-azeroth-base="/fa"\'>')).toBe(false);
        expect(carriesBaseStamp('<html-widget data-azeroth-base="/fa">')).toBe(false);
        expect(carriesBaseStamp('<html data-azeroth-base="" DATA-AZEROTH-BASE="/fa">')).toBe(false);
        expect(carriesBaseStamp('<html data-azeroth-base="/fa" DATA-AZEROTH-BASE="">')).toBe(true);
        expect(applyDocumentContext('<html title=\' data-azeroth-base="/book"\'>', {})).toBe('<html title=\' data-azeroth-base="/book"\'>');
    });

    it('serves the shell language on SSR, disk-backed static, seeded ISR and cold ISR routes', async () =>
    {
        const open = '<!doctype html><html lang="fa" dir="rtl">';
        const dir = mkdtempSync(join(tmpdir(), 'az-shell-locale-'));
        try
        {
            mkdirSync(join(dir, 'assets'));
            writeFileSync(join(dir, 'index.html'), open + body);
            const built: PageRoute[] = [
                { path: '/about', component: page, render: 'static' },
                { path: '/daily', component: page, render: 'static', revalidate: 60 }
            ];
            const routes: PageRoute[] = [
                ...built,
                { path: '/live', component: page, render: 'server' },
                { path: '/cold', component: page, render: 'static', revalidate: 60 }
            ];
            const renderer = createPageRenderer(page, routes);
            await prerender({ routes: built, renderer, clientDir: dir });
            const server = new App();
            mountPages(server, { routes, renderer, clientDir: dir });
            for (const route of routes)
            {
                const response = await server.handle(new Request('http://local' + route.path,
                    { headers: { 'accept-language': 'en' } }));
                const html = await response.text();
                expect(response.status, route.path).toBe(200);
                expect(response.headers.get('vary') ?? '').not.toMatch(/accept-language/i);
                expect(html.startsWith(open), route.path).toBe(true);
                expect(html, route.path).toContain('<p>fa/rtl</p>');
                if (built.includes(route))
                {
                    expect(html).toBe(readFileSync(join(dir, route.path, 'index.html'), 'utf8'));
                }
            }
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('pins each streamed boundary to its own shell even when another document finishes first', async () =>
    {
        function lateDocument(tag: string)
        {
            const gate = Promise.withResolvers<string>();
            const App = (): HTMLElement =>
            {
                const value = createResource(() => gate.promise);
                return h('main', {}, page(), Suspense({
                    on: [value], fallback: () => h('i', {}, 'pending'),
                    children: () => h('b', {}, useLocale()(), ':', value.data())
                }));
            };
            const result = createPageRenderer(App, [{ path: '/', component: App }])('/', `<html lang="${ tag }">` + body, { stream: true });
            return { result, finish: () => gate.resolve('done') };
        }
        const first = lateDocument('fa');
        const second = lateDocument('de');
        const documents = await Promise.all([first.result, second.result]);
        const [persian, german] = documents.map(doc =>
        {
            if (doc.kind !== 'stream')
            {
                throw new Error('expected a streamed document');
            }
            return new Response(doc.stream).text();
        });
        second.finish();
        expect(await german).toContain('<b>de:done</b>');
        first.finish();
        const html = await persian;
        expect(html).toContain('<p>fa/rtl</p>');
        expect(html).toContain('<b>fa:done</b>');
        expect(html).toContain('<html lang="fa">');
    });
});
