// Browser lane of the action client (happy-dom): the CSRF double-submit mirror. The page's
// own JS can read the token cookie - that readability IS the defense - so the client echoes
// it into the header automatically on every action call, and only there.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { askCsrfCookie } from 'azerothjs/internal';
import { object, string } from '@azerothjs/schema';
import { feature, manifestOf } from '../../src/api/feature.ts';
import { createClient } from '../../src/api/client.ts';

const posts = feature('/posts', (routes) => ({
    create: routes.action('/create', { input: object({ title: string() }) }, (context) => ({ title: context.input.title })),
    list: routes.get('/', {}, () => [])
}));

function clientSeeing(seen: Request[], csrf?: false | { cookie?: string; header?: string }): ReturnType<typeof createClient<{ posts: typeof posts }>>
{
    return createClient<{ posts: typeof posts }>(manifestOf({ posts }), {
        baseUrl: '/api',
        ...(csrf === undefined ? {} : { csrf }),
        fetch: (request) =>
        {
            seen.push(request);
            return Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
        }
    });
}

afterEach(() =>
{
    // A past date, not Max-Age=0: happy-dom still lists a cookie that expires this millisecond.
    document.cookie = 'azcsrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    document.cookie = 'renamed=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

describe('the action client in a browser', () =>
{
    it('mirrors the token cookie into x-azeroth-csrf on action calls', async () =>
    {
        document.cookie = 'azcsrf=tok-abcdef1234567890';
        const seen: Request[] = [];
        await clientSeeing(seen).posts.create({ title: 'x' });
        expect(seen.at(-1)?.headers.get('x-azeroth-csrf')).toBe('tok-abcdef1234567890');
    });

    it('plain JSON calls carry no CSRF header', async () =>
    {
        document.cookie = 'azcsrf=tok-abcdef1234567890';
        const seen: Request[] = [];
        await clientSeeing(seen).posts.list();
        expect(seen[0]?.headers.get('x-azeroth-csrf')).toBeNull();
    });

    it('csrf: false disables the mirror; renamed cookie/header options are honored', async () =>
    {
        document.cookie = 'azcsrf=tok-abcdef1234567890';
        const disabled: Request[] = [];
        await clientSeeing(disabled, false).posts.create({ title: 'x' });
        expect(disabled[0]?.headers.get('x-azeroth-csrf')).toBeNull();

        document.cookie = 'renamed=tok-fedcba0987654321';
        const renamed: Request[] = [];
        await clientSeeing(renamed, { cookie: 'renamed', header: 'x-my-csrf' }).posts.create({ title: 'x' });
        expect(renamed[0]?.headers.get('x-my-csrf')).toBe('tok-fedcba0987654321');
        expect(renamed[0]?.headers.get('x-azeroth-csrf')).toBeNull();
    });

    it('no readable cookie means no header - the server guard answers loudly instead', async () =>
    {
        // A configured cookie name that was never minted: the jar has nothing to mirror.
        const seen: Request[] = [];
        await clientSeeing(seen, { cookie: 'never-minted' }).posts.create({ title: 'x' });
        expect(seen.map((request) => `${ request.method } ${ new URL(request.url).pathname }`))
            .toEqual(['GET /api/__azeroth/csrf', 'POST /api/posts/create']);
        expect(seen[1]?.headers.get('x-azeroth-csrf')).toBeNull();
    });
});

describe('the action client on a page that carries no token', () =>
{
    /** A transport whose token endpoint sets the cookie the way csrfCookie does. */
    function minting(seen: Request[]): ReturnType<typeof createClient<{ posts: typeof posts }>>
    {
        return createClient<{ posts: typeof posts }>(manifestOf({ posts }), {
            baseUrl: '/api',
            fetch: async (request) =>
            {
                seen.push(request);
                if (new URL(request.url).pathname === '/api/__azeroth/csrf')
                {
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    document.cookie = 'azcsrf=tok-minted-by-the-endpoint';
                    return new Response(null, { status: 204 });
                }
                return new Response('{}', { headers: { 'content-type': 'application/json' } });
            }
        });
    }

    it('asks the endpoint under its baseUrl before the first action, and mirrors what it set', async () =>
    {
        const seen: Request[] = [];
        await minting(seen).posts.create({ title: 'x' });
        expect(seen.map((request) => `${ request.method } ${ new URL(request.url).pathname }`))
            .toEqual(['GET /api/__azeroth/csrf', 'POST /api/posts/create']);
        expect(seen[1]?.headers.get('x-azeroth-csrf')).toBe('tok-minted-by-the-endpoint');
    });

    it('concurrent first actions share one request, so they mirror one token', async () =>
    {
        const seen: Request[] = [];
        const client = minting(seen);
        await Promise.all([client.posts.create({ title: 'a' }), client.posts.create({ title: 'b' }), client.posts.create({ title: 'c' })]);
        expect(seen.filter((request) => request.method === 'GET')).toHaveLength(1);
        expect(seen.filter((request) => request.method === 'POST').map((request) => request.headers.get('x-azeroth-csrf')))
            .toEqual(['tok-minted-by-the-endpoint', 'tok-minted-by-the-endpoint', 'tok-minted-by-the-endpoint']);
    });

    it('shares the one request with <Form>, so a submit and an action fired together hold one token', async () =>
    {
        const seen: Request[] = [];
        let formAsks = 0;
        const formAsk = askCsrfCookie('/todo', false, async () =>
        {
            formAsks += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            document.cookie = 'azcsrf=tok-minted-for-the-form';
        });
        await Promise.all([formAsk, minting(seen).posts.create({ title: 'x' })]);
        expect(formAsks).toBe(1);
        expect(seen.map((request) => request.method)).toEqual(['POST']);
        expect(seen[0]?.headers.get('x-azeroth-csrf')).toBe('tok-minted-for-the-form');
    });

    it('still asks where a document holds cookies but there is no location to compare', async () =>
    {
        vi.stubGlobal('location', undefined);
        try
        {
            const seen: Request[] = [];
            await minting(seen).posts.create({ title: 'x' });
            expect(seen.map((request) => `${ request.method } ${ new URL(request.url).pathname }`))
                .toEqual(['GET /api/__azeroth/csrf', 'POST /api/posts/create']);
        }
        finally
        {
            vi.unstubAllGlobals();
        }
    });

    it('asks once per client: an answer that sets no cookie is not asked again', async () =>
    {
        const seen: Request[] = [];
        const client = clientSeeing(seen);
        await client.posts.create({ title: 'a' });
        await client.posts.create({ title: 'b' });
        expect(seen.map((request) => `${ request.method } ${ new URL(request.url).pathname }`))
            .toEqual(['GET /api/__azeroth/csrf', 'POST /api/posts/create', 'POST /api/posts/create']);
    });

    it('asks again after an ask that never reached the server', async () =>
    {
        const seen: string[] = [];
        let down = true;
        const client = createClient<{ posts: typeof posts }>(manifestOf({ posts }), {
            baseUrl: '/api',
            fetch: (request) =>
            {
                seen.push(`${ request.method } ${ new URL(request.url).pathname }`);
                if (request.method === 'GET' && down)
                {
                    down = false;
                    return Promise.reject(new TypeError('network down'));
                }
                return Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
            }
        });
        for (const title of ['a', 'b', 'c'])
        {
            await client.posts.create({ title });
        }
        expect(seen).toEqual(['GET /api/__azeroth/csrf', 'POST /api/posts/create', 'GET /api/__azeroth/csrf', 'POST /api/posts/create', 'POST /api/posts/create']);
    });

    it('a client that only joined a <Form> ask, which set nothing, asks on its own next action', async () =>
    {
        const seen: Request[] = [];
        const client = clientSeeing(seen);
        const formAsk = askCsrfCookie('/todo', false, () => new Promise((resolve) => setTimeout(resolve, 5)));
        await Promise.all([formAsk, client.posts.create({ title: 'a' })]);
        await client.posts.create({ title: 'b' });
        expect(seen.map((request) => `${ request.method } ${ new URL(request.url).pathname }`))
            .toEqual(['POST /api/posts/create', 'GET /api/__azeroth/csrf', 'POST /api/posts/create']);
    });

    it('CONTROL: with no origin to resolve against, the error names the action, not the ask', async () =>
    {
        vi.stubGlobal('location', undefined);
        try
        {
            await expect(createClient<{ posts: typeof posts }>(manifestOf({ posts }), { baseUrl: '/api' }).posts.create({ title: 'x' }))
                .rejects.toThrow('there is no origin here: POST /api/posts/create found no');
        }
        finally
        {
            vi.unstubAllGlobals();
        }
    });

    it('CONTROL: never asks for a baseUrl on another origin, and a token the page holds still rides the header', async () =>
    {
        const send = async (): Promise<string[]> =>
        {
            const seen: Request[] = [];
            await createClient<{ posts: typeof posts }>(manifestOf({ posts }), {
                baseUrl: 'https://api.elsewhere.example/api',
                fetch: (request) =>
                {
                    seen.push(request);
                    return Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
                }
            }).posts.create({ title: 'x' });
            return seen.map((request) => `${ request.method } ${ request.url } ${ request.headers.get('x-azeroth-csrf') ?? '' }`.trim());
        };
        expect(await send()).toEqual(['POST https://api.elsewhere.example/api/posts/create']);
        document.cookie = 'azcsrf=HELD-token-in-the-jar-0123456789';
        expect(await send()).toEqual(['POST https://api.elsewhere.example/api/posts/create HELD-token-in-the-jar-0123456789']);
    });

    it('an absolute baseUrl on this origin still asks', async () =>
    {
        const seen: Request[] = [];
        await createClient<{ posts: typeof posts }>(manifestOf({ posts }), {
            baseUrl: `${ location.origin }/api`,
            fetch: (request) =>
            {
                seen.push(request);
                return Promise.resolve(new Response(null, { status: 204 }));
            }
        }).posts.create({ title: 'x' });
        expect(seen.map((request) => `${ request.method } ${ new URL(request.url).pathname }`))
            .toEqual(['GET /api/__azeroth/csrf', 'POST /api/posts/create']);
    });

    it('CONTROL: csrf: false asks for nothing, and a plain GET never asks', async () =>
    {
        const disabled: Request[] = [];
        await clientSeeing(disabled, false).posts.create({ title: 'x' });
        expect(disabled.map((request) => request.method)).toEqual(['POST']);
        const reads: Request[] = [];
        await minting(reads).posts.list();
        expect(reads.map((request) => request.method)).toEqual(['GET']);
        expect(new URL(reads[0]?.url ?? '').pathname).toBe('/api/posts');
    });

    it('a lone azcsrf does not count as held over plain http either: it asks, and mirrors the __Host- cookie', async () =>
    {
        document.cookie = 'azcsrf=LEFT-by-a-secure-false-run-0123456789';
        const seen: Request[] = [];
        try
        {
            await createClient<{ posts: typeof posts }>(manifestOf({ posts }), {
                baseUrl: '/api',
                fetch: (request) =>
                {
                    seen.push(request);
                    if (request.method === 'GET')
                    {
                        document.cookie = '__Host-azcsrf=MINTED-for-this-host-0123456789; Path=/; Secure';
                    }
                    return Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
                }
            }).posts.create({ title: 'x' });
        }
        finally
        {
            document.cookie = '__Host-azcsrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure';
        }
        expect(location.protocol).toBe('http:');
        expect(seen.map((request) => `${ request.method } ${ new URL(request.url).pathname }`))
            .toEqual(['GET /api/__azeroth/csrf', 'POST /api/posts/create']);
        expect(seen[1]?.headers.get('x-azeroth-csrf')).toBe('MINTED-for-this-host-0123456789');
    });
});

describe('the action client on an https page', () =>
{
    const dom = (globalThis as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM;
    let restore = '';

    beforeEach(() =>
    {
        restore = location.href;
        dom.setURL('https://site.test/');
    });

    afterEach(() =>
    {
        document.cookie = '__Host-azcsrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure';
        document.cookie = 'azcsrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/';
        dom.setURL(restore);
    });

    it('a plain azcsrf a sibling subdomain planted does not count as held: it asks, and mirrors the __Host- cookie', async () =>
    {
        document.cookie = 'azcsrf=PLANTED-by-a-sibling-0123456789; Path=/';
        const seen: Request[] = [];
        await createClient<{ posts: typeof posts }>(manifestOf({ posts }), {
            baseUrl: '/api',
            fetch: (request) =>
            {
                seen.push(request);
                if (new URL(request.url).pathname === '/api/__azeroth/csrf')
                {
                    document.cookie = '__Host-azcsrf=MINTED-for-this-host-0123456789; Path=/; Secure';
                    return Promise.resolve(new Response(null, { status: 204 }));
                }
                return Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
            }
        }).posts.create({ title: 'x' });
        expect(seen.map((request) => `${ request.method } ${ new URL(request.url).pathname }`))
            .toEqual(['GET /api/__azeroth/csrf', 'POST /api/posts/create']);
        expect(seen[1]?.headers.get('x-azeroth-csrf')).toBe('MINTED-for-this-host-0123456789');
    });

    it('a held __Host-azcsrf beside a planted azcsrf asks once, and wins when the answer names no pair', async () =>
    {
        document.cookie = 'azcsrf=PLANTED-by-a-sibling-0123456789; Path=/';
        document.cookie = '__Host-azcsrf=HELD-for-this-host-0123456789; Path=/; Secure';
        const seen: Request[] = [];
        await clientSeeing(seen).posts.create({ title: 'x' });
        expect(seen.map((request) => request.method)).toEqual(['GET', 'POST']);
        expect(seen[1]?.headers.get('x-azeroth-csrf')).toBe('HELD-for-this-host-0123456789');
    });

    it('the __Host- pair the answer names rides before its cookie shows, never a planted azcsrf', async () =>
    {
        document.cookie = 'azcsrf=PLANTED-by-a-sibling-0123456789; Path=/';
        const seen: Request[] = [];
        await naming(seen, '__Host-azcsrf=MINTED-for-this-host-0123456789').posts.create({ title: 'x' });
        expect(seen.map((request) => request.method)).toEqual(['GET', 'POST']);
        expect(seen[1]?.headers.get('x-azeroth-csrf')).toBe('MINTED-for-this-host-0123456789');
    });
});

describe('the action client when the answer names the cookie it compares and its token', () =>
{
    afterEach(() =>
    {
        document.cookie = '__Host-azcsrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure';
    });

    it('mirrors the token the answer names before the browser shows its cookie', async () =>
    {
        const seen: Request[] = [];
        const client = naming(seen, 'azcsrf=tok-named-by-the-answer-0123456789');
        await client.posts.create({ title: 'a' });
        expect(seen.map((request) => `${ request.method } ${ new URL(request.url).pathname }`))
            .toEqual(['GET /api/__azeroth/csrf', 'POST /api/posts/create']);
        expect(seen[1]?.headers.get('x-azeroth-csrf')).toBe('tok-named-by-the-answer-0123456789');
    });

    it('a jar holding both default names asks, and mirrors the one the answer names over a stale __Host-azcsrf', async () =>
    {
        document.cookie = '__Host-azcsrf=STALE-left-by-local-production-0123; Path=/; Secure';
        document.cookie = 'azcsrf=HELD-for-the-dev-server-0123456789';
        const seen: Request[] = [];
        await naming(seen, 'azcsrf=HELD-for-the-dev-server-0123456789').posts.create({ title: 'x' });
        expect(seen.map((request) => request.method)).toEqual(['GET', 'POST']);
        expect(seen[1]?.headers.get('x-azeroth-csrf')).toBe('HELD-for-the-dev-server-0123456789');
    });

    it('a renamed cookie mirrors the token the answer names under that name before the cookie shows', async () =>
    {
        const seen: Request[] = [];
        await naming(seen, 'renamed=tok-named-for-the-renamed-cookie', { cookie: 'renamed' }).posts.create({ title: 'x' });
        expect(seen.map((request) => request.method)).toEqual(['GET', 'POST']);
        expect(seen[1]?.headers.get('x-azeroth-csrf')).toBe('tok-named-for-the-renamed-cookie');
    });

    it('asks again once the cookie the answer named is gone, as after a logout', async () =>
    {
        document.cookie = 'azcsrf=tok-named-by-the-answer-0123456789';
        const seen: Request[] = [];
        const client = naming(seen, 'azcsrf=tok-named-by-the-answer-0123456789');
        await client.posts.create({ title: 'a' });
        document.cookie = 'azcsrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
        await client.posts.create({ title: 'b' });
        expect(seen.map((request) => request.method)).toEqual(['GET', 'POST', 'GET', 'POST']);
    });

    it('a client that joined an ask naming another cookie mirrors it once, then asks on its own', async () =>
    {
        document.cookie = 'renamed=OTHER-server-token-0123456789';
        const seen: Request[] = [];
        const client = naming(seen, 'azcsrf=tok-named-by-the-answer-0123456789');
        const other = askCsrfCookie('/a/posts', false, async () =>
        {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return new Response(null, { status: 204, headers: { 'x-azeroth-csrf-cookie': 'renamed=OTHER-server-token-0123456789' } });
        });
        await Promise.all([other, client.posts.create({ title: 'a' })]);
        await client.posts.create({ title: 'b' });
        expect(seen.map((request) => `${ request.method } ${ request.headers.get('x-azeroth-csrf') ?? '' }`.trim()))
            .toEqual(['POST OTHER-server-token-0123456789', 'GET', 'POST tok-named-by-the-answer-0123456789']);
    });

    it('asks inside an origin-wide lock where the browser has one, so two tabs never ask at once', async () =>
    {
        const taken: string[] = [];
        let release = (): void => undefined;
        const otherTab = new Promise<void>((resolve) =>
        {
            release = resolve;
        });
        vi.stubGlobal('navigator', { locks: { request: async (name: string, _options: LockOptions, ask: () => Promise<unknown>): Promise<unknown> =>
        {
            taken.push(name);
            await otherTab;
            return ask();
        } } });
        try
        {
            const seen: Request[] = [];
            const pending = naming(seen, 'azcsrf=tok-named-by-the-answer-0123456789').posts.create({ title: 'x' });
            await new Promise((resolve) => setTimeout(resolve, 5));
            expect(seen).toEqual([]);
            release();
            await pending;
            expect(taken).toEqual(['azeroth-csrf-ask']);
            expect(seen.map((request) => request.method)).toEqual(['GET', 'POST']);
        }
        finally
        {
            vi.unstubAllGlobals();
        }
    });

    it('asks without the lock once it has waited ten seconds for a tab that never lets it go', async () =>
    {
        vi.useFakeTimers();
        let refuse = (): void => undefined;
        vi.stubGlobal('navigator', { locks: { request: (_name: string, options: LockOptions): Promise<unknown> => new Promise((_resolve, reject) =>
        {
            refuse = (): void => reject(new DOMException('aborted', 'AbortError'));
            options.signal?.addEventListener('abort', refuse);
        }) } });
        const seen: Request[] = [];
        const pending = naming(seen, 'azcsrf=tok-named-by-the-answer-0123456789').posts.create({ title: 'x' });
        try
        {
            await vi.advanceTimersByTimeAsync(9999);
            expect(seen).toEqual([]);
            await vi.advanceTimersByTimeAsync(1);
            expect(seen.map((request) => `${ request.method } ${ request.headers.get('x-azeroth-csrf') ?? '' }`.trim()))
                .toEqual(['GET', 'POST tok-named-by-the-answer-0123456789']);
        }
        finally
        {
            // Settles the page's one flight even when this fails, so no later test joins it.
            refuse();
            await pending;
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });

    it('lets the lock go after five seconds over an ask that has not settled, and still waits for it', async () =>
    {
        vi.useFakeTimers();
        let released = false;
        vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: LockOptions, ask: () => Promise<unknown>): Promise<unknown> => ask().then((value) =>
        {
            released = true;
            return value;
        }) } });
        let answer = (_response: Response): void => undefined;
        const seen: Request[] = [];
        const pending = createClient<{ posts: typeof posts }>(manifestOf({ posts }), {
            baseUrl: '/api',
            fetch: (request) =>
            {
                seen.push(request);
                return request.method === 'GET'
                    ? new Promise<Response>((resolve) =>
                    {
                        answer = resolve;
                    })
                    : Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
            }
        }).posts.create({ title: 'x' });
        try
        {
            await vi.advanceTimersByTimeAsync(4999);
            expect(released).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(released).toBe(true);
            expect(seen.map((request) => request.method)).toEqual(['GET']);
        }
        finally
        {
            answer(new Response(null, { status: 204, headers: { 'x-azeroth-csrf-cookie': 'azcsrf=tok-named-by-the-answer-0123456789' } }));
            await pending;
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
        expect(seen.map((request) => `${ request.method } ${ request.headers.get('x-azeroth-csrf') ?? '' }`.trim()))
            .toEqual(['GET', 'POST tok-named-by-the-answer-0123456789']);
    });

    it('asks without the lock where the browser refuses it', async () =>
    {
        vi.stubGlobal('navigator', { locks: { request: (): Promise<unknown> => Promise.reject(new DOMException('denied', 'SecurityError')) } });
        try
        {
            const seen: Request[] = [];
            await naming(seen, 'azcsrf=tok-named-by-the-answer-0123456789').posts.create({ title: 'x' });
            expect(seen.map((request) => `${ request.method } ${ request.headers.get('x-azeroth-csrf') ?? '' }`.trim()))
                .toEqual(['GET', 'POST tok-named-by-the-answer-0123456789']);
        }
        finally
        {
            vi.unstubAllGlobals();
        }
    });

    it('leaves no timer behind once an ask under a free lock settles', async () =>
    {
        vi.useFakeTimers();
        vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: LockOptions, ask: () => Promise<unknown>): Promise<unknown> => Promise.resolve().then(ask) } });
        try
        {
            const pair = await askCsrfCookie('/api/posts/create', false, () => Promise.resolve(new Response(null, { status: 204, headers: { 'x-azeroth-csrf-cookie': 'azcsrf=tok-named-by-the-answer-0123456789' } })));
            expect(pair).toEqual({ cookie: 'azcsrf', token: 'tok-named-by-the-answer-0123456789' });
            expect(vi.getTimerCount()).toBe(0);
        }
        finally
        {
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });

    it('reads an answer that names a cookie with no token as naming none, and mirrors the cookie it holds', async () =>
    {
        document.cookie = '__Host-azcsrf=HELD-for-this-host-0123456789; Path=/; Secure';
        document.cookie = 'azcsrf=LEFT-by-another-server-0123456789';
        const seen: Request[] = [];
        await naming(seen, 'azcsrf=').posts.create({ title: 'x' });
        expect(seen.map((request) => `${ request.method } ${ request.headers.get('x-azeroth-csrf') ?? '' }`.trim()))
            .toEqual(['GET', 'POST HELD-for-this-host-0123456789']);
    });

    it('mirrors a percent-encoded cookie as the server decodes it', async () =>
    {
        document.cookie = '__Host-azcsrf=tok%2Bencoded%2Fvalue-0123456789; Path=/; Secure';
        const seen: Request[] = [];
        await clientSeeing(seen).posts.create({ title: 'x' });
        expect(seen.map((request) => request.method)).toEqual(['POST']);
        expect(seen[0]?.headers.get('x-azeroth-csrf')).toBe('tok+encoded/value-0123456789');
    });
});

/** A token endpoint that names `pair` as csrfCookie does and sets no cookie yet. */
function naming(seen: Request[], pair: string, csrf?: { cookie?: string }): ReturnType<typeof createClient<{ posts: typeof posts }>>
{
    return createClient<{ posts: typeof posts }>(manifestOf({ posts }), {
        baseUrl: '/api',
        ...(csrf === undefined ? {} : { csrf }),
        fetch: (request) =>
        {
            seen.push(request);
            return Promise.resolve(request.method === 'GET'
                ? new Response(null, { status: 204, headers: { 'x-azeroth-csrf-cookie': pair } })
                : new Response('{}', { headers: { 'content-type': 'application/json' } }));
        }
    });
}

describe('the action client when its baseUrl is served apart from the page', () =>
{
    it('asks under the page\'s own path when nothing answers under the baseUrl, and mirrors what that set', async () =>
    {
        const seen: string[] = [];
        await createClient<{ posts: typeof posts }>(manifestOf({ posts }), {
            baseUrl: '/api',
            fetch: (request) =>
            {
                const path = new URL(request.url).pathname;
                seen.push(`${ request.method } ${ path }`);
                if (path === '/api/__azeroth/csrf')
                {
                    return Promise.resolve(new Response(null, { status: 404 }));
                }
                if (path.endsWith('/__azeroth/csrf'))
                {
                    document.cookie = 'azcsrf=tok-from-the-page-server';
                    return Promise.resolve(new Response(null, { status: 204 }));
                }
                return Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
            }
        }).posts.create({ title: 'x' });
        expect(seen).toEqual(['GET /api/__azeroth/csrf', `GET ${ location.pathname.replace(/\/+$/, '') }/__azeroth/csrf`, 'POST /api/posts/create']);
    });

    it('asks on the page\'s own origin when the page\'s path starts with //', async () =>
    {
        const dom = (globalThis as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM;
        const restore = location.href;
        dom.setURL('https://site.test//evil.test/x');
        try
        {
            const seen: string[] = [];
            await createClient<{ posts: typeof posts }>(manifestOf({ posts }), {
                baseUrl: '/api',
                fetch: (request) =>
                {
                    const url = new URL(request.url);
                    seen.push(`${ request.method } ${ url.origin }${ url.pathname }`);
                    return Promise.resolve(request.method === 'GET'
                        ? new Response(null, { status: url.pathname === '/api/__azeroth/csrf' ? 404 : 204 })
                        : new Response('{}', { headers: { 'content-type': 'application/json' } }));
                }
            }).posts.create({ title: 'x' });
            expect(seen).toEqual([
                'GET https://site.test/api/__azeroth/csrf',
                'GET https://site.test//evil.test/x/__azeroth/csrf',
                'POST https://site.test/api/posts/create'
            ]);
        }
        finally
        {
            dom.setURL(restore);
        }
    });
});
