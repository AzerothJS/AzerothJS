// @vitest-environment node
//
// THE decisive test of the colocated design: a fully typed client built from `typeof` the
// server's features plus the projected manifest - no schemas, no handlers, no codegen. If the
// types here stop inferring, the design's core claim is false and everything downstream stops.
import { describe, it, expect, expectTypeOf } from 'vitest';
import { object, string, number, date } from '@azerothjs/schema';
import { feature, guard, manifestOf } from '../../src/api/feature.ts';
import { createClient, ApiError, type Wire } from '../../src/api/client.ts';

const inviteInput = object({ email: string(), role: string() });
const invite = object({ id: number(), email: string(), role: string() });
const memberQuery = object({ page: number().optional() });

const requireAuth = guard(() => ({ accountId: 7 }));

const orgs = feature('/orgs/:slug', [requireAuth], (routes) => ({
    members: routes.get('/members', { query: memberQuery, output: object({ total: number() }) },
        (context) =>
        {
            expectTypeOf(context.params).toExtend<{ slug: string }>();
            expectTypeOf(context.accountId).toBeNumber();
            expectTypeOf(context.query).toEqualTypeOf<{ page?: number | undefined }>();
            return { total: 0 };
        }),
    invite: routes.post('/invites', { input: inviteInput, output: invite },
        (context) => ({ id: 1, email: context.input.email, role: context.input.role })),
    revoke: routes.del('/invites/:inviteId', {},
        (context) =>
        {
            expectTypeOf(context.params).toExtend<{ slug: string; inviteId: string }>();
            return { ok: true };
        }),
    avatar: routes.raw('GET', '/avatar', {}, () => new Response('png')),
    events: routes.stream('/events', {}, () => undefined)
}));

const api = { orgs };
const manifest = manifestOf(api);

describe('Wire: the client-side projection of declared types', () =>
{
    it('maps Date to string, recursively, and leaves everything else alone', () =>
    {
        expectTypeOf<Wire<Date>>().toEqualTypeOf<string>();
        expectTypeOf<Wire<{ at: Date; n: number }>>().toEqualTypeOf<{ at: string; n: number }>();
        expectTypeOf<Wire<{ items: Array<{ at: Date }> }>>().toEqualTypeOf<{ items: Array<{ at: string }> }>();
        expectTypeOf<Wire<string[]>>().toEqualTypeOf<string[]>();
        expectTypeOf<Wire<number>>().toEqualTypeOf<number>();
        expectTypeOf<Wire<{ maybe?: Date }>>().toEqualTypeOf<{ maybe?: string }>();
    });

    it('a route output containing a Date types the client call return as string', async () =>
    {
        const stamped = feature('/stamped', (routes) => ({
            now: routes.get('/', { output: object({ at: date() }) }, () => ({ at: new Date() }))
        }));
        const client = createClient<{ stamped: typeof stamped }>(manifestOf({ stamped }), {
            baseUrl: '/api',
            fetch: () => Promise.resolve(new Response(JSON.stringify({ at: '2026-08-07T00:00:00.000Z' }), {
                headers: { 'content-type': 'application/json' }
            }))
        });
        const result = await client.stamped.now();
        expectTypeOf(result).toEqualTypeOf<{ at: string }>();
        expect(result.at).toBe('2026-08-07T00:00:00.000Z');
    });
});

describe('the typed client from typeof + manifest', () =>
{
    it('the manifest is a pure projection: two fields per JSON route, no functions, tiny', () =>
    {
        const serialized = JSON.stringify(manifest);
        expect(serialized).not.toContain('function');
        expect(serialized.length).toBeLessThan(1024);
        expect(manifest['orgs']?.['invite']).toEqual({ method: 'POST', path: '/orgs/:slug/invites' });
        // Non-JSON routes carry the kind marker the client refuses on.
        expect(manifest['orgs']?.['avatar']).toEqual({ method: 'GET', path: '/orgs/:slug/avatar', kind: 'raw' });
        expect(manifest['orgs']?.['events']).toEqual({ method: 'GET', path: '/orgs/:slug/events', kind: 'stream' });
    });

    it('infers params, input, query, and output from typeof the feature', async () =>
    {
        const seen: Request[] = [];
        const client = createClient<typeof api>(manifest, {
            baseUrl: '/api',
            fetch: (request) =>
            {
                seen.push(request);
                return Promise.resolve(new Response(JSON.stringify({ id: 1, email: 'intelligentquantum@example.org', role: 'admin' }), {
                    headers: { 'content-type': 'application/json' }
                }));
            }
        });

        const created = await client.orgs.invite({ params: { slug: 'acme' }, input: { email: 'intelligentquantum@example.org', role: 'admin' } });
        expectTypeOf(created).toEqualTypeOf<{ id: number; email: string; role: string }>();
        expect(seen[0]?.method).toBe('POST');
        expect(new URL(seen[0]?.url ?? '').pathname).toBe('/api/orgs/acme/invites');

        // The type level: params/input are REQUIRED, and their shapes are the declared ones.
        expectTypeOf(client.orgs.invite).parameter(0).toMatchObjectType<{
            params: { slug: string };
            input: { email: string; role: string };
        }>();
        expectTypeOf(client.orgs.members).parameter(0).toMatchObjectType<{
            params: { slug: string };
        }>();

        // Non-JSON routes are absent from the surface type entirely.
        expectTypeOf<keyof typeof client.orgs>().toEqualTypeOf<'members' | 'invite' | 'revoke'>();
    });

    it('a server refusal arrives as ApiError with status, code, and the field map', async () =>
    {
        const client = createClient<typeof api>(manifest, {
            baseUrl: '/api',
            fetch: () => Promise.resolve(new Response(JSON.stringify({
                error: { code: 'forbidden', message: 'no', details: { fields: { role: 'not allowed' } } }
            }), { status: 403, headers: { 'content-type': 'application/json' } }))
        });

        const failure = await client.orgs.invite({ params: { slug: 'acme' }, input: { email: 'intelligentquantum@example.org', role: 'admin' } })
            .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as ApiError).status).toBe(403);
        expect((failure as ApiError).code).toBe('forbidden');
        expect((failure as ApiError).fields).toEqual({ role: 'not allowed' });
    });

    it('a non-JSON route refuses loudly at runtime too', () =>
    {
        const untyped = createClient<typeof api>(manifest, { baseUrl: '/api' }) as unknown as
            Record<string, Record<string, () => unknown>>;
        expect(() => untyped['orgs']?.['avatar']?.()).toThrow(/"raw" route/);
    });
});
