// @vitest-environment node
//
// The guard-veto authorization bypass, driven end to end through the REAL
// createPageRenderer + a REAL createRouter/Routes app (not a fake renderer). A
// route whose guard returns `false` must NEVER render its protected component into
// the SSR document - it must surface as a distinct blocked result the server answers
// with a 403. Regression lock for the SSR auth bypass.
import { describe, expect, it } from 'vitest';

import { RouterProvider, Routes, createMemoryHistory, createRouter, h } from 'azerothjs';
import type { LoaderHandoff, Route } from 'azerothjs';
import { createPageRenderer } from '@azerothjs/kit/ssr';

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';

const routes: Route[] = [
    { path: '/', component: () => h('h1', {}, 'home') },
    {
        path: '/admin',
        component: () => h('div', { id: 'admin' }, 'SECRET ADMIN PANEL - user list, tokens'),
        guard: () => false
    }
];

const App = (props: { url?: string; handoff?: LoaderHandoff }): HTMLElement =>
    RouterProvider({
        router: createRouter({ routes, history: createMemoryHistory(props.url ?? '/'), initialLoaderData: props.handoff }),
        children: () => Routes({ fallback: () => h('h1', {}, 'not found') })
    }) as HTMLElement;

describe('guard veto through createPageRenderer', () =>
{
    const render = createPageRenderer(App, routes);

    it('a vetoing guard yields a blocked result, NOT a rendered 200 page', async () =>
    {
        const result = await render('/admin', SHELL);
        expect(result.kind).toBe('blocked');
        if (result.kind === 'blocked')
        {
            expect(result.status).toBe(403);
        }
        // The protected component's text must appear NOWHERE in any served representation.
        expect(JSON.stringify(result)).not.toContain('SECRET ADMIN PANEL');
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
