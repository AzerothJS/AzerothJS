// @vitest-environment node
//
// The named-plugin contract (AzerothPlugin + app.register). Pins: install runs and its routes
// serve; context additions flow to routes registered AFTER the plugin (and are typed); a
// duplicate name throws at boot; the registry lists installed plugins; and register composes
// with the anonymous plugin(fn) seam.
import { describe, it, expect, expectTypeOf } from 'vitest';
import { App, type AzerothPlugin, type RequestContext } from '../src/app.ts';
import { json, text } from '../src/respond.ts';

function get(app: App, path: string): Promise<Response>
{
    return app.handle(new Request(`http://local${ path }`));
}

describe('named plugins', () =>
{
    it('installs a plugin whose routes then serve', async () =>
    {
        const health: AzerothPlugin =
        {
            name: 'health',
            version: '1.0.0',
            install: (app) => app.get('/healthz', () => text('ok'))
        };
        const app = new App().register(health);
        expect(await (await get(app, '/healthz')).text()).toBe('ok');
    });

    it('flows the plugin context additions to later routes, typed', async () =>
    {
        const clock: AzerothPlugin<object, { now: number }> =
        {
            name: 'clock',
            install: (app) => app.use(() => ({ now: 1234 }))
        };
        const app = new App()
            .register(clock)
            .get('/time', (_request, ctx) =>
            {
                expectTypeOf(ctx).toExtend<RequestContext & { now: number }>();
                return json({ now: ctx.now });
            });
        expect(await (await get(app, '/time')).json()).toEqual({ now: 1234 });
    });

    it('rejects a duplicate registration by name', () =>
    {
        const plugin: AzerothPlugin = { name: 'dup', install: (app) => app };
        expect(() => new App().register(plugin).register(plugin))
            .toThrow("Plugin 'dup' is already registered.");
    });

    it('two DIFFERENT plugins both register and are listed in order', () =>
    {
        const a: AzerothPlugin = { name: 'a', version: '0.1.0', install: (app) => app };
        const b: AzerothPlugin = { name: 'b', install: (app) => app };
        const app = new App().register(a).register(b);
        expect(app.plugins()).toEqual([{ name: 'a', version: '0.1.0' }, { name: 'b', version: undefined }]);
    });

    it('composes with the anonymous plugin(fn) seam', async () =>
    {
        const named: AzerothPlugin<object, { tag: string }> =
        {
            name: 'tagger',
            install: (app) => app.use(() => ({ tag: 'X' }))
        };
        const app = new App()
            .register(named)
            .plugin((a) => a.get('/tag', (_request, ctx) => text(ctx.tag)));
        expect(await (await get(app, '/tag')).text()).toBe('X');
    });
});
