// @vitest-environment node
//
// Every house schema carries the Standard Schema v1 face (`~standard`) - so a
// @azerothjs/schema declaration plugs into ANY Standard-Schema-aware consumer (form
// resolvers, tRPC, other frameworks) exactly like a Zod schema would. Validation is
// synchronous, success carries the (coerced) value, and failure maps the house's
// dotted issue paths onto the spec's segment arrays.
import { describe, it, expect } from 'vitest';
import { object, string, number, array, union, boolean, type StandardResult } from '@azerothjs/schema';

function sync<T>(result: StandardResult<T> | Promise<StandardResult<T>>): StandardResult<T>
{
    expect(result).not.toBeInstanceOf(Promise); // the house face is always synchronous
    return result as StandardResult<T>;
}

describe('the ~standard face', () =>
{
    it('is present, versioned, and vendored on every schema kind', () =>
    {
        for (const schema of [string(), number(), boolean(), object({ a: string() }), array(string()), union([string(), number()])])
        {
            expect(schema['~standard'].version).toBe(1);
            expect(schema['~standard'].vendor).toBe('azerothjs');
            expect(typeof schema['~standard'].validate).toBe('function');
        }
    });

    it('success returns the validated (coerced) value', () =>
    {
        const result = sync(number({ coerce: true })['~standard'].validate('42'));
        expect(result.issues).toBeUndefined();
        expect((result as { value: number }).value).toBe(42);
    });

    it('failure maps dotted paths to segment arrays; a root issue has no path', () =>
    {
        const shape = object({ user: object({ email: string({ min: 3 }) }) });
        const nested = sync(shape['~standard'].validate({ user: { email: 'x' } }));
        expect(nested.issues).toBeDefined();
        expect(nested.issues![0]?.path).toEqual(['user', 'email']);

        const root = sync(string()['~standard'].validate(42));
        expect(root.issues).toBeDefined();
        expect(root.issues![0]?.path).toBeUndefined(); // root-level: no path per spec
    });

    it('a house schema passes a generic Standard-Schema consumer round trip', async () =>
    {
        // The shape any ~standard-aware library runs - no house APIs involved.
        async function consume<T>(schema: { '~standard': { validate: (v: unknown) => StandardResult<T> | Promise<StandardResult<T>> } }, value: unknown): Promise<T>
        {
            const result = await schema['~standard'].validate(value);
            if (result.issues !== undefined)
            {
                throw new Error(result.issues.map((issue) => issue.message).join('; '));
            }
            return result.value;
        }
        await expect(consume(object({ n: number() }), { n: 7 })).resolves.toEqual({ n: 7 });
        await expect(consume(object({ n: number() }), { n: 'x' })).rejects.toThrow();
    });
});
