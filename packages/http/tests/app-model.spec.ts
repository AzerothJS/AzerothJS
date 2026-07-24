// @vitest-environment node
//
// The middleware model: typed context accumulation with lexical ordering and no next().
// The properties pinned here ARE the design's load-bearing answers: additions flow by return value
// (never mutation from the middleware's side), the type system gates what downstream sees,
// a Response short-circuits, and a route above a `use` is untouched by it.

import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { App } from '../src/app.ts';
import { json, noContent } from '../src/respond.ts';
import { UnauthorizedError } from '../src/errors.ts';

function get(app: App<never> | { handle(request: Request): Promise<Response> }, path: string, init: RequestInit = {}): Promise<Response>
{
    return (app).handle(new Request(`http://local${ path }`, init));
}

describe('typed context accumulation', () =>
{
    it('each use() adds to the context every LATER route sees - runtime and type level', async () =>
    {
        const app = new App()
            .use(() => ({ requestId: 'r-1' }))
            .use((_request, ctx) =>
            {
                expectTypeOf(ctx.requestId).toEqualTypeOf<string>();
                return { user: { name: 'jaina', admin: true } };
            });

        app.get('/me', (_request, ctx) =>
        {
            expectTypeOf(ctx.requestId).toEqualTypeOf<string>();
            expectTypeOf(ctx.user.admin).toEqualTypeOf<boolean>();
            return json({ id: ctx.requestId, user: ctx.user.name, params: ctx.params });
        });

        expect(await (await get(app, '/me')).json()).toEqual({ id: 'r-1', user: 'jaina', params: {} });
    });

    it('ordering is lexical: a route registered BEFORE a use() never runs it', async () =>
    {
        const ran = vi.fn();
        const app = new App();
        app.get('/before', () => noContent());
        app.use(() =>
        {
            ran();
            return { later: true };
        });
        app.get('/after', () => noContent());

        await get(app, '/before');
        expect(ran).not.toHaveBeenCalled();
        await get(app, '/after');
        expect(ran).toHaveBeenCalledTimes(1);
    });

    it('middleware run in registration order and see prior additions', async () =>
    {
        const seen: string[] = [];
        const app = new App()
            .use(() =>
            {
                seen.push('first');
                return { a: 1 };
            })
            .use((_request, ctx) =>
            {
                seen.push(`second-sees-a=${ ctx.a }`);
                return { b: 2 };
            });
        app.get('/x', (_request, ctx) => json({ sum: ctx.a + ctx.b }));

        expect(await (await get(app, '/x')).json()).toEqual({ sum: 3 });
        expect(seen).toEqual(['first', 'second-sees-a=1']);
    });

    it('async middleware work identically', async () =>
    {
        const app = new App().use(async () =>
        {
            await Promise.resolve();
            return { fetched: 'yes' };
        });
        app.get('/x', (_request, ctx) => json({ fetched: ctx.fetched }));
        expect(await (await get(app, '/x')).json()).toEqual({ fetched: 'yes' });
    });

    it('a void middleware adds nothing and continues the chain', async () =>
    {
        const observed = vi.fn();
        const app = new App().use(() =>
        {
            observed(); // pure observation (logging) - no return
        });
        app.get('/x', () => noContent());
        expect((await get(app, '/x')).status).toBe(204);
        expect(observed).toHaveBeenCalledTimes(1);
    });
});

describe('guards: a Response short-circuits', () =>
{
    it('the handler never runs when a guard denies', async () =>
    {
        const handler = vi.fn(() => noContent());
        const app = new App().use((request) =>
        {
            if (request.headers.get('authorization') === null)
            {
                throw new UnauthorizedError();
            }
            return { authed: true };
        });
        app.get('/private', handler);

        const denied = await get(app, '/private');
        expect(denied.status).toBe(401);
        expect(handler).not.toHaveBeenCalled();

        const allowed = await get(app, '/private', { headers: { authorization: 'Bearer x' } });
        expect(allowed.status).toBe(204);
    });

    it('a middleware can answer directly with a Response (cache hit)', async () =>
    {
        const app = new App().use((request) =>
            (request.headers.get('if-cached') !== null ? json({ cached: true }) : undefined));
        app.get('/data', () => json({ cached: false }));

        expect(await (await get(app, '/data', { headers: { 'if-cached': '1' } })).json()).toEqual({ cached: true });
        expect(await (await get(app, '/data')).json()).toEqual({ cached: false });
    });

    it('a throwing middleware flows through the one error path', async () =>
    {
        const app = new App().use(() =>
        {
            throw new Error('middleware exploded');
        });
        app.get('/x', () => noContent());
        const response = await get(app, '/x');
        expect(response.status).toBe(500);
        expect(JSON.stringify(await response.json())).not.toContain('exploded');
    });
});

describe('with(): scoped middleware', () =>
{
    it('runs its middleware only for routes registered through the fork, and types the addition', async () =>
    {
        const app = new App();
        const authed = app.with(() => ({ accountId: 7 }));
        authed.get('/me', (_request, ctx) =>
        {
            expectTypeOf(ctx.accountId).toEqualTypeOf<number>();
            return json({ id: ctx.accountId });
        });
        // The fork shares the parent's router, so the parent dispatches the scoped route.
        expect(await (await get(app, '/me')).json()).toEqual({ id: 7 });
    });

    it('does not touch routes registered directly on the parent app', async () =>
    {
        const ran = vi.fn();
        const app = new App();
        app.with(() =>
        {
            ran(); return { scoped: 1 };
        }).get('/scoped', (_r, ctx) => json({ v: ctx.scoped }));
        app.get('/open', () => noContent());

        await get(app, '/open');
        expect(ran).not.toHaveBeenCalled();
        await get(app, '/scoped');
        expect(ran).toHaveBeenCalledTimes(1);
    });

    it('chains: with(a).with(b) accumulates context in registration order', async () =>
    {
        const seen: string[] = [];
        const app = new App();
        app.with(() =>
        {
            seen.push('a'); return { a: 1 };
        })
            .with((_r, ctx) =>
            {
                seen.push(`b-sees-a=${ ctx.a }`); return { b: 2 };
            })
            .get('/x', (_r, ctx) =>
            {
                expectTypeOf(ctx.a).toEqualTypeOf<number>();
                expectTypeOf(ctx.b).toEqualTypeOf<number>();
                return json({ sum: ctx.a + ctx.b });
            });

        expect(await (await get(app, '/x')).json()).toEqual({ sum: 3 });
        expect(seen).toEqual(['a', 'b-sees-a=1']);
    });

    it('composes with global use(): global middleware run first, then the scoped ones', async () =>
    {
        const order: string[] = [];
        const app = new App().use(() =>
        {
            order.push('global'); return { g: 'G' };
        });
        app.with((_r, ctx) =>
        {
            expectTypeOf(ctx.g).toEqualTypeOf<string>(); // the fork sees the global addition's type
            order.push('scoped');
            return { s: 'S' };
        }).get('/x', (_r, ctx) => json({ g: ctx.g, s: ctx.s }));

        expect(await (await get(app, '/x')).json()).toEqual({ g: 'G', s: 'S' });
        expect(order).toEqual(['global', 'scoped']);
    });

    it('snapshots at fork time: a later app.use() does not reach into an already-opened fork', async () =>
    {
        const late = vi.fn();
        const app = new App();
        const fork = app.with(() => ({ a: 1 }));
        app.use(() =>
        {
            late(); return { b: 2 };
        }); // added AFTER the fork was opened
        fork.get('/x', (_r, ctx) => json({ a: ctx.a }));

        expect(await (await get(app, '/x')).json()).toEqual({ a: 1 });
        expect(late).not.toHaveBeenCalled();
    });

    it('a scoped guard short-circuits: the handler never runs when it denies', async () =>
    {
        const handler = vi.fn(() => noContent());
        const app = new App();
        app.with((request) =>
        {
            if (request.headers.get('authorization') === null)
            {
                throw new UnauthorizedError();
            }
            return { authed: true };
        }).get('/private', handler);

        expect((await get(app, '/private')).status).toBe(401);
        expect(handler).not.toHaveBeenCalled();
        expect((await get(app, '/private', { headers: { authorization: 'Bearer x' } })).status).toBe(204);
    });
});
