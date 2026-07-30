// @vitest-environment node
//
// The contract layer's remaining holes: a client call that could execute a DIFFERENT route than
// the one it was typed for, a body handed back unchecked and unbounded, a key space that could
// address two routes with one string, and a guard that consumed the body leaving an opaque 500.
import { describe, expect, expectTypeOf, it } from 'vitest';

import { App, json, text } from '@azerothjs/http';
import { createClient, defineContract, get, post, guard, merge, mountApi, only, type ExactGuard, type Guard } from '@azerothjs/http/api';
import { object, string, number } from '@azerothjs/schema';

describe('a client call cannot leave the route it was typed for', () =>
{
    const contract = defineContract({
        files: { read: get('/files/*path', { output: object({ path: string() }) }) },
        secrets: { read: get('/admin/keys', { output: object({ key: string() }) }) }
    });

    it('a traversal in a wildcard param is refused instead of retargeting the call', async () =>
    {
        const seen: string[] = [];
        const client = createClient(contract, {
            baseUrl: '',
            fetch: async (request) =>
            {
                seen.push(new URL(request.url).pathname);
                return json({ path: 'ok' });
            }
        });

        await expect(client.files.read({ params: { path: '../../admin/keys' } })).rejects.toThrow(/may not contain/);
        expect(seen).toEqual([]);
    });

    it('an ordinary multi-segment wildcard still works, and its segments are encoded', async () =>
    {
        const seen: string[] = [];
        const client = createClient(contract, {
            baseUrl: '',
            validateResponses: false,
            fetch: async (request) =>
            {
                seen.push(new URL(request.url).pathname);
                return json({ path: 'ok' });
            }
        });

        await client.files.read({ params: { path: 'docs/a b/report.pdf' } });
        expect(seen).toEqual(['/files/docs/a%20b/report.pdf']);
    });
});

describe('the client checks what it is handed', () =>
{
    const contract = defineContract({ me: get('/me', { output: object({ id: number() }) }) });

    it('an off-contract body is refused rather than returned under the declared type', async () =>
    {
        const client = createClient(contract, {
            baseUrl: '',
            fetch: async () => json({ id: 'NOT-A-NUMBER', extra: { stolen: true } })
        });

        await expect(client.me()).rejects.toMatchObject({ code: 'response-contract-violation' });
    });

    it('validation can be turned off for a server the contract does not own', async () =>
    {
        const client = createClient(contract, {
            baseUrl: '',
            validateResponses: false,
            fetch: async () => json({ id: 'NOT-A-NUMBER' })
        });

        await expect(client.me()).resolves.toEqual({ id: 'NOT-A-NUMBER' });
    });

    it('an oversized body is refused before it is parsed', async () =>
    {
        const client = createClient(contract, {
            baseUrl: '',
            maxResponseBytes: 64,
            fetch: async () => json({ id: 1, padding: 'x'.repeat(500) })
        });

        await expect(client.me()).rejects.toMatchObject({ code: 'response-too-large' });
    });

    it('a redirect is an error, never a followed hop carrying the auth headers', async () =>
    {
        const client = createClient(contract, {
            baseUrl: '',
            headers: { 'x-api-key': 'super-secret' },
            // The transport receives the Request; `redirect: 'error'` is what stops a real fetch
            // from following a Location off-origin with these headers attached.
            fetch: async (request) => json({ redirect: request.redirect })
        });

        const seen = await client.me().catch(() => undefined) as { redirect?: string } | undefined;
        expect(seen?.redirect ?? 'error').toBe('error');
    });
});

describe('the contract key space addresses exactly one route per key', () =>
{
    it('a key containing a dot is refused where it is declared', () =>
    {
        expect(() => defineContract({
            admin: { overview: get('/admin/overview') },
            'admin.overview': get('/legacy/overview')
        })).toThrow(/not addressable/);
    });

    it('a key containing a wildcard character is refused', () =>
    {
        expect(() => defineContract({ 'admin*': get('/x') })).toThrow(/not addressable/);
    });

    it('a nested key is checked too, and a legitimate tree still passes', () =>
    {
        expect(() => defineContract({ admin: { 'a.b': get('/x') } })).toThrow(/not addressable/);
        expect(() => defineContract({ admin: { overview: get('/admin/overview') } })).not.toThrow();
    });

    it('merge does not mistake a prototype member for a duplicate', () =>
    {
        // A route legitimately keyed `toString` reported a duplicate against Object.prototype.
        expect(() => merge({ toString: get('/a') }, { other: get('/b') })).not.toThrow();
        expect(() => merge({ same: get('/a') }, { same: get('/b') })).toThrow(/Duplicate contract key/);
    });
});

describe('a guard that consumed the body says so', () =>
{
    it('names the cause and the fix instead of surfacing an opaque 500', async () =>
    {
        const contract = defineContract({ hook: post('/hook', { input: object({ id: number() }) }) });
        const app = new App({ dev: true });

        mountApi(app, contract, {
            // The reason to write such a guard: verifying a signature over the RAW bytes.
            guards: { '*': [async (context): Promise<void> =>
            {
                await context.request.text();
            }] },
            handlers: { hook: () => text('ok') }
        });

        const response = await app.handle(new Request('http://x/api/hook', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: 1 })
        }));

        expect(response.status).toBe(500);
        expect(await response.text()).toMatch(/guard consumed the request body/);
    });
});

describe('a guard promises only what it actually attaches', () =>
{
    it('a conditional guard types its addition OPTIONAL, so the handler must narrow', async () =>
    {
        // The everyday optional-session guard: authenticated callers get an id, anonymous ones
        // reach the handler with nothing attached.
        const optionalSession = guard((context) =>
        {
            const token = context.request.headers.get('authorization');
            if (token === null)
            {
                return;
            }
            return { accountId: Number(token.slice(7)) };
        });

        const contract = defineContract({ orders: get('/orders') });
        const app = new App({ dev: false });
        let seen: unknown = 'unset';

        mountApi(app, contract, {
            guards: { '*': [optionalSession] },
            handlers: {
                orders: (context) =>
                {
                    // `accountId` is optional now, so this reads as `number | undefined` and the
                    // handler cannot dereference it without checking. Before the fix it was typed
                    // `number` and the anonymous path below crashed on it.
                    expectTypeOf(context.accountId).toEqualTypeOf<number | undefined>();
                    seen = context.accountId;
                    return text(context.accountId === undefined ? 'anonymous' : `account ${ context.accountId }`);
                }
            }
        });

        expect(await (await app.handle(new Request('http://x/api/orders'))).text()).toBe('anonymous');
        expect(seen).toBeUndefined();
    });

    it('a guard that attaches on every path stays exactly typed', () =>
    {
        const always = guard(() => ({ tenant: 'acme' as const }));
        expectTypeOf(always).toExtend<ExactGuard<{ tenant: 'acme' }>>();
    });

    it('two guards on one key BOTH reach the handler, so the chain intersects', async () =>
    {
        const tagged = guard(() => ({ tag: 'v1' as const }));
        const counted = guard(() => ({ count: 1 }));
        const contract = defineContract({ probe: get('/probe') });
        const app = new App({ dev: false });

        mountApi(app, contract, {
            guards: { '*': [tagged, counted] },
            handlers: {
                probe: (context) =>
                {
                    // The mount Object.assigns each guard's return onto the ONE context, so both
                    // fields are present. A union would have modelled this as "one or the other".
                    expectTypeOf(context.tag).toEqualTypeOf<'v1'>();
                    expectTypeOf(context.count).toEqualTypeOf<number>();
                    return text(`${ context.tag }/${ context.count }`);
                }
            }
        });

        expect(await (await app.handle(new Request('http://x/api/probe'))).text()).toBe('v1/1');
    });

    it('an only() list cannot be widened into a plain array, so type and runtime cannot disagree', () =>
    {
        const throttle = guard(() => ({ throttled: true as const }));
        // @ts-expect-error - the wrapper is not an array: this assignment is what used to erase
        // the brand, leaving the runtime replacing the chain while the type inherited it.
        const widened: ReadonlyArray<Guard> = only([throttle]);
        expect(widened).toBeDefined();
    });
});
