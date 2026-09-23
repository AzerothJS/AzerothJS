// @vitest-environment node
//
// lendApiRegistration: a pages App's shared renders borrow one owner's api, set by the first lend,
// and only the internal subpath reaches it. Each arm reads what a shared render would reach.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { object, string } from '@azerothjs/schema';
import { App, createSharedApiBridge, edge, runInRequestRoot, runInWorkUnit } from '@azerothjs/http';
import { createClient, feature, manifestOf, register } from '@azerothjs/http/api';
import { lendApiRegistration } from '@azerothjs/http/internal';

const answering = (answer: string) => ({
    stats: feature('/stats', (routes) => ({ read: routes.get('/', { output: object({ n: string() }) }, () => ({ n: answer })) }))
});
const client = createClient<ReturnType<typeof answering>>(manifestOf(answering('')), { baseUrl: '/api' });

function owner(answer: string): App
{
    const app = new App();
    register(app, answering(answer));
    return app;
}

/** What a shared render of pages mounted on `pages` reads from the api. */
async function shared(pages: App): Promise<string>
{
    const answer = await runInWorkUnit(() => client.stats.read(), { sharedApi: createSharedApiBridge(pages) });
    return answer.n;
}

describe('lendApiRegistration', () =>
{
    it('refuses a second owner by name, allows the same owner again, and the first owner keeps answering', async () =>
    {
        const pages = new App();
        const tenantA = owner('data-of-A');
        const tenantB = owner('data-of-B');
        lendApiRegistration(pages, tenantA);

        expect(() => lendApiRegistration(pages, tenantB))
            .toThrow(/^@azerothjs\/http: lendApiRegistration refused - this pages App already reaches the api of another App/);
        expect(() => lendApiRegistration(pages, tenantA)).not.toThrow();
        expect(await shared(pages)).toBe('data-of-A');
    });

    it('a tenant edge lending on every request cannot switch the owner: the other tenant answers 500', async () =>
    {
        const pages = new App();
        pages.get('/*path', () => new Response('page'));
        const tenant = (answer: string): App =>
        {
            const app = owner(answer);
            app.use(edge((next) => ({
                handle: (request: Request): Promise<Response> =>
                {
                    lendApiRegistration(pages, app);
                    return next.handle(request);
                }
            })));
            app.get('/*path', (context) => pages.handle(context.request));
            return app;
        };
        const tenantA = tenant('data-of-A');
        const tenantB = tenant('data-of-B');

        expect((await tenantA.handle(new Request('http://a.example/b/1'))).status).toBe(200);
        expect((await tenantB.handle(new Request('http://b.example/b/1'))).status).toBe(500);
        expect(await shared(pages)).toBe('data-of-A');
    });

    it('refuses by name a pages App that registers its own api, which keeps answering', async () =>
    {
        const pages = owner('data-of-S');

        expect(() => lendApiRegistration(pages, owner('data-of-A')))
            .toThrow(/^@azerothjs\/http: lendApiRegistration refused - this pages App registers its own api/);
        expect(await shared(pages)).toBe('data-of-S');
    });

    it('is reached only through @azerothjs/http/internal, never the root entry', async () =>
    {
        const root = Object.keys(await import('@azerothjs/http'));
        const internal = Object.keys(await import('@azerothjs/http/internal'));
        const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { exports: Record<string, unknown> };

        expect(root.filter((name) => name === 'lendApiRegistration' || name === 'insideRequestRoot')).toEqual([]);
        expect(internal.sort()).toEqual(['insideRequestRoot', 'lendApiRegistration']);
        expect(manifest.exports['./internal']).toEqual({ types: './dist/internal.d.ts', import: './dist/internal.js', default: './dist/internal.js' });
    });
});

describe('WorkUnitOptions.sharedApi', () =>
{
    it('is read from a work unit only: a request root given it reaches nothing, whatever ran first', async () =>
    {
        const bridge = createSharedApiBridge(owner('reached'));
        const read = (): Promise<string> => client.stats.read().then((answer) => answer.n, (error: unknown) => String(error));
        const root = (): Promise<string> => runInRequestRoot(read, undefined, { sharedApi: bridge });

        expect(await runInWorkUnit(read, { sharedApi: bridge })).toBe('reached');
        expect(await root()).toMatch(/there is no origin here/);
        expect(await runInWorkUnit(root)).toMatch(/there is no origin here/);
    });
});
