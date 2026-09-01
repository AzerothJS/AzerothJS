// @vitest-environment node
//
// The guard-veto authorization bypass, driven end to end through the REAL
// createPageRenderer + a REAL createRouter/Routes app (not a fake renderer). A
// route whose guard denies must NEVER render its protected component into the SSR
// document - it surfaces as a distinct blocked result the server answers with the
// guard's status, carrying the app's own blocked UI. Regression lock for the SSR
// auth bypass.
import { describe, expect, it } from 'vitest';

import { RouterProvider, Routes, createMemoryHistory, createRouter, forbidden, h, unauthorized } from 'azerothjs';
import type { LoaderHandoff, Route } from 'azerothjs';
import { createPageRenderer } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';

const SECRET = 'SECRET ADMIN PANEL - user list, tokens';

let signedIn = false;

const routes: Route[] = [
    { path: '/', component: () => h('h1', {}, 'home') },
    {
        path: '/admin',
        component: () => h('div', { id: 'admin' }, SECRET),
        guard: () => false
    },
    {
        path: '/account',
        component: () => h('div', { id: 'account' }, SECRET),
        guard: () => (signedIn ? forbidden() : unauthorized())
    }
];

const view = (props: { url?: string; handoff?: LoaderHandoff }, forwardHandoff: boolean): HTMLElement =>
    RouterProvider({
        router: createRouter({
            routes,
            history: createMemoryHistory(props.url ?? '/'),
            ...(forwardHandoff ? { initialLoaderData: props.handoff } : {})
        }),
        children: () => Routes({
            fallback: () => h('h1', {}, 'not found'),
            blocked: (state) => h('h1', { id: 'blocked' }, `NO ACCESS ${ state.status }`)
        })
    }) as HTMLElement;

const App = (props: { url?: string; handoff?: LoaderHandoff }): HTMLElement => view(props, true);

/** An entry that never forwards the handoff - the case the render-time pin exists for. */
const ForgetfulApp = (props: { url?: string; handoff?: LoaderHandoff }): HTMLElement => view(props, false);

describe('guard veto through createPageRenderer', () =>
{
    const render = createPageRenderer(App, routes);

    it('a vetoing guard yields a blocked result carrying the app UI, NOT the protected page', async () =>
    {
        const result = await render('/admin', SHELL);
        expect(result.kind).toBe('blocked');
        if (result.kind === 'blocked')
        {
            expect(result.status).toBe(403);
            expect(result.html).toContain('NO ACCESS 403');
        }
        // The protected component's text must appear NOWHERE in any served representation.
        expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it('unauthorized() and forbidden() answer with their own status', async () =>
    {
        signedIn = false;
        const anonymous = await render('/account', SHELL);
        expect(anonymous.kind).toBe('blocked');
        if (anonymous.kind === 'blocked')
        {
            expect(anonymous.status).toBe(401);
            expect(anonymous.html).toContain('NO ACCESS 401');
        }

        signedIn = true;
        const wrongRole = await render('/account', SHELL);
        expect(wrongRole.kind).toBe('blocked');
        if (wrongRole.kind === 'blocked')
        {
            expect(wrongRole.status).toBe(403);
            expect(wrongRole.html).toContain('NO ACCESS 403');
        }
        expect(JSON.stringify([anonymous, wrongRole])).not.toContain(SECRET);
        signedIn = false;
    });

    it('the handoff carries the denial, so a hydrating client starts blocked', async () =>
    {
        const result = await render('/admin', SHELL);
        expect(result.kind).toBe('blocked');
        if (result.kind !== 'blocked')
        {
            return;
        }
        const payload = /id="__azeroth-loader-handoff">([^<]*)</.exec(result.html)?.[1];
        expect(payload).toBeDefined();
        expect(JSON.parse(payload as string)).toMatchObject({ path: '/admin', denied: 403 });
    });

    // The pin, not the prop, is what closes the bypass: string-mode rendering does not re-run
    // guards, so an entry that drops `handoff` would otherwise serialize the protected chain
    // inside the 403.
    it('holds even when the app entry never forwards the handoff', async () =>
    {
        const forgetful = createPageRenderer(ForgetfulApp, routes);
        const result = await forgetful('/admin', SHELL);
        expect(result.kind).toBe('blocked');
        expect(JSON.stringify(result)).not.toContain(SECRET);
        if (result.kind === 'blocked')
        {
            expect(result.html).toContain('NO ACCESS 403');
        }
    });

    it('an authorized route still renders normally', async () =>
    {
        const result = await render('/', SHELL);
        expect(result.kind).toBe('html');
        if (result.kind === 'html')
        {
            expect(result.status).toBe(200);
            expect(result.html).toContain('home');
        }
    });

    it('an unmatched url renders the fallback UI with a real 404 status', async () =>
    {
        const result = await render('/does-not-exist', SHELL);
        expect(result.kind).toBe('html');
        if (result.kind === 'html')
        {
            expect(result.status).toBe(404);
            expect(result.html).toContain('not found');
        }
    });
});
