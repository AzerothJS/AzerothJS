// @vitest-environment node
//
// Assembling a contract out of feature groups: `group()` writes a shared path prefix once, and
// `merge()` refuses the duplicate key that object spread would drop in silence.
import { describe, it, expect, expectTypeOf } from 'vitest';
import { App } from '@azerothjs/http';
import { object, string, number } from '@azerothjs/schema';
import { defineContract, get, post, group, merge, mountApi, createClient } from '@azerothjs/http/api';

describe('group - the path prefix is written once', () =>
{
    const consoleRoutes = group('/admin', {
        signIn: post('/session', { input: object({ key: string() }) }),
        overview: get('/overview', { output: object({ owed: number() }) }),
        order: get('/orders/:id', { output: object({ id: string() }) })
    });

    it('prepends the prefix to every path and keeps params typed', async () =>
    {
        const contract = defineContract({ admin: consoleRoutes });
        const app = new App();
        mountApi(app, contract, {
            prefix: '',
            handlers: {
                'admin.signIn': () => new Response(null, { status: 204 }),
                'admin.overview': () => ({ owed: 2 }),
                // The `:id` param survives the prefixing, typed from the pattern.
                'admin.order': ({ params }) =>
                {
                    expectTypeOf(params.id).toEqualTypeOf<string>();
                    return { id: params.id };
                }
            }
        });

        expect(await (await app.handle(new Request('http://local/admin/overview'))).json()).toEqual({ owed: 2 });
        expect(await (await app.handle(new Request('http://local/admin/orders/7'))).json()).toEqual({ id: '7' });
        expect((await app.handle(new Request('http://local/overview'))).status).toBe(404);   // unprefixed is gone
    });

    it('the typed client calls the prefixed path', async () =>
    {
        const contract = defineContract({ admin: consoleRoutes });
        const app = new App();
        mountApi(app, contract, {
            prefix: '',
            handlers: {
                'admin.signIn': () => new Response(null, { status: 204 }),
                'admin.overview': () => ({ owed: 5 }),
                'admin.order': ({ params }) => ({ id: params.id })
            }
        });
        const client = createClient(contract, { baseUrl: '', fetch: (request) => app.handle(request) });
        expect(await client.admin.overview()).toEqual({ owed: 5 });
        expect(await client.admin.order({ params: { id: '9' } })).toEqual({ id: '9' });
    });

    it('nests: a group inside a group gets the outer prefix too', () =>
    {
        const nested = group('/v1', { admin: group('/admin', { ping: get('/ping') }) });
        expect((nested.admin.ping as { path: string }).path).toBe('/v1/admin/ping');
    });
});

describe('merge - a duplicate key is a boot failure, not a silent drop', () =>
{
    const consoleRoutes = { overview: get('/admin/overview', { output: object({ owed: number() }) }) };
    const settingsRoutes = { settings: get('/admin/settings', { output: object({ ok: string() }) }) };

    it('combines groups and keeps every route', () =>
    {
        const admin = merge(consoleRoutes, settingsRoutes);
        expect(Object.keys(admin).sort()).toEqual(['overview', 'settings']);
        expectTypeOf(admin.overview).toEqualTypeOf<typeof consoleRoutes.overview>();
        expectTypeOf(admin.settings).toEqualTypeOf<typeof settingsRoutes.settings>();
    });

    it('throws on a collision, naming the key', () =>
    {
        // Two features that both call a route `overview`. Object spread would keep the last one and
        // the first route would vanish from the API with nothing failing.
        const rival = { overview: get('/admin/rival', { output: object({ owed: number() }) }) };
        expect(() => merge(consoleRoutes, rival)).toThrow(/Duplicate contract key "overview"/);
    });

    it('spread is what it protects against - proving the hazard is real', () =>
    {
        const rival = { overview: get('/admin/rival', { output: object({ owed: number() }) }) };
        const spread = { ...consoleRoutes, ...rival };
        // One key, one surviving route: /admin/overview is simply gone, and nothing said so.
        expect(Object.keys(spread)).toEqual(['overview']);
        expect((spread.overview as { path: string }).path).toBe('/admin/rival');
    });
});
