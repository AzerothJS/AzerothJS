// @vitest-environment node
//
// An ISR page under prefix routing carries its hreflang set on every render: the prerendered
// seed, the regeneration past its window, and a miss. The set is built from the canonical path
// and the sorted query, so every spelling of a page and its seed file carry one root-relative set.
import { describe, it, expect, afterAll } from 'vitest';
import { h, useLocale } from 'azerothjs';
import { resetHead } from 'azerothjs/internal';
import { App } from '@azerothjs/http';
import { MemoryPageCache, mountPages, type PageEntry, type PageRoute } from '@azerothjs/kit';
import { prerender } from '@azerothjs/kit/prerender';
import { createPageRenderer } from '@azerothjs/kit/ssr';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHELL = '<!doctype html><html lang="en"><head><title>Shell</title></head>'
    + '<body><div id="root"></div></body></html>';

// Appended to every seed file, so a body without it came from a render.
const MARKER = '<!--seed-->';

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

/** A memory cache that can wait for the first write of a rendered body. */
class WatchedCache extends MemoryPageCache
{
    readonly #waiters: Array<() => void> = [];

    public rendered(): Promise<void>
    {
        return new Promise((resolve) => this.#waiters.push(resolve));
    }

    public override async set(key: string, entry: PageEntry): Promise<void>
    {
        await super.set(key, entry);
        if (!entry.html.includes(MARKER))
        {
            this.#waiters.splice(0).forEach((resolve) => resolve());
        }
    }
}

/**
 * Builds the site, stamps each seed file with the marker and an old mtime so its first read is
 * stale, and mounts it. `prefix` false builds and mounts the same site negotiated.
 */
async function site(routes: PageRoute[], seeds: string[], prefix = true): Promise<{ server: App; dir: string; cache: WatchedCache }>
{
    const dir = mkdtempSync(join(tmpdir(), 'az-isr-hreflang-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), SHELL);
    mkdirSync(join(dir, 'assets'));
    resetHead();
    await prerender({
        routes,
        clientDir: dir,
        renderer: createPageRenderer(() => Page(), routes),
        locales: ['en', 'fa'],
        ...(prefix ? { routing: 'prefix' as const } : {})
    });
    const old = new Date('2020-01-01T00:00:00Z');
    for (const seed of seeds)
    {
        appendFileSync(join(dir, seed), MARKER);
        utimesSync(join(dir, seed), old, old);
    }
    const cache = new WatchedCache();
    const server = new App();
    mountPages(server, {
        routes,
        clientDir: dir,
        cache,
        renderer: createPageRenderer(() => Page(), routes),
        locales: { supported: ['en', 'fa'], ...(prefix ? { routing: 'prefix' as const } : {}) }
    });
    return { server, dir, cache };
}

async function get(server: App, path: string, host = 'local'): Promise<{ verdict: string | null; html: string }>
{
    resetHead();
    const response = await server.handle(new Request(`http://${ host }${ path }`, { headers: { accept: 'text/html', 'accept-language': 'en' } }));
    return { verdict: response.headers.get('x-azeroth-cache'), html: await response.text() };
}

/** Every hreflang link tag, byte for byte. */
const tags = (html: string): string[] => html.match(/<link rel="alternate"[^>]*>/g) ?? [];

/** Each link as `hreflang=href`, with the attribute escaping undone. */
const hrefs = (html: string): string[] => tags(html).map((tag) =>
    `${ /hreflang="([^"]*)"/.exec(tag)?.[1] }=${ /href="([^"]*)"/.exec(tag)?.[1]?.replaceAll('&amp;', '&') }`);

const seedTags = (dir: string, seed: string): string[] => tags(readFileSync(join(dir, seed), 'utf8'));

/** The stale answer, then the regenerated copy it triggered. */
async function regenerate(server: App, cache: WatchedCache, path: string): Promise<{ stale: string; regenerated: string }>
{
    const rendered = cache.rendered();
    const stale = await get(server, path);
    expect(stale.verdict).toBe('stale');
    expect(stale.html).toContain(MARKER);
    await rendered;
    const regenerated = await get(server, path);
    expect(regenerated.verdict).toBe('hit');
    expect(regenerated.html).not.toContain(MARKER);
    return { stale: stale.html, regenerated: regenerated.html };
}

const pages: PageRoute[] = [
    { path: '/docs', component: Page, render: 'static', revalidate: 60 },
    { path: '/a/:name', component: Page, render: 'static', revalidate: 60, staticParams: () => Promise.resolve([{ name: 'caf\u00e9' }]) },
    { path: '/p/:id', component: Page, render: 'static', revalidate: 60 }
];
const pageSeeds = ['docs/index.en.html', 'docs/index.fa.html', 'a/caf\u00e9/index.en.html', 'a/caf\u00e9/index.fa.html'];

describe('an ISR page under prefix routing carries its hreflang set on every render', () =>
{
    it('the seed, its regeneration and a miss carry en, fa and x-default at root-relative hrefs', async () =>
    {
        const { server, dir, cache } = await site(pages, pageSeeds);
        const seed = seedTags(dir, 'docs/index.en.html');
        expect(hrefs(seed.join(''))).toEqual(['en=/en/docs', 'fa=/fa/docs', 'x-default=/docs']);

        const { stale, regenerated } = await regenerate(server, cache, '/en/docs');
        expect(tags(stale)).toEqual(seed);
        expect(tags(regenerated)).toEqual(seed);

        const miss = await get(server, '/en/p/7');
        expect(miss.verdict).toBe('miss');
        expect(hrefs(miss.html)).toEqual(['en=/en/p/7', 'fa=/fa/p/7', 'x-default=/p/7']);
    });

    it('a page whose slug is a language tag carries its own set, not the home page\'s', async () =>
    {
        const slugs: PageRoute[] = [
            { path: '/:slug', component: Page, render: 'static', revalidate: 60, staticParams: () => Promise.resolve([{ slug: 'fa' }]) }
        ];
        const { server, dir, cache } = await site(slugs, ['fa/index.en.html', 'fa/index.fa.html']);
        const seed = seedTags(dir, 'fa/index.en.html');
        expect(hrefs(seed.join(''))).toEqual(['en=/en/fa', 'fa=/fa/fa', 'x-default=/fa']);

        const { stale, regenerated } = await regenerate(server, cache, '/en/fa');
        expect(tags(stale)).toEqual(seed);
        expect(tags(regenerated)).toEqual(seed);

        const persian = await regenerate(server, cache, '/fa/fa');
        expect(tags(persian.regenerated)).toEqual(seed);

        const miss = await get(server, '/en/fa?x=1');
        expect(miss.verdict).toBe('miss');
        expect(hrefs(miss.html)).toEqual(['en=/en/fa?x=1', 'fa=/fa/fa?x=1', 'x-default=/fa?x=1']);
    });

    it('a trailing slash and an encoded spelling regenerate byte-equal to the seed\'s set', async () =>
    {
        const { server, dir, cache } = await site(pages, pageSeeds);
        const docs = seedTags(dir, 'docs/index.en.html');
        const cafe = seedTags(dir, 'a/caf\u00e9/index.en.html');
        expect(hrefs(cafe.join(''))).toEqual(['en=/en/a/caf\u00e9', 'fa=/fa/a/caf\u00e9', 'x-default=/a/caf\u00e9']);

        for (const [path, seed] of [['/en/docs/', docs], ['/en/%64ocs', docs], ['/en/a/caf%C3%A9', cafe]] as const)
        {
            const { regenerated } = await regenerate(server, cache, path);
            expect(tags(regenerated), path).toEqual(seed);
        }
    });

    // A segment holding %, ? or # carries it escaped; one no file can name keeps its raw spelling.
    it.each([
        ['/en/p/a%3Fb', '/p/a%3Fb'],
        ['/en/p/a%23b', '/p/a%23b'],
        ['/en/p/100%25', '/p/100%25'],
        ['/en/p/a%2Fb/', '/p/a%2Fb']
    ])('a miss on %s carries %s', async (path, bare) =>
    {
        const { server } = await site(pages, pageSeeds);
        const miss = await get(server, path);
        expect(miss.verdict).toBe('miss');
        expect(hrefs(miss.html)).toEqual([`en=/en${ bare }`, `fa=/fa${ bare }`, `x-default=${ bare }`]);
    });

    it('a staticParams value holding % seeds and regenerates its escaped path byte-equal', async () =>
    {
        const percent: PageRoute[] = [
            { path: '/a/:name', component: Page, render: 'static', revalidate: 60, staticParams: () => Promise.resolve([{ name: '100%' }]) }
        ];
        const { server, dir, cache } = await site(percent, ['a/100%/index.en.html', 'a/100%/index.fa.html']);
        const seed = seedTags(dir, 'a/100%/index.en.html');
        expect(hrefs(seed.join(''))).toEqual(['en=/en/a/100%25', 'fa=/fa/a/100%25', 'x-default=/a/100%25']);

        const { regenerated } = await regenerate(server, cache, '/en/a/100%25');
        expect(tags(regenerated)).toEqual(seed);
    });

    it('two query orders sharing one entry carry the sorted query', async () =>
    {
        const { server } = await site(pages, pageSeeds);
        const sorted = ['en=/en/docs?a=1&b=2', 'fa=/fa/docs?a=1&b=2', 'x-default=/docs?a=1&b=2'];

        // A query-bearing key is cached on its second sighting, so this spelling fills the entry.
        const first = await get(server, '/en/docs?b=2&a=1');
        const filled = await get(server, '/en/docs?b=2&a=1');
        const read = await get(server, '/en/docs?a=1&b=2');
        expect([first.verdict, filled.verdict, read.verdict]).toEqual(['miss', 'miss', 'hit']);
        expect(read.html).toBe(filled.html);
        for (const { html } of [first, filled, read])
        {
            expect(hrefs(html)).toEqual(sorted);
        }
    });

    it('an entry filled under one Host is served byte-identical under another, with no host in any href', async () =>
    {
        const { server } = await site(pages, pageSeeds);
        const filled = await get(server, '/en/p/9', 'a.example');
        const read = await get(server, '/en/p/9', 'b.example');
        expect([filled.verdict, read.verdict]).toEqual(['miss', 'hit']);
        expect(read.html).toBe(filled.html);
        expect(hrefs(read.html)).toEqual(['en=/en/p/9', 'fa=/fa/p/9', 'x-default=/p/9']);
        expect(read.html).not.toContain('a.example');
    });
});

describe('an ISR page outside prefix routing carries no hreflang set', () =>
{
    it('not on the seed, its regeneration, or a miss', async () =>
    {
        const { server, cache } = await site(pages, ['docs/index.html', 'docs/index.en.html', 'docs/index.fa.html'], false);
        const { stale, regenerated } = await regenerate(server, cache, '/docs');
        expect(tags(stale)).toEqual([]);
        expect(tags(regenerated)).toEqual([]);
        expect(regenerated).toContain('>en</p>');

        const miss = await get(server, '/p/7');
        expect(miss.verdict).toBe('miss');
        expect(tags(miss.html)).toEqual([]);
    });
});
