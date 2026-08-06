// @vitest-environment node
//
// Guard typing under the colocated design: the feature chain's additions flow into every
// handler's context (no cast), `routes.with(...)` ADDS to that chain (accumulating across
// calls, like the kernel's app.with), and `routes.only(...)` is the one form that can drop
// inherited protection - so every place a feature's guard stops is greppable by one name.
// These are TYPE assertions first, runtime behavior second.
import { describe, it, expect, expectTypeOf } from 'vitest';
import { App } from '../../src/app.ts';
import { object, string, number } from '@azerothjs/schema';
import { feature, guard } from '../../src/api/feature.ts';
import { register } from '../../src/api/register.ts';

const requireAuth = guard((context) =>
{
    if (context.request.headers.get('authorization') === null)
    {
        return new Response('no', { status: 401 });
    }
    return { accountId: 7 };
});

describe('feature guards - additions flow into the handler context, no cast', () =>
{
    it('the chain types AND runs; a guard Response short-circuits', async () =>
    {
        const app = new App();
        register(app, {
            account: feature('/account', [requireAuth], (routes) => ({
                me: routes.get('/me', { output: object({ id: number() }) }, (context) =>
                {
                    expectTypeOf(context.accountId).toEqualTypeOf<number>();
                    return { id: context.accountId };
                }),
                update: routes.post('/', { input: object({ name: string() }) }, (context) =>
                {
                    expectTypeOf(context.accountId).toEqualTypeOf<number>();
                    expectTypeOf(context.input).toEqualTypeOf<{ name: string }>();
                    return { id: context.accountId };
                })
            }))
        }, { prefix: '' });

        const ok = await app.handle(new Request('http://local/account/me', { headers: { authorization: 'Bearer x' } }));
        expect(await ok.json()).toEqual({ id: 7 });
        const denied = await app.handle(new Request('http://local/account/me'));
        expect(denied.status).toBe(401);
    });

    it('routes.with ADDS to the feature chain: inherited protection cannot be lost by adding', async () =>
    {
        // The regression this design exists for: `with(throttle)` used to REPLACE the
        // chain, so asking for a rate limit silently removed the authentication. A route
        // can only ever gain protection through with().
        const tag = guard(() => ({ tag: 'v1' as const }));
        const app = new App();
        register(app, {
            account: feature('/account', [requireAuth], (routes) => ({
                version: routes.with(tag).get('/version', {}, (context) =>
                {
                    // BOTH sets of additions are on the context, and the type says so.
                    expectTypeOf(context.accountId).toEqualTypeOf<number>();
                    expectTypeOf(context.tag).toEqualTypeOf<'v1'>();
                    return { v: context.tag, id: context.accountId };
                })
            }))
        }, { prefix: '' });

        expect((await app.handle(new Request('http://local/account/version'))).status).toBe(401);
        const ok = await app.handle(new Request('http://local/account/version', { headers: { authorization: 'Bearer x' } }));
        expect(await ok.json()).toEqual({ v: 'v1', id: 7 });
    });

    it('chained with() calls ACCUMULATE, in declaration order, after the feature chain', async () =>
    {
        // `.with(a).with(b)` used to yield only [b] - silently dropping a.
        const order: string[] = [];
        const mark = (name: string) => guard((): void =>
        {
            order.push(name);
        });
        const [featureGuard, first, second] = [mark('feature'), mark('first'), mark('second')];
        const app = new App();
        register(app, {
            probe: feature('/probe', [featureGuard], (routes) => ({
                read: routes.with(first).with(second).get('/', {}, () => ({ ok: true }))
            }))
        }, { prefix: '' });

        await app.handle(new Request('http://local/probe'));
        expect(order).toEqual(['feature', 'first', 'second']);
    });

    it('routes.only REPLACES the chain, and only() with no arguments is the unguarded opt-out', async () =>
    {
        const tag = guard(() => ({ tag: 'v1' as const }));
        const app = new App();
        register(app, {
            account: feature('/account', [requireAuth], (routes) => ({
                me: routes.get('/me', {}, (context) =>
                {
                    expectTypeOf(context.accountId).toEqualTypeOf<number>();
                    return { id: context.accountId };
                }),
                // Replaced chain: tag runs, requireAuth does NOT - and the type says so.
                version: routes.only(tag).get('/version', {}, (context) =>
                {
                    expectTypeOf(context.tag).toEqualTypeOf<'v1'>();
                    expectTypeOf(context).not.toHaveProperty('accountId');
                    return { v: context.tag };
                }),
                // The deliberate opt-out: unguarded inside a guarded feature.
                signIn: routes.only().post('/session', { input: object({ key: string() }) }, (context) =>
                {
                    expectTypeOf(context).not.toHaveProperty('accountId');
                    return { ok: context.input.key.length > 0 };
                })
            }))
        }, { prefix: '' });

        // No authorization header anywhere - the replaced-chain routes still answer.
        const version = await app.handle(new Request('http://local/account/version'));
        expect(await version.json()).toEqual({ v: 'v1' });

        const signIn = await app.handle(new Request('http://local/account/session', {
            method: 'POST', body: JSON.stringify({ key: 'k' }), headers: { 'content-type': 'application/json' }
        }));
        expect(await signIn.json()).toEqual({ ok: true });

        // The feature chain still guards the inheriting route.
        expect((await app.handle(new Request('http://local/account/me'))).status).toBe(401);
    });

    it('only() then with() rebuilds from the replacement, never resurrecting the feature chain', async () =>
    {
        const order: string[] = [];
        const mark = (name: string) => guard((): void =>
        {
            order.push(name);
        });
        const [featureGuard, replacement, added] = [mark('feature'), mark('replacement'), mark('added')];
        const app = new App();
        register(app, {
            probe: feature('/probe', [featureGuard], (routes) => ({
                read: routes.only(replacement).with(added).get('/', {}, () => ({ ok: true }))
            }))
        }, { prefix: '' });

        await app.handle(new Request('http://local/probe'));
        expect(order).toEqual(['replacement', 'added']);
    });

    it('a guard may not overwrite request, params or url - the same refusal the kernel makes', async () =>
    {
        // A guard returning parsed request data as its additions would otherwise let
        // `{ params: { id: 'admin' } }` replace the path params a handler authorises on.
        const hostile = guard(() => ({ params: { id: 'admin' }, url: 'http://evil', ok: true }));
        const app = new App();
        register(app, {
            users: feature('/users', [hostile], (routes) => ({
                one: routes.get('/:id', {}, (context) => ({ authorizedFor: context.params.id }))
            }))
        }, { prefix: '' });

        expect(await (await app.handle(new Request('http://local/users/alice'))).json()).toEqual({ authorizedFor: 'alice' });
    });

    it('two guards on one chain BOTH reach the handler, so the additions intersect', async () =>
    {
        const tagged = guard(() => ({ tag: 'v1' as const }));
        const counted = guard(() => ({ count: 1 }));
        const app = new App();
        register(app, {
            probe: feature('/probe', [tagged, counted], (routes) => ({
                read: routes.get('/', {}, (context) =>
                {
                    // register Object.assigns each guard's return onto the ONE context, so both
                    // fields are present. A union would have modelled this as "one or the other".
                    expectTypeOf(context.tag).toEqualTypeOf<'v1'>();
                    expectTypeOf(context.count).toEqualTypeOf<number>();
                    return { seen: `${ context.tag }/${ context.count }` };
                })
            }))
        }, { prefix: '' });

        expect(await (await app.handle(new Request('http://local/probe'))).json()).toEqual({ seen: 'v1/1' });
    });

    it('a maybe-returning guard types its additions OPTIONAL - the runtime truth', () =>
    {
        // The everyday optional-session guard: a conditional bare return means on the anonymous
        // path nothing was assigned, so reading the field as a plain number would be a lie.
        const optionalSession = guard((context) =>
        {
            if (context.request.headers.get('authorization') === null)
            {
                return;
            }
            return { sessionId: 'live' };
        });

        feature('/pages', [optionalSession], (routes) => ({
            read: routes.get('/:id', {}, (context) =>
            {
                expectTypeOf(context.sessionId).toEqualTypeOf<string | undefined>();
                return { visible: context.sessionId !== undefined };
            })
        }));
        expect(true).toBe(true);
    });
});

describe('interface-typed additions survive the flow', () =>
{
    // The shape every real app writes (`interface Viewer`), and the case a
    // `Record<string, unknown>` filter would silently drop: an interface has no implicit
    // index signature.
    interface Viewer
    {
        userId: number;
        role: 'admin' | 'member';
    }

    const asViewer = guard((context): Viewer | Response =>
    {
        if (context.request.headers.get('authorization') === null)
        {
            return new Response('no', { status: 401 });
        }
        return { userId: 3, role: 'member' };
    });

    it('a guard()-wrapped interface return types the handler context and runs', async () =>
    {
        const app = new App();
        register(app, {
            pages: feature('/pages', [asViewer], (routes) => ({
                me: routes.get('/me', {}, (context) =>
                {
                    expectTypeOf(context.userId).toEqualTypeOf<number>();
                    expectTypeOf(context.role).toEqualTypeOf<'admin' | 'member'>();
                    return { id: context.userId };
                })
            }))
        }, { prefix: '' });

        const response = await app.handle(new Request('http://local/pages/me', { headers: { authorization: 'Bearer x' } }));
        expect(await response.json()).toEqual({ id: 3 });
    });

    it('a bare (non-wrapped) middleware function is a guard with no wrapper', async () =>
    {
        const plain = (context: { request: Request }): Response | undefined =>
            context.request.headers.get('x-ok') === null ? new Response(null, { status: 403 }) : undefined;

        const app = new App();
        register(app, {
            things: feature('/things', [plain], (routes) => ({
                list: routes.get('/', {}, () => ({ ok: true }))
            }))
        }, { prefix: '' });

        expect((await app.handle(new Request('http://local/things'))).status).toBe(403);
        expect((await app.handle(new Request('http://local/things', { headers: { 'x-ok': '1' } }))).status).toBe(200);
    });
});
