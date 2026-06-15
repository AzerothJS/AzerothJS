import { describe, it, expect } from 'vitest';
import { createSignal } from '@azerothjs/reactivity';
import { h, Show, For, Switch, Match, Portal, Dynamic, Suspense, Transition } from '@azerothjs/renderer';
import { ErrorBoundary } from '@azerothjs/component';
import { renderToString, renderToStaticMarkup } from '@azerothjs/server';

describe('control-flow SSR uses comment markers, never a wrapper element', () =>
{
    // No control-flow component may emit a `display:contents` span: that wrapper
    // is illegal inside <table>/<select>/<ul> (the parser hoists it out). Every
    // one must serialize as comment-anchored content instead.
    it('no component emits a <span> wrapper', () =>
    {
        const View = (): HTMLElement => h('i', {}, 'x');
        const samples = [
            renderToString(() => Show({ when: () => true, children: () => h('i', {}, 'x') })),
            renderToString(() => For({ each: () => [1], key: (n) => n, children: () => h('i', {}, 'x') })),
            renderToString(() => Switch({ children: [Match({ when: () => true, children: () => h('i', {}, 'x') })] })),
            renderToString(() => Dynamic({ component: () => View })),
            renderToString(() => Suspense({ fallback: () => h('i', {}, 'x'), on: [], children: () => h('i', {}, 'y') })),
            renderToString(() => Transition({ when: () => true, name: 'fade', children: () => h('i', {}, 'x') })),
            renderToString(() => Portal({ children: () => h('i', {}, 'x') })),
            renderToString(() => ErrorBoundary({ fallback: () => h('i', {}, 'e'), children: () => h('i', {}, 'x') }))
        ];

        for (const html of samples)
        {
            expect(html).not.toContain('<span');
            expect(html).not.toContain('display:contents');
            expect(html).toContain('<!--azc:');
        }
    });
});

describe('Show (SSR)', () =>
{
    it('renders children when the condition is true, tagged for hydration', () =>
    {
        const html = renderToString(() => Show({ when: () => true, children: () => h('p', {}, 'yes') }));
        expect(html).toBe('<!--azc:show--><p>yes</p><!--/azc-->');
    });

    it('renders the fallback when false', () =>
    {
        const html = renderToString(() => Show({
            when: () => false,
            fallback: () => h('p', {}, 'no'),
            children: () => h('p', {}, 'yes')
        }));
        expect(html).toBe('<!--azc:show--><p>no</p><!--/azc-->');
    });

    it('renders nothing between the markers when false with no fallback', () =>
    {
        const html = renderToString(() => Show({ when: () => false, children: () => h('p', {}, 'yes') }));
        expect(html).toBe('<!--azc:show--><!--/azc-->');
    });
});

describe('For (SSR)', () =>
{
    it('renders each row in order', () =>
    {
        const [items] = createSignal(['a', 'b']);
        const html = renderToString(() => For({ each: items, key: (x) => x, children: (x) => h('li', {}, x) }));
        expect(html).toBe('<!--azc:for--><li>a</li><li>b</li><!--/azc-->');
    });

    it('exposes a static index getter', () =>
    {
        const [items] = createSignal(['a', 'b']);
        const html = renderToStaticMarkup(() => For({
            each: items,
            key: (_, i) => i,
            children: (item, index) => h('li', {}, () => `${ index() }:${ item }`)
        }));
        expect(html).toBe('<li>0:a</li><li>1:b</li>');
    });
});

describe('Switch (SSR)', () =>
{
    const build = (status: string): string => renderToString(() => Switch({
        fallback: () => h('p', {}, 'idle'),
        children: [
            Match({ when: () => status === 'loading', children: () => h('p', {}, 'loading') }),
            Match({ when: () => status === 'done', children: () => h('p', {}, 'done') })
        ]
    }));

    it('renders the first matching case', () =>
    {
        expect(build('done')).toBe('<!--azc:switch--><p>done</p><!--/azc-->');
    });

    it('renders the fallback when nothing matches', () =>
    {
        expect(build('other')).toBe('<!--azc:switch--><p>idle</p><!--/azc-->');
    });
});

describe('Dynamic (SSR)', () =>
{
    it('renders the resolved component', () =>
    {
        const View = (): HTMLElement => h('section', {}, 'view');
        const html = renderToString(() => Dynamic({ component: () => View }));
        expect(html).toBe('<!--azc:dynamic--><section>view</section><!--/azc-->');
    });

    it('renders empty markers for a null component', () =>
    {
        const html = renderToString(() => Dynamic({ component: () => null }));
        expect(html).toBe('<!--azc:dynamic--><!--/azc-->');
    });
});

describe('Suspense (SSR)', () =>
{
    it('renders the fallback (resources do not resolve synchronously)', () =>
    {
        const html = renderToString(() => Suspense({
            fallback: () => h('p', {}, 'loading'),
            on: [],
            children: () => h('p', {}, 'content')
        }));
        expect(html).toBe('<!--azc:suspense--><p>loading</p><!--/azc-->');
    });
});

describe('Transition (SSR)', () =>
{
    it('renders static content with no animation classes', () =>
    {
        const html = renderToString(() => Transition({
            when: () => true,
            name: 'fade',
            children: () => h('div', { class: 'modal' }, 'Hi')
        }));
        expect(html).toBe('<!--azc:transition--><div class="modal">Hi</div><!--/azc-->');
        expect(html).not.toContain('fade-enter');
    });
});

describe('Portal (SSR)', () =>
{
    it('renders content inline without touching document.body', () =>
    {
        const html = renderToString(() => Portal({ children: () => h('div', { class: 'modal' }, 'M') }));
        expect(html).toBe('<!--azc:portal--><div class="modal">M</div><!--/azc-->');
    });
});

describe('ErrorBoundary (SSR)', () =>
{
    it('renders children when they do not throw', () =>
    {
        const html = renderToString(() => ErrorBoundary({
            fallback: () => h('p', {}, 'err'),
            children: () => h('p', {}, 'ok')
        }));
        expect(html).toBe('<!--azc:errorboundary--><p>ok</p><!--/azc-->');
    });

    it('renders the fallback when children throw', () =>
    {
        const html = renderToString(() => ErrorBoundary({
            fallback: (err) => h('p', {}, `caught: ${ String(err) }`),
            children: () =>
            {
                throw new Error('boom');
            }
        }));
        expect(html).toBe('<!--azc:errorboundary--><p>caught: Error: boom</p><!--/azc-->');
    });
});
