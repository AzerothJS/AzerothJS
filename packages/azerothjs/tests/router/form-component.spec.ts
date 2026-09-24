// <Form>'s enhanced submit understands exactly three answers as the action's own. Everything
// else is a refusal by the server that never reached validation, and the arms here pin what
// that means for the page: the last validation verdict stays on screen, the caller hears a bare
// `{ ok: false }`, and the status is reported once. A redirect answer navigates.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Form, RouterProvider, Routes, createMemoryHistory, createRouter, h, render } from 'azerothjs';
import type { Router } from 'azerothjs';
import { askCsrfCookie } from 'azerothjs/internal';

interface Outcome { ok: boolean; result?: unknown; redirect?: string }

interface Mounted
{
    router: Router;
    form: HTMLFormElement;
    settled: Outcome[];
}

function mountForm(priorResult: unknown, csrf?: string, action?: string): Mounted
{
    const settled: Outcome[] = [];
    const routes = [
        { path: '/todos', component: (): HTMLElement => Form({ ...(action !== undefined ? { action } : {}), onSettled: (outcome: Outcome) => settled.push(outcome), children: h('button', { type: 'submit' }, 'go') }) as HTMLElement },
        { path: '/signed-in', component: (): HTMLElement => h('p', { id: 'signed-in' }, 'in') }
    ];
    const router = createRouter({
        routes,
        history: createMemoryHistory('/todos'),
        initialLoaderData: { version: 4, path: '/todos', data: [], action: priorResult, ...(csrf !== undefined ? { csrf } : {}) }
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(() => RouterProvider({ router, children: () => Routes({ fallback: () => h('p', {}, 'nf') }) }), host);
    return { router, form: host.querySelector('form') as HTMLFormElement, settled };
}

async function submitWith(response: Response, priorResult: unknown = { fields: { text: 'PRIOR' } }): Promise<Mounted & { log: string[]; fetches: number }>
{
    const fetchSpy = vi.fn(async (_url: unknown, _init?: RequestInit) => response);
    vi.stubGlobal('fetch', fetchSpy);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mounted = mountForm(priorResult);
    mounted.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(mounted.settled.length + (errorSpy.mock.calls.length > 0 ? 1 : 0)).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const log = errorSpy.mock.calls.map((call) => String(call[0]));
    errorSpy.mockRestore();
    return { ...mounted, log, fetches: fetchSpy.mock.calls.filter((call) => call[1]?.method === 'POST').length };
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

describe('<Form> on a page that carries no token', () =>
{
    const TOKEN = 'T0KEN-minted-by-the-endpoint-0123456789';

    afterEach(() =>
    {
        document.cookie = '__Host-azcsrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; secure';
        document.cookie = 'azcsrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    });

    /** A server whose token endpoint sets `minted`, or answers 404 and sets nothing when null. */
    function stubServer(calls: string[], posted: (string | null)[], minted: string | null = `azcsrf=${ TOKEN }; path=/`): void
    {
        vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) =>
        {
            calls.push(`${ init?.method ?? 'GET' } ${ String(url) }${ init?.cache !== undefined ? ` ${ init.cache }` : '' }`);
            if (String(url).endsWith('/__azeroth/csrf'))
            {
                await new Promise((resolve) => setTimeout(resolve, 5));
                if (minted === null)
                {
                    return new Response('{"error":{"code":"not-found"}}', { status: 404 });
                }
                document.cookie = minted;
                return new Response(null, { status: 204 });
            }
            posted.push(new URLSearchParams(init?.body as URLSearchParams).get('_csrf'));
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        }));
    }

    async function submit(csrf?: string, action?: string, minted?: string | null): Promise<{ calls: string[]; posted: string | null }>
    {
        const calls: string[] = [];
        const posted: (string | null)[] = [];
        stubServer(calls, posted, minted);
        const mounted = mountForm(undefined, csrf, action);
        mounted.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(mounted.settled).toHaveLength(1));
        return { calls, posted: posted[0] ?? null };
    }

    it('asks /__azeroth/csrf for the cookie before the first submit, uncached, and posts that token', async () =>
    {
        const out = await submit();
        expect(out.calls).toEqual(['GET /__azeroth/csrf no-store', 'POST /todos']);
        expect(out.posted).toBe(TOKEN);
    });

    it('two forms submitted together share the one request, so both post the one token', async () =>
    {
        const calls: string[] = [];
        const posted: (string | null)[] = [];
        stubServer(calls, posted);
        const first = mountForm(undefined);
        const second = mountForm(undefined);
        first.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        second.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(first.settled.length + second.settled.length).toBe(2));
        expect(calls.filter((call) => call.startsWith('GET'))).toHaveLength(1);
        expect(posted).toEqual([TOKEN, TOKEN]);
    });

    it('a rendered token whose cookie never arrived still asks, and posts the cookie the browser then holds', async () =>
    {
        const out = await submit('SEEDED-token-whose-cookie-never-arrived');
        expect(out.calls).toEqual(['GET /__azeroth/csrf no-store', 'POST /todos']);
        expect(out.posted).toBe(TOKEN);
    });

    it('asks once per form: an answer that sets no cookie is not asked again', async () =>
    {
        const calls: string[] = [];
        const posted: (string | null)[] = [];
        stubServer(calls, posted, null);
        const mounted = mountForm(undefined);
        mounted.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(mounted.settled).toHaveLength(1));
        mounted.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(mounted.settled).toHaveLength(2));
        expect(calls).toEqual(['GET /__azeroth/csrf no-store', 'POST /todos', 'POST /todos']);
    });

    it('a rendered token still rides when the ask sets no cookie the form can read', async () =>
    {
        const out = await submit('RENDERED-token-the-ask-left-unreadable-0123', undefined, null);
        expect(out.calls).toEqual(['GET /__azeroth/csrf no-store', 'POST /todos']);
        expect(out.posted).toBe('RENDERED-token-the-ask-left-unreadable-0123');
    });

    it('asks again on the next submit after an ask that never reached the server', async () =>
    {
        const calls: string[] = [];
        let down = true;
        vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) =>
        {
            calls.push(`${ init?.method ?? 'GET' } ${ String(url) }`);
            if (!String(url).endsWith('/__azeroth/csrf'))
            {
                return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            if (down)
            {
                down = false;
                throw new TypeError('network down');
            }
            return new Response(null, { status: 204 });
        }));
        const mounted = mountForm(undefined);
        mounted.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(mounted.settled).toHaveLength(1));
        mounted.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(mounted.settled).toHaveLength(2));
        expect(calls).toEqual(['GET /__azeroth/csrf', 'POST /todos', 'GET /__azeroth/csrf', 'POST /todos']);
    });

    it('a second form that joined the first form ask, which set nothing, asks on its own next submit', async () =>
    {
        const calls: string[] = [];
        stubServer(calls, [], null);
        const first = mountForm(undefined);
        const second = mountForm(undefined);
        first.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        second.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(first.settled.length + second.settled.length).toBe(2));
        expect(calls.filter((call) => call.startsWith('GET'))).toHaveLength(1);
        second.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(second.settled).toHaveLength(2));
        expect(calls).toEqual(['GET /__azeroth/csrf no-store', 'POST /todos', 'POST /todos', 'GET /__azeroth/csrf no-store', 'POST /todos']);
    });

    it('CONTROL: a form posting to another origin never asks, and its field carries only what the page rendered', async () =>
    {
        const empty = await submit(undefined, 'https://elsewhere.example/collect');
        expect(empty.calls).toEqual(['POST https://elsewhere.example/collect']);
        expect(empty.posted).toBe('');
        const seeded = await submit('SEEDED-token-from-the-handoff-0123456789', 'https://elsewhere.example/collect');
        expect(seeded.calls).toEqual(['POST https://elsewhere.example/collect']);
        expect(seeded.posted).toBe('SEEDED-token-from-the-handoff-0123456789');
    });

    it('CONTROL: a token seeded by the server render posts as it is, with no request first, while its cookie is held', async () =>
    {
        document.cookie = '__Host-azcsrf=SEEDED-token-from-the-handoff-0123456789; path=/; secure';
        const out = await submit('SEEDED-token-from-the-handoff-0123456789');
        expect(out.calls).toEqual(['POST /todos']);
        expect(out.posted).toBe('SEEDED-token-from-the-handoff-0123456789');
    });

    it('CONTROL: a cookie the browser already holds posts with no request first', async () =>
    {
        document.cookie = '__Host-azcsrf=HELD-token-in-the-jar-0123456789; path=/; secure';
        const out = await submit();
        expect(out.calls).toEqual(['POST /todos']);
        expect(out.posted).toBe('HELD-token-in-the-jar-0123456789');
    });

    it('a lone azcsrf does not count as held over plain http either: it asks, and posts the __Host- cookie', async () =>
    {
        document.cookie = 'azcsrf=LEFT-by-a-secure-false-run-0123456789; path=/';
        const out = await submit(undefined, undefined, `__Host-azcsrf=${ TOKEN }; path=/; secure`);
        expect(out.calls).toEqual(['GET /__azeroth/csrf no-store', 'POST /todos']);
        expect(out.posted).toBe(TOKEN);
    });

    it('under secure: false the lone azcsrf is the token: one ask that sets nothing, then it posts', async () =>
    {
        document.cookie = 'azcsrf=HELD-under-secure-false-0123456789; path=/';
        const out = await submit(undefined, undefined, null);
        expect(out.calls).toEqual(['GET /__azeroth/csrf no-store', 'POST /todos']);
        expect(out.posted).toBe('HELD-under-secure-false-0123456789');
    });

    describe('on an https page', () =>
    {
        const dom = (globalThis as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM;
        let restore = '';

        beforeEach(() =>
        {
            restore = location.href;
            dom.setURL('https://site.test/todos');
        });

        afterEach(() =>
        {
            document.cookie = '__Host-azcsrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; secure';
            document.cookie = 'azcsrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
            dom.setURL(restore);
        });

        it('a plain azcsrf a sibling subdomain planted does not count as held: it asks, and posts the __Host- cookie', async () =>
        {
            document.cookie = 'azcsrf=PLANTED-by-a-sibling-0123456789; path=/';
            const out = await submit(undefined, undefined, `__Host-azcsrf=${ TOKEN }; path=/; secure`);
            expect(out.calls).toEqual(['GET /__azeroth/csrf no-store', 'POST /todos']);
            expect(out.posted).toBe(TOKEN);
        });

        it('a held __Host-azcsrf beside a planted azcsrf asks once, and wins when the answer names no pair', async () =>
        {
            document.cookie = 'azcsrf=PLANTED-by-a-sibling-0123456789; path=/';
            document.cookie = '__Host-azcsrf=HELD-for-this-host-0123456789; path=/; secure';
            const out = await submit(undefined, undefined, null);
            expect(out.calls).toEqual(['GET /__azeroth/csrf no-store', 'POST /todos']);
            expect(out.posted).toBe('HELD-for-this-host-0123456789');
        });

        it('the __Host- pair the answer names rides before its cookie shows, never a planted azcsrf', async () =>
        {
            document.cookie = 'azcsrf=PLANTED-by-a-sibling-0123456789; path=/';
            const out = await named(`__Host-azcsrf=${ TOKEN }`, null);
            expect(out.calls).toEqual(['GET /__azeroth/csrf', 'POST /todos']);
            expect(out.posted).toEqual([TOKEN]);
        });

        // Both default names held, azcsrf equal to the rendered token: the answer decides.
        it('a secure: false server names azcsrf, and its rendered token rides over a __Host- cookie a secure run left', async () =>
        {
            document.cookie = '__Host-azcsrf=STALE-left-by-a-secure-run-0123456789; path=/; secure';
            document.cookie = 'azcsrf=SEEDED-and-held-as-azcsrf-0123456789; path=/';
            const out = await named('azcsrf=SEEDED-and-held-as-azcsrf-0123456789', null, 'SEEDED-and-held-as-azcsrf-0123456789');
            expect(out.posted).toEqual(['SEEDED-and-held-as-azcsrf-0123456789']);
        });

        it('a planted azcsrf equal to the rendered token never stands: the answer names the __Host- cookie', async () =>
        {
            document.cookie = '__Host-azcsrf=OWN-token-of-this-visitor-0123456789; path=/; secure';
            document.cookie = 'azcsrf=SEEDED-and-held-as-azcsrf-0123456789; path=/';
            const out = await named('__Host-azcsrf=OWN-token-of-this-visitor-0123456789', null, 'SEEDED-and-held-as-azcsrf-0123456789');
            expect(out.calls).toEqual(['GET /__azeroth/csrf', 'POST /todos']);
            expect(out.posted).toEqual(['OWN-token-of-this-visitor-0123456789']);
        });
    });

    describe('when the answer names the cookie it compares and its token', () =>
    {
        afterEach(() =>
        {
            document.cookie = 'myapp=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
        });

        it('posts the token the answer names before the browser shows its cookie', async () =>
        {
            const out = await named(`azcsrf=${ TOKEN }`, null);
            expect(out.calls).toEqual(['GET /__azeroth/csrf', 'POST /todos']);
            expect(out.posted).toEqual([TOKEN]);
        });

        it('a rendered token held as azcsrf beside a __Host-azcsrf another run left: it asks, and posts that token', async () =>
        {
            document.cookie = '__Host-azcsrf=STALE-left-by-local-production-0123; path=/; secure';
            document.cookie = 'azcsrf=SEEDED-by-the-dev-render-0123456789; path=/';
            const out = await named('azcsrf=SEEDED-by-the-dev-render-0123456789', null, 'SEEDED-by-the-dev-render-0123456789');
            expect(out.calls).toEqual(['GET /__azeroth/csrf', 'POST /todos']);
            expect(out.posted).toEqual(['SEEDED-by-the-dev-render-0123456789']);
        });

        it('with no rendered token and both default names held, it asks, and posts the one the answer names', async () =>
        {
            document.cookie = '__Host-azcsrf=STALE-left-by-local-production-0123; path=/; secure';
            document.cookie = 'azcsrf=HELD-for-the-dev-server-0123456789; path=/';
            const out = await named('azcsrf=HELD-for-the-dev-server-0123456789', null);
            expect(out.calls).toEqual(['GET /__azeroth/csrf', 'POST /todos']);
            expect(out.posted).toEqual(['HELD-for-the-dev-server-0123456789']);
        });

        it('a renamed cookie holding the rendered token beside a foreign __Host-azcsrf: it asks, and posts the renamed one', async () =>
        {
            document.cookie = '__Host-azcsrf=FOREIGN-from-another-app-0123456789; path=/; secure';
            document.cookie = 'myapp=SEEDED-under-a-renamed-cookie-0123; path=/';
            const out = await named('myapp=SEEDED-under-a-renamed-cookie-0123', null, 'SEEDED-under-a-renamed-cookie-0123');
            expect(out.calls).toEqual(['GET /__azeroth/csrf', 'POST /todos']);
            expect(out.posted).toEqual(['SEEDED-under-a-renamed-cookie-0123']);
        });

        it('asks again once the cookie the answer named is gone, as after a logout', async () =>
        {
            const out = await named(`azcsrf=${ TOKEN }`, `azcsrf=${ TOKEN }; path=/`, undefined, () =>
            {
                document.cookie = 'azcsrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
            });
            expect(out.calls).toEqual(['GET /__azeroth/csrf', 'POST /todos', 'GET /__azeroth/csrf', 'POST /todos']);
        });

        // Two servers on one origin can read two names: an ask it only joined may be the other's.
        it('a form that joined an ask naming another cookie posts it once, then asks on its own', async () =>
        {
            document.cookie = 'myapp=OTHER-server-token-0123456789; path=/';
            const other = askCsrfCookie('/a/posts', false, async () =>
            {
                await new Promise((resolve) => setTimeout(resolve, 5));
                return new Response(null, { status: 204, headers: { 'x-azeroth-csrf-cookie': 'myapp=OTHER-server-token-0123456789' } });
            });
            const out = await named(`__Host-azcsrf=${ TOKEN }`, `__Host-azcsrf=${ TOKEN }; path=/; secure`, undefined, () => undefined);
            await other;
            expect(out.calls).toEqual(['POST /todos', 'GET /__azeroth/csrf', 'POST /todos']);
            expect(out.posted).toEqual(['OTHER-server-token-0123456789', TOKEN]);
        });

        it('a later submit posts the named cookie as the browser then holds it', async () =>
        {
            const out = await named(`azcsrf=${ TOKEN }`, `azcsrf=${ TOKEN }; path=/`, undefined, () =>
            {
                document.cookie = 'azcsrf=ROTATED-after-the-answer-0123456789; path=/';
            });
            expect(out.calls).toEqual(['GET /__azeroth/csrf', 'POST /todos', 'POST /todos']);
            expect(out.posted).toEqual([TOKEN, 'ROTATED-after-the-answer-0123456789']);
        });

        it('a form that joined another form ask posts the token that answer named', async () =>
        {
            const out = await named(`azcsrf=${ TOKEN }`, null, undefined, undefined, 2);
            expect(out.calls.filter((call) => call.startsWith('GET'))).toHaveLength(1);
            expect(out.posted).toEqual([TOKEN, TOKEN]);
        });

        it('a form that joined another form ask posts again with no request once the browser shows that cookie', async () =>
        {
            const out = await named(`__Host-azcsrf=${ TOKEN }`, null, undefined, () =>
            {
                document.cookie = `__Host-azcsrf=${ TOKEN }; path=/; secure`;
            }, 2);
            expect(out.calls.filter((call) => call.startsWith('GET'))).toHaveLength(1);
            expect(out.posted).toEqual([TOKEN, TOKEN, TOKEN]);
        });
    });

    /**
     * The endpoint names `pair` and sets `lands` (null: not yet shown). `forms` submit together,
     * and `between` runs before the last of them submits again.
     */
    async function named(pair: string, lands: string | null, csrf?: string, between?: () => void, forms = 1): Promise<{ calls: string[]; posted: (string | null)[] }>
    {
        const calls: string[] = [];
        const posted: (string | null)[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) =>
        {
            calls.push(`${ init?.method ?? 'GET' } ${ String(url) }`);
            if (String(url).endsWith('/__azeroth/csrf'))
            {
                await new Promise((resolve) => setTimeout(resolve, 5));
                if (lands !== null)
                {
                    document.cookie = lands;
                }
                return new Response(null, { status: 204, headers: { 'x-azeroth-csrf-cookie': pair } });
            }
            posted.push(new URLSearchParams(init?.body as URLSearchParams).get('_csrf'));
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        }));
        const mounted = Array.from({ length: forms }, () => mountForm(undefined, csrf));
        for (const one of mounted)
        {
            one.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
        await vi.waitFor(() => expect(mounted.every((one) => one.settled.length === 1)).toBe(true));
        if (between !== undefined)
        {
            between();
            mounted.at(-1)?.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            await vi.waitFor(() => expect(mounted.at(-1)?.settled).toHaveLength(2));
        }
        return { calls, posted };
    }
});
