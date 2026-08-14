// @vitest-environment happy-dom
//
// The document-head runtime: precedence stacks and disposal fallback, title templating,
// escaping per surface with HOSTILE input, hostile-URL refuse-by-drop, hydration adoption,
// client navigation through the route tree, server scope correctness, and the collected
// title winning in renderToDocument.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSignal, createRoot, h, render, hydrate, renderToString, renderToDocument, useHead } from 'azerothjs';
import { createRouter, createMemoryHistory, Routes, Outlet } from 'azerothjs';
import { collectHead, resetHead } from 'azerothjs/internal';
import type { Route, Router, MountNode } from 'azerothjs';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() =>
{
    resetHead();
    document.title = '';
});

function mountApp(routes: Route[], initialUrl: string): { router: Router; container: HTMLElement; cleanup: () => void }
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    let router!: Router;
    render(() =>
    {
        router = createRouter({ routes, history: createMemoryHistory(initialUrl) });
        return h('div', { id: 'app' }, Routes({ router }));
    }, container);
    return {
        router,
        container,
        cleanup: (): void =>
        {
            render(() => h('div', {}), container);
            container.remove();
        }
    };
}

const headMeta = (name: string): HTMLMetaElement | null =>
    document.head.querySelector(`meta[name="${ name }"]`);

describe('precedence stacks (client)', () =>
{
    it('a leaf singleton wins over its layout and FALLS BACK on disposal', async () =>
    {
        const Layout = (props: { children?: MountNode | undefined }): MountNode =>
        {
            useHead({ title: 'Site', meta: [{ name: 'description', content: 'site-wide' }] });
            return h('div', { id: 'layout' }, Outlet({ children: props.children }));
        };
        const routes: Route[] =
        [{
            path: '/p',
            component: Layout,
            children:
            [
                { path: '', component: (): HTMLElement => h('b', { id: 'home' }, 'home') },
                {
                    path: 'x',
                    component: (): HTMLElement =>
                    {
                        useHead({ title: 'Leaf', meta: [{ name: 'description', content: 'leaf-only' }] });
                        return h('span', { id: 'leaf' }, 'x');
                    }
                }
            ]
        }];
        const { router, cleanup } = mountApp(routes, '/p');
        expect(document.title).toBe('Site');
        expect(headMeta('description')?.getAttribute('content')).toBe('site-wide');

        router.navigate('/p/x');
        expect(document.title).toBe('Leaf');
        expect(headMeta('description')?.getAttribute('content')).toBe('leaf-only');
        expect(document.head.querySelectorAll('meta[name="description"]').length).toBe(1);

        router.navigate('/p');
        await flush();
        // Disposal pops; the layout's values are promoted back.
        expect(document.title).toBe('Site');
        expect(headMeta('description')?.getAttribute('content')).toBe('site-wide');
        cleanup();
    });

    it('a SHADOWED entry\'s reactive value firing does not overwrite the winner', async () =>
    {
        const [siteName, setSiteName] = createSignal('Site');
        const Layout = (props: { children?: MountNode | undefined }): MountNode =>
        {
            // Both faces of the shadow: the title (whose shared owner re-derives the
            // winner structurally) AND a keyed META, whose element write is what the
            // winner gate actually protects - a stripped gate lets this shadowed
            // getter write ITS content over the leaf's.
            useHead({
                title: () => siteName(),
                meta: [{ name: 'description', content: () => `about ${ siteName() }` }]
            });
            return h('div', { id: 'layout' }, Outlet({ children: props.children }));
        };
        const routes: Route[] =
        [{
            path: '/p',
            component: Layout,
            children:
            [{
                path: '',
                component: (): HTMLElement =>
                {
                    useHead({ title: 'Pinned', meta: [{ name: 'description', content: 'leaf description' }] });
                    return h('b', {}, 'home');
                }
            }]
        }];
        const { cleanup } = mountApp(routes, '/p');
        expect(document.title).toBe('Pinned');
        expect(headMeta('description')?.getAttribute('content')).toBe('leaf description');

        // The shadowed layout's getters fire: the winner gate must hold on BOTH keys.
        setSiteName('Renamed Site');
        await flush();
        expect(document.title).toBe('Pinned');
        expect(headMeta('description')?.getAttribute('content')).toBe('leaf description');
        cleanup();
    });

    it('the winner\'s reactive value updates in place, and empty stacks restore the boot title', async () =>
    {
        document.title = 'Boot';
        const [name, setName] = createSignal('One');
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            useHead({ title: () => name() });
        });
        expect(document.title).toBe('One');

        setName('Two');
        await flush();
        expect(document.title).toBe('Two');

        dispose();
        expect(document.title).toBe('Boot');
    });

    it('multi-valued alternates dedup by identity and dispose by refcount', () =>
    {
        let disposeA!: () => void;
        let disposeB!: () => void;
        createRoot((d) =>
        {
            disposeA = d;
            useHead({ links: [{ rel: 'alternate', hreflang: 'de', href: '/de' }] });
        });
        createRoot((d) =>
        {
            disposeB = d;
            useHead({ links: [{ rel: 'alternate', hreflang: 'de', href: '/de' }] });
        });
        expect(document.head.querySelectorAll('link[rel="alternate"]').length).toBe(1);

        disposeA();
        expect(document.head.querySelectorAll('link[rel="alternate"]').length).toBe(1);
        disposeB();
        expect(document.head.querySelectorAll('link[rel="alternate"]').length).toBe(0);
    });
});

describe('title templating', () =>
{
    it('composes a deeper title through a layout template; same-entry suppresses; %s escapes', async () =>
    {
        const Layout = (props: { children?: MountNode | undefined }): MountNode =>
        {
            useHead({ titleTemplate: '%s - Site', title: 'Site' });
            return h('div', {}, Outlet({ children: props.children }));
        };
        const Plain = (): HTMLElement =>
        {
            useHead({ title: 'Users' });
            return h('b', { id: 'u' }, 'u');
        };
        const Escaping = (): HTMLElement =>
        {
            useHead({ titleTemplate: '%s', title: 'Standalone' });
            return h('b', { id: 'e' }, 'e');
        };
        const routes: Route[] =
        [{
            path: '/p',
            component: Layout,
            children:
            [
                { path: '', component: (): HTMLElement => h('i', {}, 'idx') },
                { path: 'users', component: Plain },
                { path: 'esc', component: Escaping }
            ]
        }];
        const { router, cleanup } = mountApp(routes, '/p');
        // Same-entry suppression: the layout's own title renders BARE.
        expect(document.title).toBe('Site');

        router.navigate('/p/users');
        expect(document.title).toBe('Users - Site');

        router.navigate('/p/esc');
        // The identity template wins as the deepest singleton: the ancestor template
        // is escaped. Same-entry suppression applies to the leaf's own pair, so the
        // leaf title renders bare - which IS the escape.
        expect(document.title).toBe('Standalone');

        router.navigate('/p/users');
        expect(document.title).toBe('Users - Site');
        await flush();
        cleanup();
    });

    it('a title containing $-patterns survives template substitution literally', () =>
    {
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            useHead({ titleTemplate: '%s - Site' });
            useHead({ title: "$& $' $$ price" });
        });
        expect(document.title).toBe("$& $' $$ price - Site");
        dispose();
    });
});

describe('escaping per surface (server, HOSTILE input)', () =>
{
    it('title breakout, meta quotes, and JSON-LD script content are all neutralized', () =>
    {
        const html = renderToString(() =>
        {
            useHead({
                title: '</title><script>alert(1)</script>',
                meta: [{ name: 'description', content: '"/><script>x</script>' }],
                jsonLd: { '@type': 'Person', name: 'a</script><script>b', note: '<!--' }
            });
            return h('div', {}, 'page');
        });
        void html;
        const collected = collectHead();

        expect(collected.titleText).not.toContain('<script');
        expect(collected.titleText).toContain('&lt;/title&gt;');
        const description = collected.replacements.find((r) => r.value === 'description');
        expect(description).toBeDefined();
        expect(description?.html).not.toContain('"/><script>');
        expect(description?.html).toContain('&quot;');
        // The inert-JSON rule: no literal '<' survives inside the ld+json block.
        const jsonBody = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(collected.additions)?.[1] ?? '';
        expect(jsonBody).not.toContain('<');
        expect(jsonBody).toContain('\\u003c');
    });

    it('a hostile javascript: href is DROPPED with a DEV diagnostic; the render succeeds', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            renderToString(() =>
            {

                useHead({ links: [{ rel: 'canonical', href: 'javascript:alert(1)' }] });
                return h('div', {}, 'page');
            });
            const collected = collectHead();
            expect(collected.replacements.find((r) => r.value === 'canonical')).toBeUndefined();
            expect(collected.additions).not.toContain('javascript:');
            expect(warn.mock.calls.some((c) => /DROPPED/.test(String(c[0])))).toBe(true);
        }
        finally
        {
            warn.mockRestore();
        }
    });

    it('the client face drops the same hostile URL without touching the head', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            let dispose!: () => void;
            createRoot((d) =>
            {
                dispose = d;

                useHead({ links: [{ rel: 'preconnect', href: 'javascript:alert(1)' }] });
            });
            expect(document.head.querySelector('link[rel="preconnect"]')).toBeNull();
            expect(warn.mock.calls.some((c) => /DROPPED/.test(String(c[0])))).toBe(true);
            dispose();
        }
        finally
        {
            warn.mockRestore();
        }
    });
});

describe('server scope correctness and the frame', () =>
{
    it('two sequential renders resolve their OWN values; a writer-less collect after a clean render is empty', () =>
    {
        renderToString(() =>
        {
            useHead({ title: 'First' });
            return h('div', {}, 'a');
        });
        const first = collectHead();
        expect(first.title).toBe('First');

        renderToString(() =>
        {
            useHead({ title: 'Second' });
            return h('div', {}, 'b');
        });
        const second = collectHead();
        expect(second.title).toBe('Second');

        renderToString(() => h('div', {}, 'plain'));
        const third = collectHead();
        expect(third.title).toBeNull();
        expect(third.additions).toBe('');
    });

    it('a render that THROWS after useHead does not leak into the next collect', () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try
        {
            expect(() => renderToString(() =>
            {
                useHead({ title: 'Doomed' });
                throw new Error('render died');
            })).toThrow('render died');

            renderToString(() => h('div', {}, 'clean'));
            const collected = collectHead();
            expect(collected.title).toBeNull();
        }
        finally
        {
            warn.mockRestore();
        }
    });
});

describe('hydration adoption', () =>
{
    it('adopts server-marked elements by key: one element per key, identity preserved', async () =>
    {
        const App = (): HTMLElement =>
        {
            useHead({
                title: 'Hydrated',
                meta: [{ name: 'description', content: 'adopted' }],
                jsonLd: { '@type': 'Thing', name: 'x' }
            });
            return h('main', { id: 'app-root' }, 'content');
        };

        // Server: emit the marked elements into the live document head, as a shell would carry them.
        renderToString(() => App());
        const collected = collectHead();
        const holder = document.createElement('div');
        holder.innerHTML = collected.additions + collected.replacements.map((r) => r.html).join('');
        for (const el of [...holder.children])
        {
            document.head.appendChild(el);
        }
        const serverMeta = headMeta('description');
        const serverJson = document.head.querySelector('script[data-azeroth-head="jsonld"]');
        expect(serverMeta).not.toBeNull();

        const container = document.createElement('div');
        container.innerHTML = '<main id="app-root">content</main>';
        document.body.appendChild(container);
        hydrate(() => App(), container);
        await flush();

        expect(document.head.querySelectorAll('meta[name="description"]').length).toBe(1);
        expect(headMeta('description')).toBe(serverMeta);
        expect(document.head.querySelectorAll('script[data-azeroth-head="jsonld"]').length).toBe(1);
        expect(document.head.querySelector('script[data-azeroth-head="jsonld"]')).toBe(serverJson);
        expect(document.title).toBe('Hydrated');
        render(() => h('div', {}), container);
        container.remove();
    });
});

describe('renderToDocument', () =>
{
    it('a collected title WINS over options.title; additions join the head', () =>
    {
        const html = renderToDocument(() =>
        {
            useHead({ title: 'Collected', links: [{ rel: 'preconnect', href: 'https://cdn.example' }] });
            return h('div', {}, 'x');
        }, { title: 'Static Fallback' });

        expect(html).toContain('<title data-azeroth-head="title">Collected</title>');
        expect(html).not.toContain('Static Fallback');
        expect(html).toContain('rel="preconnect"');
    });

    it('without a collected title, options.title stands', () =>
    {
        const html = renderToDocument(() => h('div', {}, 'x'), { title: 'Static' });
        expect(html).toContain('<title>Static</title>');
    });
});

describe('loading and error cases', () =>
{
    it('a client navigation with an in-flight loader shows the declared fallback, then the settled value in place', async () =>
    {
        const { useLoader } = await import('azerothjs');
        const Layout = (props: { children?: MountNode | undefined }): MountNode =>
            h('div', { id: 'layout' }, Outlet({ children: props.children }));
        const Leaf = (): HTMLElement =>
        {
            const data = useLoader<string>();
            useHead({ title: () => data.data() ?? 'Loading' });
            return h('span', { id: 'leaf' }, 'x');
        };
        const routes: Route[] =
        [{
            path: '/p',
            component: Layout,
            children:
            [
                { path: '', component: (): HTMLElement => h('b', {}, 'home') },
                { path: 'user', component: Leaf, loader: async () => 'Settled Name' }
            ]
        }];
        const { router, cleanup } = mountApp(routes, '/p');

        router.navigate('/p/user');
        expect(document.title).toBe('Loading');
        await flush();
        expect(document.title).toBe('Settled Name');
        cleanup();
    });

    it('an ErrorBoundary-caught leaf leaves the layout\'s head values standing', async () =>
    {
        const { ErrorBoundary } = await import('azerothjs');
        const Layout = (props: { children?: MountNode | undefined }): MountNode =>
        {
            useHead({ title: 'Site' });
            return h('div', { id: 'layout' },
                ErrorBoundary({
                    fallback: () => h('div', { id: 'caught' }, 'error'),
                    children: () => Outlet({ children: props.children })
                }));
        };
        const Exploding = (): HTMLElement =>
        {
            useHead({ title: 'Doomed' });
            throw new Error('leaf died');
        };
        const routes: Route[] =
        [{
            path: '/p',
            component: Layout,
            children: [{ path: '', component: Exploding }]
        }];
        const { container, cleanup } = mountApp(routes, '/p');
        await flush();

        expect(container.querySelector('#caught')).not.toBeNull();
        // The degraded head: the leaf's entry died with its construction root.
        expect(document.title).toBe('Site');
        cleanup();
    });
});

describe('registration-time resolution (the scope probe)', () =>
{
    it('a title getter reading a SCOPED store resolves against the request\'s own scope', async () =>
    {
        const { createStore } = await import('azerothjs');
        const profile = createStore(() => ({ name: 'unset' }));

        renderToString(() =>
        {
            profile().name = 'Request A';
            useHead({ title: () => profile().name });
            return h('div', {}, 'a');
        });
        const first = collectHead();

        renderToString(() =>
        {
            profile().name = 'Request B';
            useHead({ title: () => profile().name });
            return h('div', {}, 'b');
        });
        const second = collectHead();

        // Registration-time resolution inside the request scope: each render sees its
        // OWN store instance. Collect-time resolution would read the DEFAULT scope
        // ('unset') - the failure shape a collect-time regression produces.
        expect(first.title).toBe('Request A');
        expect(second.title).toBe('Request B');
    });
});

describe('vocabulary rules', () =>
{
    it('the repeatable-OG allowlist is multi; other og properties stay singletons; server jsonLd dedups by identity', () =>
    {
        renderToString(() =>
        {
            useHead({
                meta: [
                    { property: 'og:image', content: 'https://x/1.png' },
                    { property: 'og:image', content: 'https://x/2.png' },
                    { property: 'article:tag', content: 'a' },
                    { property: 'article:tag', content: 'b' },
                    { property: 'og:type', content: 'article' },
                    { property: 'og:type', content: 'website' }
                ],
                jsonLd: { '@type': 'Organization', name: 'Shared' }
            });
            useHead({ jsonLd: { '@type': 'Organization', name: 'Shared' } });
            return h('div', {}, 'x');
        });
        const collected = collectHead();

        expect((collected.additions.match(/property="og:image"/g) ?? []).length).toBe(2);
        expect((collected.additions.match(/property="article:tag"/g) ?? []).length).toBe(2);
        // og:type: singleton per property, within-one-call LAST wins.
        const ogType = collected.replacements.filter((r) => r.value === 'og:type');
        expect(ogType.length).toBe(1);
        expect(ogType[0]?.html).toContain('website');
        // One Organization block, not two (the client refcounts the same identity).
        expect((collected.additions.match(/application\/ld\+json/g) ?? []).length).toBe(1);
    });

    it('manifest is a singleton: the deeper declaration wins', () =>
    {
        renderToString(() =>
        {
            useHead({ links: [{ rel: 'manifest', href: '/site.webmanifest' }] });
            useHead({ links: [{ rel: 'manifest', href: '/deep.webmanifest' }] });
            return h('div', {}, 'x');
        });
        const collected = collectHead();
        const manifests = collected.replacements.filter((r) => r.value === 'manifest');
        expect(manifests.length).toBe(1);
        expect(manifests[0]?.html).toContain('/deep.webmanifest');
    });
});

describe('title restore precedence', () =>
{
    it('an empty title stack restores WITHOUT a live template; the stamped shell base wins over the boot capture', async () =>
    {
        document.title = 'BootCaptured';
        const stamped = document.createElement('title');
        stamped.setAttribute('data-azeroth-title-base', 'Shell Base');
        document.head.appendChild(stamped);
        try
        {
            let disposeTemplate!: () => void;
            let disposeTitle!: () => void;
            createRoot((d) =>
            {
                disposeTemplate = d;
                useHead({ titleTemplate: '%s - Site' });
            });
            createRoot((d) =>
            {
                disposeTitle = d;
                useHead({ title: 'Page' });
            });
            expect(document.title).toBe('Page - Site');

            // The title stack empties while the TEMPLATE stays live: the restored
            // shell base must NOT feed through it.
            disposeTitle();
            expect(document.title).toBe('Shell Base');
            disposeTemplate();
            await flush();
        }
        finally
        {
            stamped.remove();
        }
    });
});
