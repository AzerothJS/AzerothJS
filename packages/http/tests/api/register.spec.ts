// @vitest-environment node
//
// The boundary pipeline register() installs around every declared handler. The 422
// flat-field-map conversion is THE pinned behavior: a colocated design that loses it turns
// every bad form post into a 500 - which is exactly what the measured prototype did until a
// test caught it.
import { describe, it, expect } from 'vitest';
import { object, string, number } from '@azerothjs/schema';
import { App } from '../../src/app.ts';
import { feature, guard } from '../../src/api/feature.ts';
import { register } from '../../src/api/register.ts';
import { reply } from '../../src/api/declare.ts';

function appWith(features: Parameters<typeof register>[1]): App
{
    const app = new App();
    register(app, features);
    return app;
}

const post = (path: string, body: unknown): Request =>
    new Request(`http://x${ path }`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('register - the validation boundary', () =>
{
    it('a bad body is a 422 with the flat field map a form consumes', async () =>
    {
        const app = appWith({
            users: feature('/users', (routes) => ({
                create: routes.post('/', { input: object({ name: string(), age: number() }) }, (context) => context.input)
            }))
        });

        const response = await app.handle(post('/api/users', { name: 7 }));
        expect(response.status).toBe(422);
        const wire = await response.json() as { error: { code: string; details: { fields: Record<string, string> } } };
        expect(wire.error.code).toBe('validation-failed');
        expect(Object.keys(wire.error.details.fields).sort()).toEqual(['age', 'name']);
    });

    it('a bad query is a 422 through the same conversion', async () =>
    {
        const app = appWith({
            search: feature('/search', (routes) => ({
                run: routes.get('/', { query: object({ limit: number() }) }, (context) => ({ limit: context.query.limit }))
            }))
        });

        const response = await app.handle(new Request('http://x/api/search?limit=notanumber'));
        expect(response.status).toBe(422);
    });

    it('a prototype-named query field reaches the handler as its own value', async () =>
    {
        const app = appWith({
            echo: feature('/echo', (routes) => ({
                run: routes.get('/', { query: object({ constructor: string() }) }, (context) => ({ got: context.query.constructor }))
            }))
        });

        const response = await app.handle(new Request('http://x/api/echo?constructor=mine'));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ got: 'mine' });
    });

    it('an off-declaration return is a hidden 500, never a wrong payload', async () =>
    {
        const app = appWith({
            broken: feature('/broken', (routes) => ({
                run: routes.get('/', { output: object({ id: number() }) }, () => ({ id: 'not-a-number' }) as unknown as { id: number })
            }))
        });

        const response = await app.handle(new Request('http://x/api/broken'));
        expect(response.status).toBe(500);
        const wire = await response.json() as { error: { message: string } };
        expect(wire.error.message).not.toContain('id');
    });

    it('a foreign Standard Schema validator produces the same 422, not a 500', async () =>
    {
        const foreign = {
            '~standard': {
                version: 1,
                vendor: 'test',
                validate: (value: unknown) =>
                {
                    const record = value as { name?: unknown };
                    return typeof record.name === 'string'
                        ? { value }
                        : { issues: [{ message: 'name must be a string', path: ['name'] }] };
                }
            }
        };
        const app = appWith({
            users: feature('/users', (routes) => ({
                create: routes.post('/', { input: foreign as never }, (context) => context.input as Record<string, unknown>)
            }))
        });

        const response = await app.handle(post('/api/users', { name: 7 }));
        expect(response.status).toBe(422);
        const wire = await response.json() as { error: { details: { fields: Record<string, string> } } };
        expect(wire.error.details.fields['name']).toBe('name must be a string');
    });

    it('a guard that consumed the body surfaces the named 500, not a locked-stream error', async () =>
    {
        const consuming = async (context: { request: Request }): Promise<void> =>
        {
            await context.request.text();
        };
        const app = appWith({
            hooks: feature('/hooks', [consuming], (routes) => ({
                run: routes.post('/', { input: object({ a: string() }) }, (context) => context.input)
            }))
        });

        const response = await app.handle(post('/api/hooks', { a: 'x' }));
        expect(response.status).toBe(500);
        const wire = await response.json() as { error: { code: string } };
        expect(wire.error.code).toBe('body-already-read');
    });

    it('reply() speaks a declared non-default status, validated', async () =>
    {
        const app = appWith({
            things: feature('/things', (routes) => ({
                create: routes.post('/', {
                    input: object({ name: string() }),
                    responses: { 201: object({ id: number() }) }
                }, () => reply(201, { id: 1 }, { location: '/things/1' }))
            }))
        });

        const response = await app.handle(post('/api/things', { name: 'a' }));
        expect(response.status).toBe(201);
        expect(response.headers.get('location')).toBe('/things/1');
        expect(await response.json()).toEqual({ id: 1 });
    });

    it('the guard chain types AND runs: additions land flat on the context', async () =>
    {
        const requireAuth = guard(() => ({ accountId: 42 }));
        const app = appWith({
            me: feature('/me', [requireAuth], (routes) => ({
                read: routes.get('/', {}, (context) => ({ id: context.accountId }))
            }))
        });

        const response = await app.handle(new Request('http://x/api/me'));
        expect(await response.json()).toEqual({ id: 42 });
    });

    it('register returns the record it installed', () =>
    {
        const app = new App();
        const features = { ping: feature('/ping', (routes) => ({ run: routes.get('/', {}, () => ({ ok: true })) })) };
        expect(register(app, features)).toBe(features);
    });
});
