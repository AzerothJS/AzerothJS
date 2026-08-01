// @vitest-environment node
//
// Edge middleware through the SAME verb as app middleware.
//
// `rateLimit`, `cors`, `securityHeaders` and `requestId` wrap the whole dispatch - they must, because
// a rate limiter has to refuse before a route is matched and a preflight has to be answered for
// paths with no route. Unbranded, they are un-passable to `use`: an application wanting a rate limit
// builds a `pipeline(app, ...)` and hands THAT around instead of its App, and the error names a
// missing `handle` on RequestContext, which does not say "wrong middleware kind".
//
// The brand (`edge()`) is what lets one verb take both kinds without the framework growing a third.
import { describe, expect, it } from 'vitest';
import { App, edge, json, pipeline, rateLimit, securityHeaders } from '@azerothjs/http';

describe('app.use - one verb for both kinds of middleware', () =>
{
    it('applies an edge middleware and still returns the app', () =>
    {
        const app = new App();
        const same = app.use(securityHeaders());
        // The point: routes can still be registered after wrapping, and the value is still an App.
        expect(same).toBe(app);
        expect(typeof same.get).toBe('function');
    });

    it('runs the wrapper around dispatch, so it sees every route', async () =>
    {
        const app = new App();
        app.use(securityHeaders());
        app.get('/a', () => json({ ok: true }));
        app.get('/b', () => json({ ok: true }));

        for (const path of ['/a', '/b'])
        {
            const response = await app.handle(new Request(`http://local${ path }`));
            expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        }
    });

    it('rate limits through the same seam', async () =>
    {
        const app = new App();
        app.use(rateLimit({ limit: 2, windowMs: 60_000, key: () => 'fixed' }));
        app.get('/x', () => json({ ok: true }));

        expect((await app.handle(new Request('http://local/x'))).status).toBe(200);
        expect((await app.handle(new Request('http://local/x'))).status).toBe(200);
        expect((await app.handle(new Request('http://local/x'))).status).toBe(429);
    });

    it('applies wrappers outermost-FIRST, matching pipeline()', async () =>
    {
        const order: string[] = [];
        // How an application writes its OWN edge middleware: brand it with `edge`. An unbranded
        // wrapper is deliberately NOT accepted by `use`, or the ambiguity this brand removes
        // would come straight back.
        const mark = (name: string) => edge((next) => ({
            handle: async (request: Request): Promise<Response> =>
            {
                order.push(name);
                return await next.handle(request);
            }
        }));

        const app = new App();
        app.use(mark('first'));
        app.use(mark('second'));
        app.get('/x', () => json({ ok: true }));

        await app.handle(new Request('http://local/x'));
        // `pipeline(app, first, second)` runs first outermost; `use` must agree, or the framework
        // has two opposite orders for one concept.
        expect(order).toEqual(['first', 'second']);
    });

    it('composes in the SAME order as pipeline, for the same wrappers', async () =>
    {
        // The two ways to apply edge middleware must not disagree. They did: the reduce ran
        // left-to-right, making the LAST `use` outermost while `pipeline`'s first argument is
        // outermost. A security header's position would then depend on which API applied it.
        const trace = (order: string[]) => (name: string) => edge((next) => ({
            handle: async (request: Request): Promise<Response> =>
            {
                order.push(name);
                return await next.handle(request);
            }
        }));

        const viaUse: string[] = [];
        const used = new App();
        const markUse = trace(viaUse);
        used.use(markUse('a')).use(markUse('b')).use(markUse('c'));
        used.get('/x', () => json({ ok: true }));
        await used.handle(new Request('http://local/x'));

        const viaPipeline: string[] = [];
        const piped = new App();
        piped.get('/x', () => json({ ok: true }));
        const markPipe = trace(viaPipeline);
        await pipeline(piped, markPipe('a'), markPipe('b'), markPipe('c')).handle(new Request('http://local/x'));

        expect(viaUse).toEqual(viaPipeline);
        expect(viaUse).toEqual(['a', 'b', 'c']);
    });

    it('a wrapper that short-circuits stops the route from running', async () =>
    {
        let reached = false;
        const app = new App();
        app.use(edge(() => ({ handle: () => Promise.resolve(new Response('blocked', { status: 503 })) })));
        app.get('/x', () =>
        {
            reached = true;
            return json({ ok: true });
        });

        const response = await app.handle(new Request('http://local/x'));
        expect(response.status).toBe(503);
        expect(reached).toBe(false);
    });

    it('errors thrown by a wrapper still come back as a Response', async () =>
    {
        const app = new App({ dev: false });
        app.use(edge(() => ({
            handle: (): Promise<Response> =>
            {
                throw new Error('boom');
            }
        })));
        app.get('/x', () => json({ ok: true }));

        // handle() never throws - the contract the kernel promises everywhere else.
        const response = await app.handle(new Request('http://local/x'));
        expect(response.status).toBe(500);
    });
});
