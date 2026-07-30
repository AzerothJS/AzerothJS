// A guard key that addresses no route used to be silent, which is the one direction that
// matters: a renamed group, or a wildcard written for the absolute path and then mounted as a
// subtree, left its routes with NO guard. Nothing surfaced it - a pure gate adds nothing to the
// context, so no handler type changed, and the type check cannot catch it either (`Guards` is
// inferred from the map literal, so the excess-property check only fires when no key is valid).
import { describe, expect, it } from 'vitest';

import { App } from '@azerothjs/http';
import { defineContract, get, post, mountApi } from '@azerothjs/http/api';
import { object, string } from '@azerothjs/schema';

describe('guard key coverage', () =>
{
    const contract = defineContract({
        console: {
            signIn: post('/console/session'),
            balances: get('/console/balances')
        }
    });

    const handlers = {
        'console.signIn': () => ({ ok: true }),
        'console.balances': () => ({ total: 1 })
    };

    it('a wildcard key for a renamed group throws instead of leaving the routes open', () =>
    {
        expect(() => mountApi(new App(), contract, {
            guards: {
                '*': [(): void =>
                {}],
                // The group is `console` now. This key protects nothing.
                'admin.*': [(): Response => new Response(null, { status: 401 })]
            } as never,
            handlers
        })).toThrow(/guard key "admin\.\*" matches no route/);
    });

    it('an absolute-path key against a SUBTREE mount throws (keys are relative to the group)', () =>
    {
        expect(() => mountApi(new App(), contract.console, {
            guards: { 'console.*': [(): Response => new Response(null, { status: 401 })] } as never,
            handlers: { signIn: () => ({ ok: true }), balances: () => ({ total: 1 }) }
        })).toThrow(/matches no route/);
    });

    it('an exact key with a typo throws even when another key is valid', () =>
    {
        expect(() => mountApi(new App(), contract, {
            guards: {
                '*': [(): void =>
                {}],
                'console.balancse': [(): void =>
                {}]
            } as never,
            handlers
        })).toThrow(/guard key "console\.balancse" matches no route/);
    });

    it('the keys that DO address routes still mount, and still run', async () =>
    {
        const ran: string[] = [];
        const app = new App({ dev: false });
        mountApi(app, contract, {
            guards: {
                '*': [(): void =>
                {
                    ran.push('audit');
                }],
                'console.*': [(): void =>
                {
                    ran.push('requireOperator');
                }],
                'console.balances': [(): void =>
                {
                    ran.push('exact');
                }]
            },
            handlers
        });

        const response = await app.handle(new Request('http://x/api/console/balances'));
        expect(response.status).toBe(200);
        expect(ran).toEqual(['audit', 'requireOperator', 'exact']);
    });

    it('a query field named after a prototype member reaches the handler as its own value', async () =>
    {
        const app = new App({ dev: false });
        let seen: unknown;
        const probe = defineContract({
            probe: get('/probe', { query: object({ constructor: string(), toString: string() }) })
        });
        mountApi(app, probe, {
            handlers: { probe: (context) =>
            {
                seen = context.query; return { ok: true };
            } }
        });

        // Before the flattening fix these read through Object.prototype: the inherited function
        // won the `??`, the client's value was discarded, and the route 422'd forever.
        const response = await app.handle(new Request('http://x/api/probe?constructor=zzz&toString=yyy'));
        expect(response.status).toBe(200);
        expect(seen).toEqual({ constructor: 'zzz', toString: 'yyy' });
    });
});
