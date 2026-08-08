// <Image>: framework-native responsive images. Without an endpoint the component is an
// honest <img> passthrough (apps need no image server to use it); with one, src/srcset
// point at the transform endpoint with widths snapped UP a fixed ladder so the cache
// cardinality stays bounded. Dimensions pass through so the browser reserves space (CLS).
import { describe, expect, it } from 'vitest';
import { DEVICE_WIDTHS, Image, ImageConfig, createRoot, createSignal, h, provideContext, render, renderToString } from 'azerothjs';

function mounted(build: () => HTMLElement): HTMLElement
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(build, container);
    return container.querySelector('img') as HTMLElement;
}

describe('Image passthrough (no endpoint)', () =>
{
    it('emits a plain img with lazy/async defaults and the verbatim src', () =>
    {
        const img = mounted(() => h('div', {}, Image({ src: '/hero.png', alt: 'Hero', width: 300, height: 200 })));
        expect(img.getAttribute('src')).toBe('/hero.png');
        expect(img.getAttribute('alt')).toBe('Hero');
        expect(img.getAttribute('loading')).toBe('lazy');
        expect(img.getAttribute('decoding')).toBe('async');
        expect(img.getAttribute('width')).toBe('300');
        expect(img.getAttribute('height')).toBe('200');
        expect(img.getAttribute('srcset')).toBeNull();
    });

    it('eager loading and fetchpriority pass through when asked', () =>
    {
        const img = mounted(() => h('div', {}, Image({ src: '/hero.png', alt: 'x', loading: 'eager', fetchpriority: 'high' })));
        expect(img.getAttribute('loading')).toBe('eager');
        expect(img.getAttribute('fetchpriority')).toBe('high');
    });
});

describe('Image with an endpoint', () =>
{
    it('optimize: true targets /_image with the width snapped UP the ladder', () =>
    {
        const img = mounted(() => h('div', {}, Image({ src: '/hero.png', alt: 'x', width: 300, optimize: true })));
        expect(img.getAttribute('src')).toBe('/_image?src=%2Fhero.png&w=384&q=75');
        expect(img.getAttribute('srcset')).toBe('/_image?src=%2Fhero.png&w=384&q=75 1x, /_image?src=%2Fhero.png&w=640&q=75 2x');
    });

    it('sizes + width emits a w-descriptor ladder capped at twice the width', () =>
    {
        const img = mounted(() => h('div', {}, Image({ src: '/hero.png', alt: 'x', width: 640, sizes: '100vw', optimize: true })));
        const srcset = img.getAttribute('srcset') as string;
        expect(img.getAttribute('sizes')).toBe('100vw');
        for (const width of DEVICE_WIDTHS.filter((w) => w <= 1280))
        {
            expect(srcset).toContain(`w=${ width }&q=75 ${ width }w`);
        }
        expect(srcset).not.toContain('w=1920');
    });

    it('a custom endpoint string and a custom quality are honored', () =>
    {
        const img = mounted(() => h('div', {}, Image({ src: '/a.jpg', alt: 'x', width: 100, quality: 40, optimize: '/img-cdn' })));
        expect(img.getAttribute('src')).toBe('/img-cdn?src=%2Fa.jpg&w=128&q=40');
    });

    it('ImageConfig context enables optimization without a per-image prop', () =>
    {
        const container = document.createElement('div');
        document.body.appendChild(container);
        render(() =>
        {
            provideContext(ImageConfig, { endpoint: '/_image' });
            return h('div', {}, Image({ src: '/ctx.png', alt: 'x', width: 100 }));
        }, container);
        const img = container.querySelector('img') as HTMLElement;
        expect(img.getAttribute('src')).toBe('/_image?src=%2Fctx.png&w=128&q=75');
    });

    it('a reactive src getter keeps the URL live', () =>
    {
        const container = document.createElement('div');
        document.body.appendChild(container);
        createRoot(() =>
        {
            const [src, setSrc] = createSignal('/one.png');
            render(() => h('div', {}, Image({ src, alt: 'x', width: 100, optimize: true })), container);
            const img = container.querySelector('img') as HTMLElement;
            expect(img.getAttribute('src')).toBe('/_image?src=%2Fone.png&w=128&q=75');
            setSrc('/two.png');
            expect(img.getAttribute('src')).toBe('/_image?src=%2Ftwo.png&w=128&q=75');
        });
    });

    it('serializes on the server with escaped query separators and no handlers', () =>
    {
        const html = renderToString(() => h('div', {}, Image({ src: '/hero.png', alt: 'He >o<', width: 300, optimize: true })));
        expect(html).toContain('src="/_image?src=%2Fhero.png&amp;w=384&amp;q=75"');
        expect(html).toContain('alt="He &gt;o&lt;"');
        expect(html).toContain('loading="lazy"');
    });
});
