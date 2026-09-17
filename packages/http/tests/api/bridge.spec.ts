// @vitest-environment node
//
// The in-process api bridge: a page rendered on the server calling the app's OWN api with the
// visitor's identity and no socket. Every arm here is about WHERE a call goes and WHAT it may
// do once it gets there - the transport ladder, the origin the handler sees, the GET/HEAD rule
// enforced on both sides of it, and the named error that replaced `TypeError: fetch failed`.
//
// Each test plays the host: a request root is open (the App's own), the request is made ambient
// and the bridge is stamped on it, which is exactly the pair `mountPages` performs before a
// render. A counting spy on `globalThis.fetch` is the evidence that a bridged call dials nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { object, string, boolean } from '@azerothjs/schema';
import { installRequestContext } from 'azerothjs/internal';

import { App } from '../../src/app.ts';
import { json, redirect } from '../../src/respond.ts';
import { parseCookies } from '../../src/cookies.ts';
import { onWorkUnitCleanup } from '../../src/request-root.ts';
import { csrfProtect, csrfToken } from '../../src/csrf.ts';
import { feature, manifestOf } from '../../src/api/feature.ts';
import { register } from '../../src/api/register.ts';
import { ApiError, createClient, type ClientOf, type ClientOptions } from '../../src/api/client.ts';
import { attachApiBridge } from '../../src/api/attach-bridge.ts';
import { apiBridgeOf, type ApiBridge } from '../../src/api/bridge.ts';

/** What each api handler observed, so an arm can tell an in-process leg from a wire leg. */
const served: Array<{ origin: string; visitor: string }> = [];
const writes: string[] = [];
const followed: string[] = [];
let slowSeen: { aborted: boolean; cleanup: boolean } = { aborted: false, cleanup: false };

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const identity = feature('/identity', (routes) => ({
    read: routes.get('/', { output: object({ visitor: string(), origin: string() }) }, (context) =>
    {
        const seen = { origin: context.url.origin, visitor: parseCookies(context.request)['visitor'] ?? 'anonymous' };
        served.push(seen);
        return seen;
    }),
    big: routes.get('/big', { output: object({ blob: string() }) }, () => ({ blob: 'x'.repeat(4096) })),
    away: routes.get('/away', {}, () => redirect('/api/identity/landing', 302)),
    landing: routes.get('/landing', {}, () =>
    {
        followed.push('landing');
        return { ok: true };
    }),
    slow: routes.get('/slow', { output: object({ ok: boolean() }) }, async (context) =>
    {
        onWorkUnitCleanup(() =>
        {
            slowSeen = { ...slowSeen, cleanup: true };
        });
        await pause(40);
        slowSeen = { ...slowSeen, aborted: context.request.signal.aborted };
        return { ok: true };
    }),
    save: routes.action('/save', { input: object({ note: string() }), output: object({ ok: boolean() }) }, (context) =>
    {
        writes.push(context.input.note);
        return { ok: true };
    })
}));

const api = { identity };

beforeEach(() =>
{
    served.length = 0;
    writes.length = 0;
    followed.length = 0;
    slowSeen = { aborted: false, cleanup: false };
});

function serve(): App
{
    const app = new App();
    register(app, api);
    return app;
}

function clientFor(options: ClientOptions): ClientOf<typeof api>
{
    return createClient<typeof api>(manifestOf(api), options);
}

/** The two things a host does to a request before it walks, loads or renders with it. */
function hostOn(app: App): (page: Request, work: (bridge: ApiBridge | undefined) => Promise<unknown>) => Promise<unknown>
{
    let job: (bridge: ApiBridge | undefined) => Promise<unknown> = async () => undefined;
    let outcome: { value: unknown } | { error: unknown } = { value: undefined };
    app.get('/page', async (context) =>
    {
        attachApiBridge(context.request);
        installRequestContext(context.request);
        try
        {
            outcome = { value: await job(apiBridgeOf(context.request)) };
        }
        catch (error)
        {
            outcome = { error };
        }
        return json({ done: true });
    });
    return async (page, work) =>
    {
        job = work;
        await app.handle(page);
        if ('error' in outcome)
        {
            throw outcome.error;
        }
        return outcome.value;
    };
}

const visitorPage = (): Request => new Request('http://page.example/page', { headers: { cookie: 'visitor=alice' } });

describe('the transport a call selects', () =>
{
    it('dispatches a relative baseUrl in process, at the PAGE\'s origin, with the visitor\'s cookie', async () =>
    {
        const dialled = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        {
            throw new Error('the client opened a socket');
        });
        const render = hostOn(serve());
        const client = clientFor({ baseUrl: '/api' });

        const answer = await render(visitorPage(), async () => await client.identity.read());

        expect(answer).toEqual({ visitor: 'alice', origin: 'http://page.example' });
        expect(served).toEqual([{ visitor: 'alice', origin: 'http://page.example' }]);
        expect(dialled).not.toHaveBeenCalled();
    });

    it('never bridges an absolute baseUrl - it says "go over the wire"', async () =>
    {
        const dialled: string[] = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
        {
            dialled.push((input as Request).url);
            return json({ visitor: 'remote', origin: 'https://elsewhere.example' });
        });
        const render = hostOn(serve());
        const client = clientFor({ baseUrl: 'https://elsewhere.example/api' });

        const answer = await render(visitorPage(), async () => await client.identity.read());

        expect(answer).toEqual({ visitor: 'remote', origin: 'https://elsewhere.example' });
        expect(dialled).toEqual(['https://elsewhere.example/api/identity']);
        expect(served).toEqual([]);
    });

    it('never bridges a SCHEME-RELATIVE baseUrl either - "//host" is somebody else\'s origin', async () =>
    {
        const dialled: string[] = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
        {
            dialled.push((input as Request).url);
            return json({ visitor: 'remote', origin: 'http://vendor.example' });
        });
        const render = hostOn(serve());
        const client = clientFor({ baseUrl: '//vendor.example/api' });

        const answer = await render(visitorPage(), async () => await client.identity.read());

        // No scheme of its own, so it takes the inert base's on a server - and the wire, never
        // the local App holding the visitor's cookie.
        expect(answer).toEqual({ visitor: 'remote', origin: 'http://vendor.example' });
        expect(dialled).toEqual(['http://vendor.example/api/identity']);
        expect(served).toEqual([]);
    });

    it('never bridges an absolute baseUrl whose scheme is not spelled in lower case', async () =>
    {
        const dialled: string[] = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
        {
            dialled.push((input as Request).url);
            return json({ visitor: 'remote', origin: 'https://vendor.example' });
        });
        const render = hostOn(serve());
        const client = clientFor({ baseUrl: 'HTTPS://vendor.example/api' });

        const answer = await render(visitorPage(), async () => await client.identity.read());

        expect(answer).toEqual({ visitor: 'remote', origin: 'https://vendor.example' });
        expect(dialled).toEqual(['https://vendor.example/api/identity']);
        expect(served).toEqual([]);
    });

    it('refuses a dispatch addressed at another authority, so no holder of the request can steer one there', async () =>
    {
        const app = serve();
        const render = hostOn(app);
        let entered = 0;

        await expect(render(visitorPage(), async (bridge) =>
        {
            const spy = vi.spyOn(app, 'handle');
            try
            {
                return await (bridge as ApiBridge).dispatch(new Request('http://elsewhere.example/api/x'));
            }
            finally
            {
                entered = spy.mock.calls.length;
            }
        })).rejects.toThrow(/page's own origin/);

        expect(entered).toBe(0);
        expect(served).toEqual([]);
    });

    it('lets an explicit fetch win over the bridge', async () =>
    {
        const render = hostOn(serve());
        const explicit = vi.fn(async (request: Request) => json({ visitor: 'explicit', origin: new URL(request.url).origin }));
        const client = clientFor({ baseUrl: '/api', fetch: explicit });

        const answer = await render(visitorPage(), async () => await client.identity.read());

        expect(answer).toEqual({ visitor: 'explicit', origin: 'http://localhost' });
        expect(explicit).toHaveBeenCalledTimes(1);
        expect(served).toEqual([]);
    });

    it('answers a relative baseUrl with no bridge and no location by NAMING the five causes', async () =>
    {
        const dialled = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        {
            throw new Error('the client opened a socket');
        });
        const client = clientFor({ baseUrl: '/api' });

        await expect(client.identity.read()).rejects.toThrow(/means "this origin"/);
        await expect(client.identity.read()).rejects.toThrow(/no api is registered/);
        await expect(client.identity.read()).rejects.toThrow(/ssr\.external/);
        expect(dialled).not.toHaveBeenCalled();
    });

    it('keeps the inert base for an explicit transport with a relative baseUrl and no request', async () =>
    {
        const saw: string[] = [];
        const client = clientFor({
            baseUrl: '/api',
            fetch: async (request: Request) =>
            {
                saw.push(request.url);
                return json({ visitor: 'explicit', origin: 'http://localhost' });
            }
        });

        await client.identity.read();

        expect(saw).toEqual(['http://localhost/api/identity']);
    });

    it('never hands an explicit transport an authority derived from the ambient request', async () =>
    {
        const render = hostOn(serve());
        const saw: string[] = [];
        const client = clientFor({
            baseUrl: '/api',
            fetch: async (request: Request) =>
            {
                saw.push(request.url);
                return json({ visitor: 'explicit', origin: 'http://localhost' });
            }
        });

        await render(visitorPage(), async () => await client.identity.read());

        // The page is answered at page.example; an app-supplied transport still sees the inert
        // base, so a forged Host can never become an outbound authority carrying this client's
        // configured headers.
        expect(saw).toEqual(['http://localhost/api/identity']);
        expect(served).toEqual([]);
    });
});

describe('the write path stays closed', () =>
{
    it('refuses a POST at the CALL SITE, before the dispatcher is reached', async () =>
    {
        const render = hostOn(serve());
        const client = clientFor({ baseUrl: '/api' });
        let dispatched = 0;

        await expect(render(visitorPage(), async (bridge) =>
        {
            const spy = vi.spyOn(bridge as ApiBridge, 'dispatch');
            try
            {
                return await client.identity.save({ note: 'forged' });
            }
            finally
            {
                dispatched = spy.mock.calls.length;
            }
        })).rejects.toThrow(/GET and HEAD only/);

        expect(dispatched).toBe(0);
        expect(writes).toEqual([]);
    });

    it('refuses a POST at the DISPATCHER too, so the rule holds for any holder of the request', async () =>
    {
        const app = serve();
        const render = hostOn(app);
        let entered = 0;

        await expect(render(visitorPage(), async (bridge) =>
        {
            const spy = vi.spyOn(app, 'handle');
            try
            {
                return await (bridge as ApiBridge).dispatch(new Request('http://page.example/api/identity/save', { method: 'POST' }));
            }
            finally
            {
                entered = spy.mock.calls.length;
            }
        })).rejects.toThrow(/GET and HEAD only/);

        expect(entered).toBe(0);
        expect(writes).toEqual([]);
    });

    it('CONTROL: mirroring the token from the forwarded cookie WOULD let the write through, which is why the refusal is by method', async () =>
    {
        const token = csrfToken();
        const vault = feature('/vault', (routes) => ({
            save: routes.with(csrfProtect({ secure: false })).action('/save',
                { input: object({ note: string() }), output: object({ ok: boolean() }) },
                (context) =>
                {
                    writes.push(parseCookies(context.request)['visitor'] ?? 'anonymous');
                    return { ok: true };
                })
        }));
        const app = new App();
        register(app, { vault });
        const jar = `visitor=alice; azcsrf=${ token }`;

        const bare = await app.handle(new Request('http://page.example/api/vault/save', {
            method: 'POST', headers: { 'content-type': 'application/json', cookie: jar }, body: '{"note":"x"}'
        }));
        expect(bare.status).toBe(403);

        const mirrored = await app.handle(new Request('http://page.example/api/vault/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: jar, 'x-azeroth-csrf': token },
            body: '{"note":"x"}'
        }));
        expect(mirrored.status).toBe(200);
        expect(writes).toEqual(['alice']);
    });
});

describe('what a bridged answer may be', () =>
{
    it('fills a group the client\'s manifest never had from the bridge, and names it with the causes when there is none', async () =>
    {
        const render = hostOn(serve());
        // The scaffold's server-side shape: the bundle built its client with an empty manifest
        // because `register` had not run when the module was imported.
        const client = createClient<typeof api>({}, { baseUrl: '/api' });

        const answer = await render(visitorPage(), async () => await client.identity.read());
        expect(answer).toEqual({ visitor: 'alice', origin: 'http://page.example' });

        // Outside the request the trap fires at the call site, as it always has.
        expect(() => client.identity.read()).toThrow(/api group "identity"/);
        expect(() => client.identity.read()).toThrow(/ssr\.external/);
    });

    it('holds the response cap in process', async () =>
    {
        const render = hostOn(serve());
        const client = clientFor({ baseUrl: '/api', maxResponseBytes: 128 });

        const error = await render(visitorPage(), async () => await client.identity.big()).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe('response-too-large');
    });

    it('surfaces a 3xx as an ApiError and never follows the Location', async () =>
    {
        const render = hostOn(serve());
        const client = clientFor({ baseUrl: '/api' });

        const error = await render(visitorPage(), async () => await client.identity.away()).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(302);
        expect(followed).toEqual([]);
    });

    it('carries the page request\'s signal, so a disconnect reaches the handler and settles its root', async () =>
    {
        const render = hostOn(serve());
        const client = clientFor({ baseUrl: '/api' });
        const controller = new AbortController();
        const page = new Request('http://page.example/page', { headers: { cookie: 'visitor=alice' }, signal: controller.signal });

        await render(page, async () =>
        {
            setTimeout(() => controller.abort(), 10);
            return await client.identity.slow();
        });

        expect(slowSeen).toEqual({ aborted: true, cleanup: true });
    });
});

describe('the bridge stamped on the request', () =>
{
    it('carries the prefix register() was given, for a host building a client of its own', async () =>
    {
        const app = new App();
        register(app, api, { prefix: '/api/v2' });
        let prefix: string | undefined;

        await hostOn(app)(visitorPage(), (bridge) =>
        {
            prefix = bridge?.prefix;
            return Promise.resolve(undefined);
        });

        expect(prefix).toBe('/api/v2');
    });

    it('is stamped once: a second attach on the same request keeps the first bridge', async () =>
    {
        const app = serve();
        let same: boolean | undefined;
        app.get('/twice', (context) =>
        {
            attachApiBridge(context.request);
            const first = apiBridgeOf(context.request);
            attachApiBridge(context.request);
            same = apiBridgeOf(context.request) === first;
            return json({ ok: true });
        });

        await app.handle(new Request('http://page.example/twice'));

        expect(same).toBe(true);
    });
});
