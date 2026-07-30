// @vitest-environment node
//
// `implement` types a feature's handlers from its OWN route group. These are TYPE assertions
// first: the point is that a feature file needs no reference to the assembled contract, and its
// handler contexts still derive - which is what killed the hand-written annotations that the
// old Pick<HandlersWithGuards<...>> ceremony provoked.
import { describe, it, expect, expectTypeOf } from 'vitest';
import { App } from '@azerothjs/http';
import { object, string, number } from '@azerothjs/schema';
import { defineContract, get, post, guard, implement, mountApi, type HandlersOf } from '@azerothjs/http/api';

// A feature declares its own routes, in its own file, knowing nothing of the tree it joins.
const consoleRoutes = {
    signIn: post('/admin/session', { input: object({ key: string() }) }),
    overview: get('/admin/overview', { output: object({ owed: number() }) }),
    orders: get('/admin/orders', { query: object({ page: number({ coerce: true }).optional() }), output: object({ total: number() }) })
};

// Another feature, same shape.
const catalogueRoutes = {
    tiers: get('/admin/tiers', { output: object({ count: number() }) })
};

interface Authed { accountId: number }

describe('implement - a feature types itself from its own routes', () =>
{
    it('derives input, query, params and output with no contract reference', () =>
    {
        const handlers = implement(consoleRoutes, {
            signIn: (context) =>
            {
                expectTypeOf(context.input).toEqualTypeOf<{ key: string }>();
                return new Response(null, { status: 204 });
            },
            overview: () => ({ owed: 3 }),
            orders: (context) =>
            {
                expectTypeOf(context.query.page).toEqualTypeOf<number | undefined>();
                return { total: 0 };
            }
        });

        // Identity at runtime: the object handed in is the object handed back.
        expectTypeOf(handlers.overview).toBeFunction();
        expect(typeof handlers.overview).toBe('function');
    });

    it('carries the guards additions when the group runs behind one', () =>
    {
        const handlers = implement<typeof consoleRoutes, Authed>(consoleRoutes, {
            signIn: () => new Response(null, { status: 204 }),
            overview: (context) =>
            {
                expectTypeOf(context.accountId).toEqualTypeOf<number>();   // TYPED, no cast
                return { owed: context.accountId };
            },
            orders: (context) =>
            {
                expectTypeOf(context.accountId).toEqualTypeOf<number>();
                return { total: 1 };
            }
        });
        expect(typeof handlers.orders).toBe('function');
    });

    it('rejects a missing, extra, or wrongly-typed handler', () =>
    {
        // @ts-expect-error - `orders` is declared by the routes and has no handler.
        const missing: HandlersOf<typeof consoleRoutes> = {
            signIn: () => new Response(null),
            overview: () => ({ owed: 0 })
        };
        void missing;

        const extra: HandlersOf<typeof consoleRoutes> = {
            signIn: () => new Response(null),
            overview: () => ({ owed: 0 }),
            orders: () => ({ total: 0 }),
            // @ts-expect-error - `nope` is not a route in this group.
            nope: () => ({})
        };
        void extra;

        const wrongOutput: HandlersOf<typeof consoleRoutes> = {
            signIn: () => new Response(null),
            // @ts-expect-error - overview's output schema is { owed: number }.
            overview: () => ({ owed: 'three' }),
            orders: () => ({ total: 0 })
        };
        void wrongOutput;
        expect(true).toBe(true);
    });

    it('composes into a mounted contract and answers for real', async () =>
    {
        // The tree is assembled where the halves meet; each feature contributed its own group.
        const contract = defineContract({ admin: { ...consoleRoutes, ...catalogueRoutes } });
        const requireAuth = guard(() => ({ accountId: 7 }));

        // Mount the GROUP, not the whole tree: handler and guard keys are then relative to it, so
        // each feature's own keys compose with a plain spread and no feature states its prefix.
        const app = new App();
        mountApi(app, contract.admin, {
            prefix: '',
            guards: { '*': [requireAuth] },
            handlers: {
                ...implement<typeof consoleRoutes, Authed>(consoleRoutes, {
                    signIn: () => new Response(null, { status: 204 }),
                    overview: (context) => ({ owed: context.accountId }),
                    orders: () => ({ total: 2 })
                }),
                ...implement<typeof catalogueRoutes, Authed>(catalogueRoutes, {
                    tiers: (context) => ({ count: context.accountId })
                })
            }
        });

        expect(await (await app.handle(new Request('http://local/admin/overview'))).json()).toEqual({ owed: 7 });
        expect(await (await app.handle(new Request('http://local/admin/tiers'))).json()).toEqual({ count: 7 });
    });
});
