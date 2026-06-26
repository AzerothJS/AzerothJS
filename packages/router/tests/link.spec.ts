// Full behavioral coverage for <Link> (link.ts): the rendered real <a href>, the
// click-interception bail-out table (modifier / middle-click / target!=_self /
// external / upstream preventDefault), SPA navigation via the router, replace,
// active-class + aria-current reactivity, and attribute pass-through. Real DOM
// dispatch through happy-dom; a real router on memory history - no mocks.
import { describe, it, expect } from 'vitest';
import { createRoot } from '@azerothjs/reactivity';
import { render } from '@azerothjs/renderer';
import { createRouter, createMemoryHistory, Link } from '@azerothjs/router';
import type { Route } from '@azerothjs/router';

const leaf = (): HTMLElement => document.createElement('div');

const routes: Route[] =
[
    { path: '/', component: leaf },
    { path: '/about', component: leaf },
    { path: '/users/:id', component: leaf }
];

function makeRouter(initialUrl = '/', base?: string): { router: ReturnType<typeof createRouter>; dispose: () => void }
{
    let router!: ReturnType<typeof createRouter>;
    let dispose!: () => void;
    createRoot((d) =>
    {
        dispose = d;
        router = createRouter({ routes, history: createMemoryHistory(initialUrl), base });
    });
    return { router, dispose };
}

// Mounts a built link element into the document so events bubble realistically,
// then returns the <a> and a teardown.
function mountLink(build: () => HTMLElement): { anchor: HTMLAnchorElement; container: HTMLElement }
{
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(build, container);
    const anchor = container.querySelector('a')!;
    return { anchor, container };
}

function leftClick(): MouseEvent
{
    return new MouseEvent('click', { button: 0, cancelable: true, bubbles: true });
}

// Dispatches a click and returns whether the Link intercepted it (i.e. called
// preventDefault). A trailing listener - registered AFTER the Link handler, so it
// runs last - records the prevented state the Link left behind, then cancels any
// remaining default so happy-dom never attempts a real network navigation. The
// recorded flag reflects exactly what the Link did, untouched by this guard.
function dispatchClick(anchor: HTMLAnchorElement, ev: MouseEvent): boolean
{
    let interceptedByLink = false;
    const guard = (e: Event): void =>
    {
        interceptedByLink = e.defaultPrevented;
        e.preventDefault();
    };
    anchor.addEventListener('click', guard);
    anchor.dispatchEvent(ev);
    anchor.removeEventListener('click', guard);
    return interceptedByLink;
}

describe('Link — rendered anchor', () =>
{
    it('renders a real <a> with the resolved href', () =>
    {
        const { router, dispose } = makeRouter();
        const { anchor, container } = mountLink(() => Link({ to: '/about', router, children: 'About' }));
        expect(anchor.tagName).toBe('A');
        expect(anchor.getAttribute('href')).toBe('/about');
        expect(anchor.textContent).toBe('About');
        container.remove();
        dispose();
    });

    it('builds the href from a structured target', () =>
    {
        const { router, dispose } = makeRouter();
        const { anchor, container } = mountLink(() =>
            Link({ to: { pathname: '/users/42', query: { tab: 'posts' } }, router, children: 'U' }));
        expect(anchor.getAttribute('href')).toBe('/users/42?tab=posts');
        container.remove();
        dispose();
    });

    it('applies the base prefix to the rendered href', () =>
    {
        const { router, dispose } = makeRouter('/app', '/app');
        const { anchor, container } = mountLink(() => Link({ to: '/about', router, children: 'A' }));
        expect(anchor.getAttribute('href')).toBe('/app/about');
        container.remove();
        dispose();
    });

    it('passes through arbitrary anchor attributes (id, data-*)', () =>
    {
        const { router, dispose } = makeRouter();
        const { anchor, container } = mountLink(() =>
            Link({ to: '/about', router, id: 'nav-about', 'data-test': 'x', children: 'A' }));
        expect(anchor.id).toBe('nav-about');
        expect(anchor.getAttribute('data-test')).toBe('x');
        container.remove();
        dispose();
    });

    it('does not leak own props (to/router/replace) onto the element', () =>
    {
        const { router, dispose } = makeRouter();
        const { anchor, container } = mountLink(() => Link({ to: '/about', router, replace: true, children: 'A' }));
        expect(anchor.getAttribute('to')).toBeNull();
        expect(anchor.getAttribute('router')).toBeNull();
        expect(anchor.getAttribute('replace')).toBeNull();
        container.remove();
        dispose();
    });
});

describe('Link — click interception', () =>
{
    it('a plain left click navigates through the router and is prevented', () =>
    {
        const { router, dispose } = makeRouter('/');
        const { anchor, container } = mountLink(() => Link({ to: '/about', router, children: 'A' }));
        const intercepted = dispatchClick(anchor, leftClick());
        expect(intercepted).toBe(true);
        expect(router.location().pathname).toBe('/about');
        container.remove();
        dispose();
    });

    it('navigates to a structured target and updates params', () =>
    {
        const { router, dispose } = makeRouter('/');
        const { anchor, container } = mountLink(() =>
            Link({ to: { pathname: '/users/7' }, router, children: 'U' }));
        dispatchClick(anchor, leftClick());
        expect(router.location().pathname).toBe('/users/7');
        expect(router.location().params).toEqual({ id: '7' });
        container.remove();
        dispose();
    });

    it('replace=true replaces instead of pushing', () =>
    {
        const history = createMemoryHistory('/');
        let router!: ReturnType<typeof createRouter>;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            router = createRouter({ routes, history });
        });
        // Seed a back entry first.
        router.navigate('/users/1');
        const { anchor, container } = mountLink(() => Link({ to: '/about', router, replace: true, children: 'A' }));
        dispatchClick(anchor, leftClick());
        expect(router.location().pathname).toBe('/about');
        // /users/1 was overwritten; back lands on the initial '/'.
        router.back();
        expect(router.location().pathname).toBe('/');
        container.remove();
        dispose();
    });

    it('a ctrl-click is NOT intercepted (new tab)', () =>
    {
        const { router, dispose } = makeRouter('/');
        const { anchor, container } = mountLink(() => Link({ to: '/about', router, children: 'A' }));
        const ev = new MouseEvent('click', { button: 0, ctrlKey: true, cancelable: true, bubbles: true });
        const intercepted = dispatchClick(anchor, ev);
        expect(intercepted).toBe(false);
        expect(router.location().pathname).toBe('/');
        container.remove();
        dispose();
    });

    it('a meta-click is NOT intercepted', () =>
    {
        const { router, dispose } = makeRouter('/');
        const { anchor, container } = mountLink(() => Link({ to: '/about', router, children: 'A' }));
        const ev = new MouseEvent('click', { button: 0, metaKey: true, cancelable: true, bubbles: true });
        const intercepted = dispatchClick(anchor, ev);
        expect(intercepted).toBe(false);
        expect(router.location().pathname).toBe('/');
        container.remove();
        dispose();
    });

    it('a shift-click is NOT intercepted', () =>
    {
        const { router, dispose } = makeRouter('/');
        const { anchor, container } = mountLink(() => Link({ to: '/about', router, children: 'A' }));
        const ev = new MouseEvent('click', { button: 0, shiftKey: true, cancelable: true, bubbles: true });
        const intercepted = dispatchClick(anchor, ev);
        expect(intercepted).toBe(false);
        expect(router.location().pathname).toBe('/');
        container.remove();
        dispose();
    });

    it('a middle-click (button !== 0) is NOT intercepted', () =>
    {
        const { router, dispose } = makeRouter('/');
        const { anchor, container } = mountLink(() => Link({ to: '/about', router, children: 'A' }));
        const ev = new MouseEvent('click', { button: 1, cancelable: true, bubbles: true });
        const intercepted = dispatchClick(anchor, ev);
        expect(intercepted).toBe(false);
        expect(router.location().pathname).toBe('/');
        container.remove();
        dispose();
    });

    it('target="_blank" is NOT intercepted', () =>
    {
        const { router, dispose } = makeRouter('/');
        const { anchor, container } = mountLink(() =>
            Link({ to: '/about', router, target: '_blank', children: 'A' }));
        expect(anchor.getAttribute('target')).toBe('_blank');
        const intercepted = dispatchClick(anchor, leftClick());
        expect(intercepted).toBe(false);
        expect(router.location().pathname).toBe('/');
        container.remove();
        dispose();
    });

    it('target="_self" IS intercepted', () =>
    {
        const { router, dispose } = makeRouter('/');
        const { anchor, container } = mountLink(() =>
            Link({ to: '/about', router, target: '_self', children: 'A' }));
        const intercepted = dispatchClick(anchor, leftClick());
        expect(intercepted).toBe(true);
        expect(router.location().pathname).toBe('/about');
        container.remove();
        dispose();
    });

    it('an external URL is NOT intercepted', () =>
    {
        const { router, dispose } = makeRouter('/');
        const { anchor, container } = mountLink(() =>
            Link({ to: 'https://example.com', router, children: 'Ext' }));
        expect(anchor.getAttribute('href')).toBe('https://example.com');
        const intercepted = dispatchClick(anchor, leftClick());
        expect(intercepted).toBe(false);
        expect(router.location().pathname).toBe('/');
        container.remove();
        dispose();
    });

    it('the user onClick runs before interception and can cancel navigation', () =>
    {
        const { router, dispose } = makeRouter('/');
        const calls: string[] = [];
        const { anchor, container } = mountLink(() =>
            Link({
                to: '/about',
                router,
                onClick: (e) =>
                {
                    calls.push('user');
                    e.preventDefault();
                },
                children: 'A'
            }));
        dispatchClick(anchor, leftClick());
        expect(calls).toEqual(['user']);
        // preventDefault in the user handler suppresses navigation entirely.
        expect(router.location().pathname).toBe('/');
        container.remove();
        dispose();
    });

    it('the user onClick runs even when navigation proceeds', () =>
    {
        const { router, dispose } = makeRouter('/');
        const calls: string[] = [];
        const { anchor, container } = mountLink(() =>
            Link({ to: '/about', router, onClick: () => calls.push('user'), children: 'A' }));
        dispatchClick(anchor, leftClick());
        expect(calls).toEqual(['user']);
        expect(router.location().pathname).toBe('/about');
        container.remove();
        dispose();
    });
});

describe('Link — active class & aria-current', () =>
{
    it('applies activeClass when the link pathname matches the current location', () =>
    {
        const { router, dispose } = makeRouter('/about');
        const { anchor, container } = mountLink(() =>
            Link({ to: '/about', router, activeClass: 'is-active', children: 'A' }));
        expect(anchor.classList.contains('is-active')).toBe(true);
        expect(anchor.getAttribute('aria-current')).toBe('page');
        container.remove();
        dispose();
    });

    it('omits activeClass when the link pathname does not match', () =>
    {
        const { router, dispose } = makeRouter('/');
        const { anchor, container } = mountLink(() =>
            Link({ to: '/about', router, activeClass: 'is-active', children: 'A' }));
        expect(anchor.classList.contains('is-active')).toBe(false);
        expect(anchor.getAttribute('aria-current')).toBeNull();
        container.remove();
        dispose();
    });

    it('toggles activeClass reactively as the location changes', () =>
    {
        const { router, dispose } = makeRouter('/');
        const { anchor, container } = mountLink(() =>
            Link({ to: '/about', router, activeClass: 'is-active', children: 'A' }));
        expect(anchor.classList.contains('is-active')).toBe(false);

        router.navigate('/about');
        expect(anchor.classList.contains('is-active')).toBe(true);
        expect(anchor.getAttribute('aria-current')).toBe('page');

        router.navigate('/');
        expect(anchor.classList.contains('is-active')).toBe(false);
        expect(anchor.getAttribute('aria-current')).toBeNull();
        container.remove();
        dispose();
    });

    it('merges activeClass with a user-provided base class', () =>
    {
        const { router, dispose } = makeRouter('/about');
        const { anchor, container } = mountLink(() =>
            Link({ to: '/about', router, class: 'nav-link', activeClass: 'is-active', children: 'A' }));
        expect(anchor.classList.contains('nav-link')).toBe(true);
        expect(anchor.classList.contains('is-active')).toBe(true);
        container.remove();
        dispose();
    });

    it('active matching is path-level: query/hash on the location do not break it', () =>
    {
        const { router, dispose } = makeRouter('/about');
        const { anchor, container } = mountLink(() =>
            Link({ to: '/about', router, activeClass: 'is-active', children: 'A' }));
        router.navigate('/about?tab=x#h');
        expect(anchor.classList.contains('is-active')).toBe(true);
        container.remove();
        dispose();
    });
});
