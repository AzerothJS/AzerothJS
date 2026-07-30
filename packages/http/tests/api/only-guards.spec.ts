// @vitest-environment node
//
// `only` is what makes a group wildcard usable: guard the whole group, then name the
// exceptions. The property that matters is that the RUNTIME chain and the handler's context
// TYPE agree - a route that opts out must not be typed as carrying additions no guard ran to
// attach, or the handler reads undefined through a field TypeScript swore was there.
import { describe, it, expect, expectTypeOf } from 'vitest';
import { App } from '@azerothjs/http';
import { object, string, number } from '@azerothjs/schema';
import { defineContract, get, post, guard, only, mountApi, type HandlersWithGuards } from '@azerothjs/http/api';

const contract = defineContract({
    admin: {
        signIn: post('/admin/session', { input: object({ key: string() }) }),
        overview: get('/admin/overview', { output: object({ id: number() }) }),
        orders: get('/admin/orders', { output: object({ id: number() }) })
    }
});

const seen: string[] = [];
const requireAdmin = guard((context) =>
{
    seen.push('requireAdmin');
    if (context.request.headers.get('authorization') === null)
    {
        return new Response('no', { status: 401 });
    }
    return { accountId: 7 };
});
const throttle = guard(() =>
{
    seen.push('throttle');
    return { throttled: true as const };
});
const tag = guard(() =>
{
    seen.push('tag');
    return { tag: 'v1' as const };
});

describe('only - one wildcard guards the group, exceptions are named', () =>
{
    const guards = { '*': [tag], 'admin.*': [requireAdmin], 'admin.signIn': only([throttle]) };

    function build(): App
    {
        const app = new App();
        mountApi(app, contract, {
            prefix: '',
            guards,
            handlers: {
                'admin.signIn': (context) =>
                {
                    // Its own guard's addition IS present...
                    expectTypeOf(context.throttled).toEqualTypeOf<true>();
                    // ...and the ones it opted out of are NOT, at the type level.
                    expectTypeOf(context).not.toHaveProperty('accountId');
                    expectTypeOf(context).not.toHaveProperty('tag');
                    return new Response(null, { status: 204 });
                },
                'admin.overview': (context) =>
                {
                    expectTypeOf(context.accountId).toEqualTypeOf<number>();
                    expectTypeOf(context.tag).toEqualTypeOf<'v1'>();
                    return { id: context.accountId };
                },
                'admin.orders': (context) => ({ id: context.accountId })
            }
        });
        return app;
    }

    it('runs ONLY the listed guards on the opted-out route', async () =>
    {
        seen.length = 0;
        const response = await build().handle(new Request('http://local/admin/session', {
            method: 'POST', body: JSON.stringify({ key: 'k' }), headers: { 'content-type': 'application/json' }
        }));
        expect(response.status).toBe(204);              // requireAdmin never ran, so no 401
        expect(seen).toEqual(['throttle']);              // not tag, not requireAdmin
    });

    it('still inherits global + group on every other route', async () =>
    {
        seen.length = 0;
        const ok = await build().handle(new Request('http://local/admin/overview', { headers: { authorization: 'x' } }));
        expect(await ok.json()).toEqual({ id: 7 });
        expect(seen).toEqual(['tag', 'requireAdmin']);   // outermost first
    });

    it('the group guard still protects a route that did NOT opt out', async () =>
    {
        const denied = await build().handle(new Request('http://local/admin/orders'));
        expect(denied.status).toBe(401);
    });

    it('only([]) declares a route deliberately unguarded under a guarded group', async () =>
    {
        // The real case: signing OUT must work with an expired session, because clearing a
        // cookie cannot require the credential it is clearing. An empty `only` says so, and
        // must still leave the handler a usable context rather than collapsing it.
        const app = new App();
        mountApi(app, contract, {
            prefix: '',
            guards: { 'admin.*': [requireAdmin], 'admin.orders': only([]) },
            handlers: {
                'admin.signIn': () => new Response(null, { status: 204 }),
                'admin.overview': (context) => ({ id: context.accountId }),
                'admin.orders': (context) =>
                {
                    expectTypeOf(context.request).toEqualTypeOf<Request>();
                    return { id: 0 };
                }
            }
        });

        seen.length = 0;
        const open = await app.handle(new Request('http://local/admin/orders'));   // no auth header
        expect(open.status).toBe(200);
        expect(seen).toEqual([]);                                                   // nothing ran
    });

    it('a route added to the group later is guarded by default (type level)', () =>
    {
        // The point of the wildcard: `orders` never named requireAdmin, yet carries its
        // additions. Forgetting to guard a new admin route is not possible here - only
        // forgetting to EXEMPT one, which fails loudly instead of leaking.
        type OrdersCtx = Parameters<HandlersWithGuards<typeof contract, typeof guards>['admin.orders']>[0];
        expectTypeOf<OrdersCtx>().toHaveProperty('accountId');
        type SignInCtx = Parameters<HandlersWithGuards<typeof contract, typeof guards>['admin.signIn']>[0];
        expectTypeOf<SignInCtx>().not.toHaveProperty('accountId');
        expect(true).toBe(true);
    });
});
