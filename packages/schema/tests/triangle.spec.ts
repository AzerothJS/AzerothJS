// The unification's proof: ONE schema declaration drives (a) the browser form, (b) the api
// client's pre-wire validation, and (c) the server boundary - and the SAME invalid input
// produces the SAME failure at all three. No rule is written twice anywhere in the triangle.

import { describe, it, expect } from 'vitest';
import { object, string, number, SchemaError, type Infer } from '@azerothjs/schema';
import { createForm } from '@azerothjs/form';
import { App, readValidated, json } from '@azerothjs/http';
import { defineContract, route, implementContract, mountApi, createClient } from '@azerothjs/api';

const CODES = { required: 'NOT_EMPTY', nonempty: 'NOT_EMPTY', min: 'MIN_LENGTH', format: 'INVALID_EMAIL' };

// The one declaration. Shared code in a real app; shared constant here.
const signUp = object({
    name: string({ trim: true, nonempty: true, min: 2, codes: CODES }),
    email: string({ lowercase: true, format: 'email', codes: CODES }),
    age: number({ int: true, min: 13 })
});
type SignUp = Infer<typeof signUp>;

const INVALID = { name: 'x', email: 'not-an-email', age: 12 };
const VALID: SignUp = { name: 'Jaina', email: 'jaina@theramore.org', age: 32 };

describe('one schema, three boundaries', () =>
{
    it('(a) the browser form reports the schema failures per field', () =>
    {
        const form = createForm({ initial: { name: '', email: '', age: 0 }, schema: signUp });
        form.setValue('name', INVALID.name);
        form.setValue('email', INVALID.email);
        form.setValue('age', INVALID.age);

        expect(form.errors().name).toBe('Must be at least 2 characters');
        expect(form.errors().email).toBe('Must be a valid email address');
        expect(form.errors().age).toBe('Must be at least 13');
        expect(form.isValid()).toBe(false);

        form.setValue('name', VALID.name);
        form.setValue('email', VALID.email);
        form.setValue('age', VALID.age);
        expect(form.isValid()).toBe(true);
    });

    it('(b) the api client refuses the same input before it ever crosses the wire', async () =>
    {
        const contract = defineContract({
            signUp: route({ method: 'POST', path: '/sign-up', input: signUp })
        });
        let wireHit = false;
        const client = createClient(contract, {
            baseUrl: '/api',
            fetch: () =>
            {
                wireHit = true;
                return Promise.resolve(new Response('{}'));
            }
        });

        const failure: unknown = await client.signUp({ input: INVALID }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(SchemaError);
        expect((failure as SchemaError).issues.map((issue) => [issue.path, issue.code])).toEqual([
            ['name', 'MIN_LENGTH'],
            ['email', 'INVALID_EMAIL'],
            ['age', 'min']
        ]);
        expect(wireHit).toBe(false); // rejected locally
    });

    it('(c) the server boundary rejects a forged request with the identical issues', async () =>
    {
        const app = new App();
        app.post('/sign-up', async ({ request }) => json({ ok: await readValidated(request, signUp) }));

        const response = await app.handle(new Request('http://local/sign-up', {
            method: 'POST',
            body: JSON.stringify(INVALID),
            headers: { 'content-type': 'application/json' }
        }));
        expect(response.status).toBe(422);
        const body = await response.json() as { error: { details: { issues: Array<{ path: string; code: string }> } } };
        expect(body.error.details.issues.map((issue) => [issue.path, issue.code])).toEqual([
            ['name', 'MIN_LENGTH'],
            ['email', 'INVALID_EMAIL'],
            ['age', 'min']
        ]);
    });

    it('mountApi enforces the same contract for the mounted route tree', async () =>
    {
        const contract = defineContract({
            signUp: route({ method: 'POST', path: '/sign-up', input: signUp })
        });
        const app = new App();
        mountApi(app, implementContract(contract, { signUp: ({ input }) => ({ created: input.name }) }));

        const response = await app.handle(new Request('http://local/api/sign-up', {
            method: 'POST',
            body: JSON.stringify(INVALID),
            headers: { 'content-type': 'application/json' }
        }));
        expect(response.status).toBe(422);
        const body = await response.json() as { error: { details: { issues: Array<{ code: string }> } } };
        expect(body.error.details.issues[0]?.code).toBe('MIN_LENGTH');
    });
});
