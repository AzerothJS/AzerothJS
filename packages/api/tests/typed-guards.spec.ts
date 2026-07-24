// @vitest-environment node
//
// The unified typed mount: guard additions flow into handler context types (no cast),
// and guards-map keys are checked against the contract (a typo is a compile error).
// These are TYPE assertions first, runtime behavior second.
import { describe, it, expect, expectTypeOf } from 'vitest';
import { App } from '@azerothjs/http';
import { object, string, number } from '@azerothjs/schema';
import { defineContract, get, post, guard, mountApi, type GuardKey, type HandlersWithGuards } from '@azerothjs/api';

const contract = defineContract({
    health: get('/health', { output: object({ ok: string() }) }),
    account: {
        me: get('/me', { output: object({ id: number() }) }),
        update: post('/', { input: object({ name: string() }), output: object({ id: number() }) })
    }
});

const requireAuth = guard((context) =>
{
    if (context.request.headers.get('authorization') === null)
    {
        return new Response('no', { status: 401 });
    }
    return { accountId: 7 };
});

describe('typed guards - additions flow into the handler context, no cast', () =>
{
    it('a guarded handler reads the addition as a real type', async () =>
    {
        const app = new App();
        mountApi(app, contract, {
            prefix: '',
            guards: { 'account.*': [requireAuth] },
            handlers: {
                health: () => ({ ok: 'yes' }),
                account: {
                    me: (context) =>
                    {
                        expectTypeOf(context.accountId).toEqualTypeOf<number>(); // TYPED, no cast
                        return { id: context.accountId };
                    },
                    update: (context) =>
                    {
                        expectTypeOf(context.accountId).toEqualTypeOf<number>();
                        expectTypeOf(context.input).toEqualTypeOf<{ name: string }>();
                        return { id: context.accountId };
                    }
                }
            }
        });

        const ok = await app.handle(new Request('http://local/me', { headers: { authorization: 'Bearer x' } }));
        expect(await ok.json()).toEqual({ id: 7 });
        const denied = await app.handle(new Request('http://local/me'));
        expect(denied.status).toBe(401); // the guard's Response short-circuits
    });

    it('an UNGUARDED handler does not see the addition (type-level)', () =>
    {
        interface Guards { 'account.*': [typeof requireAuth] }
        type HealthCtx = Parameters<HandlersWithGuards<typeof contract, Guards>['health']>[0];
        // 'account.*' does not match 'health', so accountId is absent from its context.
        expectTypeOf<HealthCtx>().not.toHaveProperty('accountId');
        type MeCtx = Parameters<HandlersWithGuards<typeof contract, Guards>['account']['me']>[0];
        expectTypeOf<MeCtx>().toHaveProperty('accountId');
        expect(true).toBe(true);
    });

    it('valid guard keys are the contract paths; a typo is NOT one (type-level)', () =>
    {
        expectTypeOf<'account.*'>().toExtend<GuardKey<typeof contract>>();
        expectTypeOf<'account.me'>().toExtend<GuardKey<typeof contract>>();
        expectTypeOf<'*'>().toExtend<GuardKey<typeof contract>>();
        // The typo is provably not assignable to the key union - the map would reject it.
        type Typo = 'accont.*' extends GuardKey<typeof contract> ? true : false;
        expectTypeOf<Typo>().toEqualTypeOf<false>();
        expect(true).toBe(true);
    });

    it('exact-path and global guards also type through', async () =>
    {
        const tag = guard(() => ({ tag: 'v1' as const }));
        const app = new App();
        mountApi(app, contract, {
            prefix: '',
            guards: { '*': [tag], 'account.me': [requireAuth] },
            handlers: {
                health: (context) =>
                {
                    expectTypeOf(context.tag).toEqualTypeOf<'v1'>(); // global reaches every route
                    return { ok: context.tag };
                },
                account: {
                    me: (context) =>
                    {
                        expectTypeOf(context.tag).toEqualTypeOf<'v1'>();
                        expectTypeOf(context.accountId).toEqualTypeOf<number>(); // exact + global
                        return { id: context.accountId };
                    },
                    update: (context) =>
                    {
                        expectTypeOf(context.tag).toEqualTypeOf<'v1'>();
                        // update is NOT 'account.me' - only the global tag reaches it, no accountId.
                        expectTypeOf(context).not.toHaveProperty('accountId');
                        return { id: 1 };
                    }
                }
            }
        });
        expect((await (await app.handle(new Request('http://local/health'))).json())).toEqual({ ok: 'v1' });
    });
});
