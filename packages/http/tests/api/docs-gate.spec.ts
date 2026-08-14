// @vitest-environment node
//
// The docs surface fails CLOSED: /openapi.json and /docs register only when NODE_ENV is
// exactly 'development' or the app said public: true. The check is positive because an
// unset variable has to mean "not development" - and so do 'prod', 'Production', 'staging',
// and a runtime with no process at all.
import { describe, it, expect } from 'vitest';
import { App } from '../../src/app.ts';
import { feature } from '../../src/api/feature.ts';
import { openapiPlugin } from '../../src/api/openapi.ts';

const INFO = { title: 'Gate API', version: '1.0.0' };
const api = { health: feature('/healthz', (routes) => ({ check: routes.get('/', {}, () => ({ ok: true })) })) };

function withNodeEnv<T>(value: string | undefined, run: () => T): T
{
    const previous = process.env.NODE_ENV;
    if (value === undefined)
    {
        delete process.env.NODE_ENV;
    }
    else
    {
        process.env.NODE_ENV = value;
    }
    try
    {
        return run();
    }
    finally
    {
        if (previous === undefined)
        {
            delete process.env.NODE_ENV;
        }
        else
        {
            process.env.NODE_ENV = previous;
        }
    }
}

async function servedStatuses(app: App): Promise<[number, number]>
{
    const spec = await app.handle(new Request('http://local/openapi.json'));
    const docs = await app.handle(new Request('http://local/docs'));
    return [spec.status, docs.status];
}

describe('the docs surface registers only in explicit development', () =>
{
    it('NODE_ENV=development registers both routes', async () =>
    {
        const app = withNodeEnv('development', () => new App().register(openapiPlugin({ features: api, info: INFO })));
        expect(await servedStatuses(app)).toEqual([200, 200]);
    });

    it.each(['production', 'prod', 'Production', 'test', 'staging'])('NODE_ENV=%s is a no-op', async (value) =>
    {
        const app = withNodeEnv(value, () => new App().register(openapiPlugin({ features: api, info: INFO })));
        expect(await servedStatuses(app)).toEqual([404, 404]);
    });

    it('an UNSET variable is a no-op', async () =>
    {
        const app = withNodeEnv(undefined, () => new App().register(openapiPlugin({ features: api, info: INFO })));
        expect(await servedStatuses(app)).toEqual([404, 404]);
    });

    it('a runtime with no process at all is a no-op', async () =>
    {
        // install() reads the environment synchronously, so process is only absent while
        // the plugin registers; it is restored before any request is handled.
        const app = new App();
        const held = globalThis.process;
        try
        {
            delete (globalThis as { process?: unknown }).process;
            app.register(openapiPlugin({ features: api, info: INFO }));
        }
        finally
        {
            globalThis.process = held;
        }
        expect(await servedStatuses(app)).toEqual([404, 404]);
    });

    it('public: true registers the surface regardless of the environment', async () =>
    {
        const app = withNodeEnv('production', () => new App().register(openapiPlugin({ features: api, info: INFO, public: true })));
        expect(await servedStatuses(app)).toEqual([200, 200]);
    });
});
