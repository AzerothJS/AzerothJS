// <Form>'s enhanced submit understands exactly three answers as the action's own. Everything
// else is a refusal by the server that never reached validation, and the arms here pin what
// that means for the page: the last validation verdict stays on screen, the caller hears a bare
// `{ ok: false }`, and the status is reported once. A redirect answer navigates.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Form, RouterProvider, Routes, createMemoryHistory, createRouter, h, render } from 'azerothjs';
import type { Router } from 'azerothjs';

interface Outcome { ok: boolean; result?: unknown; redirect?: string }

interface Mounted
{
    router: Router;
    form: HTMLFormElement;
    settled: Outcome[];
}

function mountForm(priorResult: unknown): Mounted
{
    const settled: Outcome[] = [];
    const routes = [
        { path: '/todos', component: (): HTMLElement => Form({ onSettled: (outcome: Outcome) => settled.push(outcome), children: h('button', { type: 'submit' }, 'go') }) as HTMLElement },
        { path: '/signed-in', component: (): HTMLElement => h('p', { id: 'signed-in' }, 'in') }
    ];
    const router = createRouter({
        routes,
        history: createMemoryHistory('/todos'),
        initialLoaderData: { version: 4, path: '/todos', data: [], action: priorResult }
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(() => RouterProvider({ router, children: () => Routes({ fallback: () => h('p', {}, 'nf') }) }), host);
    return { router, form: host.querySelector('form') as HTMLFormElement, settled };
}

async function submitWith(response: Response, priorResult: unknown = { fields: { text: 'PRIOR' } }): Promise<Mounted & { log: string[]; fetches: number }>
{
    const fetchSpy = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchSpy);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mounted = mountForm(priorResult);
    mounted.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(mounted.settled.length + (errorSpy.mock.calls.length > 0 ? 1 : 0)).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const log = errorSpy.mock.calls.map((call) => String(call[0]));
    errorSpy.mockRestore();
    return { ...mounted, log, fetches: fetchSpy.mock.calls.length };
}

afterEach(() =>
{
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('<Form> on a server refusal that never reached validation', () =>
{
    it('a 403 envelope settles a bare { ok: false }, keeps the prior verdict, and names the status once', async () =>
    {
        const out = await submitWith(new Response(JSON.stringify({ error: { code: 'forbidden', message: 'no' } }), { status: 403, headers: { 'content-type': 'application/json' } }));
        expect(out.fetches).toBe(1);
        expect(out.settled).toEqual([{ ok: false }]);
        expect(out.router.actionResult()).toEqual({ fields: { text: 'PRIOR' } });
        expect(out.log).toHaveLength(1);
        expect(out.log[0]).toContain('403');
        expect(out.log[0]).not.toContain('could not be sent');
    });

    it('an HTML 500 body is the same refusal, with its own status', async () =>
    {
        const out = await submitWith(new Response('<!doctype html><html><body>Internal</body></html>', { status: 500, headers: { 'content-type': 'text/html' } }));
        expect(out.settled).toEqual([{ ok: false }]);
        expect(out.router.actionResult()).toEqual({ fields: { text: 'PRIOR' } });
        expect(out.log).toHaveLength(1);
        expect(out.log[0]).toContain('500');
        expect(out.log[0]).not.toContain('could not be sent');
    });
});

describe('<Form> on the action\'s own answers', () =>
{
    it('a validation refusal lands in the action-result slot with the values the action returned', async () =>
    {
        const out = await submitWith(new Response(JSON.stringify({ ok: false, result: { fields: { text: 'Required' } } }), { status: 422, headers: { 'content-type': 'application/json' } }));
        expect(out.settled).toEqual([{ ok: false, result: { fields: { text: 'Required' } } }]);
        expect(out.router.actionResult()).toEqual({ fields: { text: 'Required' } });
        expect(out.log).toEqual([]);
    });

    it('a success clears the slot', async () =>
    {
        const out = await submitWith(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
        expect(out.settled).toEqual([{ ok: true }]);
        expect(out.router.actionResult()).toBeUndefined();
    });

    it('a redirect answer navigates, so an enhanced submit lands where a native one would', async () =>
    {
        const out = await submitWith(new Response(JSON.stringify({ ok: true, redirect: '/signed-in' }), { status: 200, headers: { 'content-type': 'application/json' } }));
        expect(out.settled).toEqual([{ ok: true, redirect: '/signed-in' }]);
        await vi.waitFor(() => expect(out.router.location().pathname).toBe('/signed-in'));
        expect(document.querySelector('#signed-in')).not.toBeNull();
        expect(out.log).toEqual([]);
    });
});

describe('<Form> judges the redirect it is told to follow', () =>
{
    // `router.navigate` PERFORMS an off-origin target rather than refusing one, so this is a
    // redirect boundary like the guard and loader ones and it answers to the same rule. The
    // server judges what it emits; a page that followed whatever came back would be the one
    // consumer of the sentinel that does not.
    for (const target of ['https://evil.example/', '//evil.example/x', '/\\evil.example/x', 'javascript:alert(1)'])
    {
        it(`refuses "${ target }" instead of leaving the origin`, async () =>
        {
            const out = await submitWith(new Response(JSON.stringify({ ok: true, redirect: target }), { status: 200, headers: { 'content-type': 'application/json' } }));
            expect(out.settled).toEqual([{ ok: false }]);
            expect(out.router.location().pathname).toBe('/todos');
            expect(out.router.actionResult()).toEqual({ fields: { text: 'PRIOR' } });
            expect(out.log).toHaveLength(1);
            expect(out.log[0]).toContain(target);
        });
    }

    it('refuses a redirect that is not a string rather than reading it as a plain success', async () =>
    {
        const out = await submitWith(new Response(JSON.stringify({ ok: true, redirect: 42 }), { status: 200, headers: { 'content-type': 'application/json' } }));
        expect(out.settled).toEqual([{ ok: false }]);
        expect(out.router.location().pathname).toBe('/todos');
        expect(out.log).toHaveLength(1);
    });

    it('CONTROL: a same-origin target with a query and a hash still navigates', async () =>
    {
        const out = await submitWith(new Response(JSON.stringify({ ok: true, redirect: '/signed-in?from=form#top' }), { status: 200, headers: { 'content-type': 'application/json' } }));
        expect(out.settled).toEqual([{ ok: true, redirect: '/signed-in?from=form#top' }]);
        await vi.waitFor(() => expect(out.router.location().pathname).toBe('/signed-in'));
        expect(out.log).toEqual([]);
    });
});
