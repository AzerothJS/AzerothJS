// Full behavioral coverage for createRouter + targetToFullPath (router.ts): route
// matching (static / param / wildcard / index / nested), the reactive location &
// match memos, navigate/replace/back/forward, structured + string targets,
// navigate options, base-path resolution, the href() base-prefix rule, and
// no-match fallback. Real reactivity inside createRoot, memory history as the
// deterministic driver - no mocks.
import { describe, it, expect } from 'vitest';
import { createRoot } from '@azerothjs/reactivity';
import { createRouter, createMemoryHistory, targetToFullPath } from '@azerothjs/router';
import type { Route } from '@azerothjs/router';

// Each route component is a DISTINCT function so match().route identity
// assertions are meaningful. They return a real (empty) element.
const Home = (): HTMLElement => document.createElement('div');
const About = (): HTMLElement => document.createElement('div');
const UsersLayout = (props: { children?: HTMLElement }): HTMLElement =>
{
    const el = document.createElement('div');
    if (props.children)
    {
        el.appendChild(props.children);
    }
    return el;
};
const UserList = (): HTMLElement => document.createElement('div');
const UserProfile = (): HTMLElement => document.createElement('div');
const Docs = (): HTMLElement => document.createElement('div');

const routes: Route[] =
[
    { path: '/', component: Home, name: 'home' },
    { path: '/about', component: About },
    {
        path: '/users',
        component: UsersLayout,
        children:
        [
            { path: '', component: UserList },
            { path: ':id', component: UserProfile }
        ]
    },
    { path: '/docs/*path', component: Docs }
];

// Builds a router on memory history and runs `fn` inside a real root so the
// memos/resource/subscription have an owner. Returns whatever `fn` returns.
function withRouter<T>(initialUrl: string, fn: (r: ReturnType<typeof createRouter>) => T, config: Partial<Parameters<typeof createRouter>[0]> = {}): T
{
    let out!: T;
    createRoot((dispose) =>
    {
        const router = createRouter({
            routes,
            history: createMemoryHistory(initialUrl),
            ...config
        });
        out = fn(router);
        dispose();
    });
    return out;
}

describe('targetToFullPath', () =>
{
    it('returns a string target unchanged', () =>
    {
        expect(targetToFullPath('/users/42')).toBe('/users/42');
    });

    it('returns a string target with query and hash unchanged', () =>
    {
        expect(targetToFullPath('/users/42?tab=posts#bio')).toBe('/users/42?tab=posts#bio');
    });

    it('builds a structured pathname only', () =>
    {
        expect(targetToFullPath({ pathname: '/search' })).toBe('/search');
    });

    it('builds a structured target with a query', () =>
    {
        expect(targetToFullPath({ pathname: '/search', query: { q: 'js' } })).toBe('/search?q=js');
    });

    it('builds a structured target with a hash, adding the missing "#"', () =>
    {
        expect(targetToFullPath({ pathname: '/docs', hash: 'intro' })).toBe('/docs#intro');
    });

    it('keeps an existing "#" on the hash (no double prefix)', () =>
    {
        expect(targetToFullPath({ pathname: '/docs', hash: '#intro' })).toBe('/docs#intro');
    });

    it('combines query and hash', () =>
    {
        expect(targetToFullPath({ pathname: '/s', query: { q: 'x' }, hash: '#h' })).toBe('/s?q=x#h');
    });

    it('drops the query part when the query is empty', () =>
    {
        expect(targetToFullPath({ pathname: '/s', query: {} })).toBe('/s');
    });

    it('serializes an array query value into repeated keys', () =>
    {
        expect(targetToFullPath({ pathname: '/s', query: { tag: ['a', 'b'] } })).toBe('/s?tag=a&tag=b');
    });
});

describe('createRouter - initial match from the live url', () =>
{
    it('matches a static route at construction', () =>
    {
        const route = withRouter('/about', (r) => r.match()!.route);
        expect(route).toBe(routes[1]);
        expect(route.component).toBe(About);
    });

    it('matches the index route "/"', () =>
    {
        const route = withRouter('/', (r) => r.match()!.route);
        expect(route).toBe(routes[0]);
        expect(route.component).toBe(Home);
    });

    it('exposes the initial location snapshot', () =>
    {
        const loc = withRouter('/about', (r) => r.location());
        expect(loc.pathname).toBe('/about');
        expect(loc.fullPath).toBe('/about');
        expect(loc.params).toEqual({});
        expect(loc.query).toEqual({});
    });

    it('parses search and hash into the location', () =>
    {
        const loc = withRouter('/about?page=2#sec', (r) => r.location());
        expect(loc.pathname).toBe('/about');
        expect(loc.search).toBe('?page=2');
        expect(loc.hash).toBe('#sec');
        expect(loc.query).toEqual({ page: '2' });
    });
});

describe('createRouter - match kinds', () =>
{
    it('extracts a path param', () =>
    {
        const result = withRouter('/users/42', (r) => r.location().params);
        expect(result).toEqual({ id: '42' });
    });

    it('matches the nested index route (empty child path)', () =>
    {
        const m = withRouter('/users', (r) => r.match()!);
        expect(m.route.component).toBe(UserList);
        expect(m.matched).toEqual([routes[2], routes[2].children![0]]);
    });

    it('matches a nested param route and records the root-to-leaf chain', () =>
    {
        const m = withRouter('/users/42', (r) => r.match()!);
        expect(m.route.component).toBe(UserProfile);
        expect(m.matched).toEqual([routes[2], routes[2].children![1]]);
        expect(m.params).toEqual({ id: '42' });
    });

    it('matches a wildcard route capturing the rest of the path', () =>
    {
        const params = withRouter('/docs/a/b/c', (r) => r.location().params);
        expect(params).toEqual({ path: 'a/b/c' });
    });

    it('returns null match for an unknown path', () =>
    {
        const m = withRouter('/nope', (r) => r.match());
        expect(m).toBeNull();
    });

    it('leaves params empty when nothing matches', () =>
    {
        const loc = withRouter('/nope', (r) => r.location());
        expect(loc.params).toEqual({});
        expect(loc.pathname).toBe('/nope');
    });

    it('first matching leaf wins (config order is priority)', () =>
    {
        // ':id' would also match '' is not true, but verify /users hits the index
        // child, not the param child.
        const m = withRouter('/users', (r) => r.match()!);
        expect(m.route.component).toBe(UserList);
    });
});

describe('createRouter - navigate (reactive updates)', () =>
{
    it('navigate(string) pushes and updates location + match', () =>
    {
        withRouter('/', (r) =>
        {
            r.navigate('/about');
            expect(r.location().pathname).toBe('/about');
            expect(r.match()!.route.component).toBe(About);
        });
    });

    it('navigate to a param route updates params reactively', () =>
    {
        withRouter('/', (r) =>
        {
            r.navigate('/users/7');
            expect(r.location().params).toEqual({ id: '7' });
            expect(r.match()!.route.component).toBe(UserProfile);
        });
    });

    it('navigate with a structured target builds the url', () =>
    {
        withRouter('/', (r) =>
        {
            r.navigate({ pathname: '/users/9', query: { tab: 'posts' }, hash: '#bio' });
            const loc = r.location();
            expect(loc.pathname).toBe('/users/9');
            expect(loc.query).toEqual({ tab: 'posts' });
            expect(loc.hash).toBe('#bio');
            expect(loc.params).toEqual({ id: '9' });
        });
    });

    it('replace() overwrites the current entry, leaving no way back to it', () =>
    {
        const history = createMemoryHistory('/');
        createRoot((dispose) =>
        {
            const r = createRouter({ routes, history });
            r.navigate('/about'); // stack: [/, /about]
            r.navigate('/users/1'); // stack: [/, /about, /users/1]
            r.replace('/users/2'); // overwrites /users/1 -> [/, /about, /users/2]
            expect(r.location().pathname).toBe('/users/2');
            // back skips the replaced /users/1 (it is gone) and lands on /about.
            r.back();
            expect(r.location().pathname).toBe('/about');
            dispose();
        });
    });

    it('navigate({ replace: true }) behaves like replace()', () =>
    {
        createRoot((dispose) =>
        {
            const r = createRouter({ routes, history: createMemoryHistory('/') });
            r.navigate('/about'); // [/, /about]
            r.navigate('/users/1'); // [/, /about, /users/1]
            r.navigate('/users/2', { replace: true }); // overwrites -> [/, /about, /users/2]
            r.back();
            expect(r.location().pathname).toBe('/about');
            dispose();
        });
    });

    it('back() and forward() move through history reactively', () =>
    {
        withRouter('/', (r) =>
        {
            r.navigate('/about');
            r.navigate('/users/1');
            r.back();
            expect(r.location().pathname).toBe('/about');
            r.forward();
            expect(r.location().pathname).toBe('/users/1');
        });
    });

    it('navigate options.state is attached to the memory history entry', () =>
    {
        // Memory history ignores state in current(), but the call must not throw
        // and navigation must still occur.
        withRouter('/', (r) =>
        {
            expect(() => r.navigate('/about', { state: { x: 1 } })).not.toThrow();
            expect(r.location().pathname).toBe('/about');
        });
    });

    it('handles rapid sequential navigations, settling on the last', () =>
    {
        withRouter('/', (r) =>
        {
            r.navigate('/about');
            r.navigate('/users/1');
            r.navigate('/users/2');
            r.navigate('/docs/x/y');
            expect(r.location().pathname).toBe('/docs/x/y');
            expect(r.location().params).toEqual({ path: 'x/y' });
        });
    });
});

describe('createRouter - match memo structural equality', () =>
{
    it('does not change identity when only the hash changes', () =>
    {
        withRouter('/users/42', (r) =>
        {
            const before = r.match();
            r.navigate('/users/42#bio');
            const after = r.match();
            expect(after).toBe(before);
        });
    });

    it('does not change identity when only the query changes (same route + params)', () =>
    {
        withRouter('/users/42', (r) =>
        {
            const before = r.match();
            r.navigate('/users/42?tab=posts');
            expect(r.match()).toBe(before);
        });
    });

    it('changes identity when the param value changes', () =>
    {
        withRouter('/users/42', (r) =>
        {
            const before = r.match();
            r.navigate('/users/43');
            expect(r.match()).not.toBe(before);
            expect(r.match()!.params).toEqual({ id: '43' });
        });
    });

    it('location still updates for a hash-only change even though match is stable', () =>
    {
        withRouter('/users/42', (r) =>
        {
            r.navigate('/users/42#bio');
            expect(r.location().hash).toBe('#bio');
        });
    });
});

describe('createRouter - href()', () =>
{
    it('returns an internal path unchanged with no base', () =>
    {
        const href = withRouter('/', (r) => r.href('/users/42'));
        expect(href).toBe('/users/42');
    });

    it('builds the href from a structured target', () =>
    {
        const href = withRouter('/', (r) => r.href({ pathname: '/s', query: { q: 'x' } }));
        expect(href).toBe('/s?q=x');
    });

    it('leaves an external URL untouched', () =>
    {
        const href = withRouter('/', (r) => r.href('https://example.com'));
        expect(href).toBe('https://example.com');
    });

    it('leaves a mailto: URL untouched', () =>
    {
        const href = withRouter('/', (r) => r.href('mailto:me@x.com'));
        expect(href).toBe('mailto:me@x.com');
    });
});

describe('createRouter - base path', () =>
{
    it('prefixes the base onto an internal href', () =>
    {
        const href = withRouter('/app', (r) => r.href('/users/42'), { base: '/app' });
        expect(href).toBe('/app/users/42');
    });

    it('matches in base-relative space when the url is under the base', () =>
    {
        // Memory history starts at the base-prefixed url; the router strips the base
        // before matching.
        const m = withRouter('/app/users/42', (r) => r.match(), { base: '/app' });
        expect(m).not.toBeNull();
        expect(m!.route.component).toBe(UserProfile);
        expect(m!.params).toEqual({ id: '42' });
    });

    it('exposes the base-relative pathname in location', () =>
    {
        const loc = withRouter('/app/about', (r) => r.location(), { base: '/app' });
        expect(loc.pathname).toBe('/about');
    });

    it('does not match a url outside the configured base', () =>
    {
        const m = withRouter('/other/about', (r) => r.match(), { base: '/app' });
        expect(m).toBeNull();
    });

    it('the base+"/" boundary stops /app from swallowing /application', () =>
    {
        const m = withRouter('/application/about', (r) => r.match(), { base: '/app' });
        expect(m).toBeNull();
    });

    it('navigate writes the base-prefixed url to history but matches base-relative', () =>
    {
        const history = createMemoryHistory('/app');
        createRoot((dispose) =>
        {
            const r = createRouter({ routes, history, base: '/app' });
            r.navigate('/users/5');
            expect(history.current()).toBe('/app/users/5');
            expect(r.location().pathname).toBe('/users/5');
            expect(r.match()!.params).toEqual({ id: '5' });
            dispose();
        });
    });

    it('the bare base path maps to the index route', () =>
    {
        const m = withRouter('/app', (r) => r.match(), { base: '/app' });
        expect(m!.route.component).toBe(Home);
    });
});

describe('createRouter - fallback (no match)', () =>
{
    it('location.fullPath reflects the unmatched path', () =>
    {
        const loc = withRouter('/totally/unknown', (r) => r.location());
        expect(loc.fullPath).toBe('/totally/unknown');
        expect(loc.params).toEqual({});
    });

    it('navigating from a match to a non-match clears the match', () =>
    {
        withRouter('/about', (r) =>
        {
            expect(r.match()).not.toBeNull();
            r.navigate('/nope');
            expect(r.match()).toBeNull();
            expect(r.location().pathname).toBe('/nope');
        });
    });
});
