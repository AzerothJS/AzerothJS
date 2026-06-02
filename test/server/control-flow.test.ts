import { describe, it, expect } from 'vitest';
import { createSignal } from '@azerothjs/reactivity';
import { h, Show, For, Switch, Match, Portal, Dynamic, Suspense, Transition } from '@azerothjs/renderer';
import { ErrorBoundary } from '@azerothjs/component';
import { renderToString, renderToStaticMarkup } from '@azerothjs/server';

describe('Show (SSR)', () =>
{
    it('renders children when the condition is true, tagged for hydration', () =>
    {
        const html = renderToString(() => Show({ when: () => true, children: () => h('p', {}, 'yes') }));
        expect(html).toBe('<span style="display:contents" data-azeroth-co="show"><p>yes</p></span>');
    });

    it('renders the fallback when false', () =>
    {
        const html = renderToString(() => Show({
            when: () => false,
            fallback: () => h('p', {}, 'no'),
            children: () => h('p', {}, 'yes')
        }));
        expect(html).toBe('<span style="display:contents" data-azeroth-co="show"><p>no</p></span>');
    });

    it('renders nothing inside the wrapper when false with no fallback', () =>
    {
        const html = renderToString(() => Show({ when: () => false, children: () => h('p', {}, 'yes') }));
        expect(html).toBe('<span style="display:contents" data-azeroth-co="show"></span>');
    });
});

describe('For (SSR)', () =>
{
    it('renders each row in order', () =>
    {
        const [items] = createSignal(['a', 'b']);
        const html = renderToString(() => For({ each: items, key: (x) => x, children: (x) => h('li', {}, x) }));
        expect(html).toBe('<span style="display:contents" data-azeroth-co="for"><li>a</li><li>b</li></span>');
    });

    it('exposes a static index getter', () =>
    {
        const [items] = createSignal(['a', 'b']);
        const html = renderToStaticMarkup(() => For({
            each: items,
            key: (_, i) => i,
            children: (item, index) => h('li', {}, () => `${ index() }:${ item }`)
        }));
        expect(html).toBe('<span style="display:contents"><li>0:a</li><li>1:b</li></span>');
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
        expect(build('done')).toBe('<span style="display:contents" data-azeroth-co="switch"><p>done</p></span>');
    });

    it('renders the fallback when nothing matches', () =>
    {
        expect(build('other')).toBe('<span style="display:contents" data-azeroth-co="switch"><p>idle</p></span>');
    });
});

describe('Dynamic (SSR)', () =>
{
    it('renders the resolved component', () =>
    {
        const View = (): HTMLElement => h('section', {}, 'view');
        const html = renderToString(() => Dynamic({ component: () => View }));
        expect(html).toBe('<span style="display:contents" data-azeroth-co="dynamic"><section>view</section></span>');
    });

    it('renders an empty wrapper for a null component', () =>
    {
        const html = renderToString(() => Dynamic({ component: () => null }));
        expect(html).toBe('<span style="display:contents" data-azeroth-co="dynamic"></span>');
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
        expect(html).toBe('<span style="display:contents" data-azeroth-co="suspense"><p>loading</p></span>');
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
        expect(html).toBe('<span style="display:contents" data-azeroth-co="transition"><div class="modal">Hi</div></span>');
        expect(html).not.toContain('fade-enter');
    });
});

describe('Portal (SSR)', () =>
{
    it('renders content inline without touching document.body', () =>
    {
        const html = renderToString(() => Portal({ children: () => h('div', { class: 'modal' }, 'M') }));
        expect(html).toBe('<span style="display:contents" data-azeroth-co="portal"><div class="modal">M</div></span>');
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
        expect(html).toBe('<span style="display:contents" data-azeroth-co="errorboundary"><p>ok</p></span>');
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
        expect(html).toBe('<span style="display:contents" data-azeroth-co="errorboundary"><p>caught: Error: boom</p></span>');
    });
});
