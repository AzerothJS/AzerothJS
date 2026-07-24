// @vitest-environment node
//
// readValidated: readJson + schema.safeParse in one call. The schema is @azerothjs/schema's
// REAL Schema satisfying the kernel's STRUCTURAL SchemaLike - no dependency between the
// packages, one integration. Failures are 422s whose details carry both the setError-ready
// field map and the ordered coded issues.

import { describe, it, expect } from 'vitest';
import { App, readValidated, json } from '@azerothjs/http';
import { object, string, number } from '@azerothjs/schema';

const CODES = { required: 'NOT_EMPTY', min: 'MIN_LENGTH', format: 'INVALID_EMAIL' };

const schema = object({
    name: string({ trim: true, min: 2, codes: CODES }),
    email: string({ lowercase: true, format: 'email', codes: CODES }),
    age: number({ int: true, min: 0 })
});

function app(mode?: 'first'): App
{
    const instance = new App();
    instance.post('/users', async ({ request }) =>
    {
        const input = await readValidated(request, schema, mode !== undefined ? { mode } : {});
        return json({ input });
    });
    return instance;
}

function post(body: unknown, contentType = 'application/json'): Request
{
    return new Request('http://local/users', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': contentType }
    });
}

describe('readValidated', () =>
{
    it('returns the parsed, NORMALIZED value on success', async () =>
    {
        const response = await app().handle(post({ name: '  Jaina  ', email: 'Jaina@Theramore.ORG', age: 32 }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ input: { name: 'Jaina', email: 'jaina@theramore.org', age: 32 } });
    });

    it('a failure is a 422 carrying the field map AND the coded issues', async () =>
    {
        const response = await app().handle(post({ name: 'x', email: 'nope', age: 1.5 }));
        expect(response.status).toBe(422);
        const body = await response.json() as { error: { code: string; details: { fields: Record<string, string>; issues: Array<{ path: string; code: string }> } } };
        expect(body.error.code).toBe('validation-failed');
        expect(Object.keys(body.error.details.fields).sort()).toEqual(['age', 'email', 'name']);
        expect(body.error.details.issues.map((issue) => [issue.path, issue.code])).toEqual([
            ['name', 'MIN_LENGTH'],
            ['email', 'INVALID_EMAIL'],
            ['age', 'int']
        ]);
    });

    it('mode first yields exactly one issue, in field-declaration order', async () =>
    {
        const response = await app('first').handle(post({}));
        expect(response.status).toBe(422);
        const body = await response.json() as { error: { details: { issues: Array<{ path: string; code: string }> } } };
        expect(body.error.details.issues).toEqual([{ path: 'name', code: 'NOT_EMPTY', message: 'Required' }]);
    });

    it('the wrong Content-Type never reaches the schema (415 from readJson)', async () =>
    {
        const response = await app().handle(post({ name: 'Jaina', email: 'j@t.org', age: 1 }, 'text/plain'));
        expect(response.status).toBe(415);
    });
});
