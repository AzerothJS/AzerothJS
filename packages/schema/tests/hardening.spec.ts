// @vitest-environment node
//
// Boundary hardening for the validator - the properties an application trusts it for when the
// input is hostile rather than merely wrong: a bounded issue collector (a bulk body must not
// become the response's size and the event loop's stall), OWN-property reads (a polluted
// prototype cannot mass-assign through the schema), an error map and an exception message that
// survive keys named after Object.prototype members, a parsed record that is safe to merge and
// whose keys shadow nothing, and options that cannot be enforced refused where they are written
// rather than degrading into a constraint that accepts everything.

import { runInNewContext } from 'node:vm';
import { describe, it, expect, afterEach } from 'vitest';
import { array, boolean, date, number, object, record, string } from '@azerothjs/schema';
import type { Schema, SchemaError } from '@azerothjs/schema';

/** A shape whose field name is `__proto__` - an object literal would set the prototype instead. */
function shapeWithProtoField(): Record<string, Schema<unknown>>
{
    const shape: Record<string, Schema<unknown>> = {};
    Object.defineProperty(shape, '__proto__', { value: string(), enumerable: true, writable: true, configurable: true });
    return shape;
}

describe('the issue ceiling', () =>
{
    it('caps a bulk body\'s issues and marks the result truncated', () =>
    {
        const schema = array(object({ a: string(), b: string(), c: string(), d: string(), e: string() }));
        // 50000 empty objects x 5 declared fields = 250000 issues uncapped, every one of them
        // serialized into the 422 alongside a field-map entry.
        const body = Array.from({ length: 50_000 }, () => ({}));

        const startedAt = performance.now();
        const result = schema.safeParse(body);
        const elapsedMs = performance.now() - startedAt;

        expect(result.ok).toBe(false);
        expect(!result.ok && result.issues.length).toBe(100);
        expect(!result.ok && result.truncated).toBe(true);
        expect(!result.ok && Object.keys(result.errors).length).toBe(100);
        expect(JSON.stringify(!result.ok ? result.errors : {}).length).toBeLessThan(20_000);
        expect(elapsedMs).toBeLessThan(1000);
    });

    it('a valid body of the same size is unaffected', () =>
    {
        const schema = array(object({ a: string() }));
        const body = Array.from({ length: 5_000 }, () => ({ a: 'ok' }));
        const result = schema.safeParse(body);
        expect(result.ok).toBe(true);
        expect(result.ok && result.value.length).toBe(5_000);
    });

    it('the exception carries the truncation flag and a bounded message', () =>
    {
        try
        {
            array(object({ a: string(), b: string() })).parse(Array.from({ length: 200 }, () => ({})));
            expect.unreachable();
        }
        catch (error)
        {
            const failure = error as SchemaError;
            expect(failure.truncated).toBe(true);
            expect(failure.issues.length).toBe(100);
            expect(failure.message).toContain('100+ fields');
            expect(failure.message).toContain('(+95 more)');
            expect(failure.message.length).toBeLessThan(400);
        }
    });

    it('a walk that ends exactly at the ceiling dropped nothing and is not truncated', () =>
    {
        const result = array(string()).safeParse(Array.from({ length: 100 }, () => 0));
        expect(!result.ok && result.issues.length).toBe(100);
        expect(!result.ok && result.truncated).toBeUndefined();
    });

    it('one failure past the ceiling is truncated', () =>
    {
        const result = array(string()).safeParse(Array.from({ length: 101 }, () => 0));
        expect(!result.ok && result.issues.length).toBe(100);
        expect(!result.ok && result.truncated).toBe(true);
    });

    it('a nested walk whose last field lands the last issue is complete, not truncated', () =>
    {
        const schema = array(object({ a: string(), b: string(), c: string(), d: string(), e: string() }));
        const result = schema.safeParse(Array.from({ length: 20 }, () => ({})));
        expect(!result.ok && result.issues.length).toBe(100);
        expect(!result.ok && result.truncated).toBeUndefined();
    });

    it('a record whose last key lands the last issue is complete, not truncated', () =>
    {
        const input = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`k${ index }`, 0]));
        const result = record(string()).safeParse(input);
        expect(!result.ok && result.issues.length).toBe(100);
        expect(!result.ok && result.truncated).toBeUndefined();
    });

    it('an ordinary handful of failures still reports every one, untruncated', () =>
    {
        const result = object({ a: string(), b: string(), c: string() }).safeParse({});
        expect(!result.ok && result.issues.map((issue) => issue.path)).toEqual(['a', 'b', 'c']);
        expect(!result.ok && result.truncated).toBeUndefined();
    });
});

describe('prototype safety', () =>
{
    afterEach(() =>
    {
        Reflect.deleteProperty(Object.prototype, 'role');
        Reflect.deleteProperty(Object.prototype, 'isAdmin');
    });

    it('object() reads OWN properties only, so pollution elsewhere cannot mass-assign', () =>
    {
        (Object.prototype as Record<string, unknown>).role = 'admin';
        (Object.prototype as Record<string, unknown>).isAdmin = true;

        const schema = object({ name: string(), role: string().optional(), isAdmin: boolean().optional() });
        const parsed = schema.parse(JSON.parse('{"name":"bob"}'));

        // Own keys are the parsed value; what Object.prototype still answers for is the
        // pollution itself, not something the validator declared valid.
        expect(Object.keys(parsed)).toEqual(['name']);
        expect(Object.hasOwn(parsed, 'role')).toBe(false);
        expect(Object.hasOwn(parsed, 'isAdmin')).toBe(false);
        expect(JSON.stringify(parsed)).toBe('{"name":"bob"}');
    });

    it('a field named after a prototype member still fails its required check', () =>
    {
        const result = object({ constructor: string(), toString: string() }).safeParse({});
        expect(!result.ok && result.issues).toEqual([
            { path: 'constructor', code: 'required', message: 'Required' },
            { path: 'toString', code: 'required', message: 'Required' }
        ]);
    });

    it('the error map holds STRINGS for prototype-member paths, never an inherited function', () =>
    {
        const result = record(number()).safeParse(JSON.parse('{"constructor":"nope","toString":"nope"}'));
        expect(result.ok).toBe(false);
        const errors = !result.ok ? result.errors : {};
        expect(typeof errors['constructor']).toBe('string');
        expect(errors['constructor']).toBe('Expected a number');
        expect(errors['toString']).toBe('Expected a number');
        expect(JSON.parse(JSON.stringify(errors))).toEqual({ constructor: 'Expected a number', toString: 'Expected a number' });
    });

    it('a __proto__ field path lands in the map instead of vanishing into the setter', () =>
    {
        const result = object(shapeWithProtoField()).safeParse({});
        expect(result.ok).toBe(false);
        const errors = !result.ok ? result.errors : {};
        expect(Object.keys(errors)).toEqual(['__proto__']);
        expect(errors['__proto__']).toBe('Required');
        expect(JSON.stringify(errors)).toBe('{"__proto__":"Required"}');
    });

    it('the exception message names the count and the field even for a __proto__ path', () =>
    {
        try
        {
            object(shapeWithProtoField()).parse({});
            expect.unreachable();
        }
        catch (error)
        {
            expect((error as SchemaError).message).toBe('Validation failed for 1 field: __proto__: Required');
        }
    });

    it('a parsed record has a null prototype, so a key never shadows an Object.prototype member', () =>
    {
        const parsed = record(string()).parse(JSON.parse('{"toString":"pwned","hasOwnProperty":"x","name":"ok"}'));
        expect(Object.getPrototypeOf(parsed)).toBe(null);
        expect(parsed['toString']).toBe('pwned');
        expect(parsed['name']).toBe('ok');
        expect(JSON.parse(JSON.stringify(parsed))).toEqual({ toString: 'pwned', hasOwnProperty: 'x', name: 'ok' });
        // A key that was never sent answers with nothing - no inherited function leaks through.
        const plain = record(string()).parse({ a: 'b' }) as Record<string, unknown>;
        expect(plain['constructor']).toBeUndefined();
    });

    // object() shares record()'s null prototype, and the CONSEQUENCE is part of its documented
    // contract rather than an implementation detail: a caller that interpolates a parsed value
    // into a string gets a TypeError, not a description. Pinned so the docblock cannot drift
    // from the behaviour, and so removing the null prototype is a loud change and not a quiet one.
    it('a parsed object has a null prototype, and stringifying one throws rather than answers', () =>
    {
        const parsed = object({ name: string() }).parse({ name: 'ok' });
        expect(Object.getPrototypeOf(parsed)).toBe(null);

        // What still works, and is the overwhelmingly common way a parsed value is consumed.
        expect(parsed.name).toBe('ok');
        expect(Object.keys(parsed)).toEqual(['name']);
        expect(JSON.stringify(parsed)).toBe('{"name":"ok"}');
        expect({ ...parsed }).toEqual({ name: 'ok' });

        // What does not, which is the half worth documenting. Each rule below is disabled for
        // the same reason: they all assume a value that INHERITS Object.prototype, and the
        // whole point of these lines is that this one does not - lint predicts
        // '[object Object]', the runtime throws, and the arm pins the runtime.
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- see above
        expect(() => String(parsed)).toThrow(TypeError);
        // eslint-disable-next-line @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions -- see above
        expect(() => `${ parsed }`).toThrow(TypeError);
        expect(() => (parsed as { toString(): string }).toString()).toThrow(TypeError);
        // eslint-disable-next-line no-prototype-builtins -- calling it on the instance IS the probe: it throws, it does not answer
        expect(() => (parsed as unknown as { hasOwnProperty(k: string): boolean }).hasOwnProperty('name')).toThrow(TypeError);

        // The escape hatch the docblock points at.
        expect(Object.prototype.hasOwnProperty.call(parsed, 'name')).toBe(true);
    });

    it('record() strips an own __proto__ key, so a validated body is safe to merge', () =>
    {
        const schema = record(record(string()));
        const parsed = schema.parse(JSON.parse('{"config":{"a":"b"},"__proto__":{"isAdmin":"yes"}}'));
        expect(Object.keys(parsed)).toEqual(['config']);

        // The everyday handler move: merge the validated body into a target object.
        const target: { isAdmin?: string } = {};
        Object.assign(target, parsed);
        expect(target.isAdmin).toBeUndefined();
        expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    });
});

describe('the exception message', () =>
{
    it('never repeats an attacker key as the path: message grammar', () =>
    {
        try
        {
            record(number()).parse(JSON.parse('{"x: injected; y":"nope"}'));
            expect.unreachable();
        }
        catch (error)
        {
            const { message } = error as SchemaError;
            expect(message).toContain('x??injected??y: Expected a number');
            expect(message).not.toContain('x: injected;');
            // The real key stays intact where a consumer needs it.
            expect((error as SchemaError).fields['x: injected; y']).toBe('Expected a number');
        }
    });

    it('bounds a very long key', () =>
    {
        const key = 'k'.repeat(500);
        try
        {
            record(number()).parse(JSON.parse(`{"${ key }":"nope"}`));
            expect.unreachable();
        }
        catch (error)
        {
            const { message } = error as SchemaError;
            expect(message.length).toBeLessThan(200);
            expect(message).toContain('...');
        }
    });
});

describe('constraints that could not be enforced', () =>
{
    it('a non-RegExp pattern throws where the schema is written instead of matching everything', () =>
    {
        for (const bad of ['abc', {}, null, 42, ['abc']])
        {
            expect(() => string({ pattern: bad as unknown as RegExp })).toThrow(TypeError);
            expect(() => string({ pattern: bad as unknown as RegExp })).toThrow(/expects a RegExp/);
        }
    });

    it('a real pattern still builds and still rejects, whatever its flags or realm', () =>
    {
        expect(string({ pattern: /^[a-z]+$/ }).safeParse('ABC').ok).toBe(false);
        expect(string({ pattern: /^[a-z]+$/g }).safeParse('abc').ok).toBe(true);
        // A RegExp from another realm is still a RegExp - its constructor is simply not ours.
        const foreign = runInNewContext('/^[a-z]+$/') as RegExp;
        expect(foreign instanceof RegExp).toBe(false);
        expect(string({ pattern: foreign }).safeParse('abc').ok).toBe(true);
        expect(string({ pattern: foreign }).safeParse('ABC').ok).toBe(false);
    });

    it('an unknown format throws instead of leaving the value unchecked', () =>
    {
        expect(() => string({ format: 'phone' as 'email' })).toThrow(/unknown format/);
        // A prototype member is not a rule: `toString` would answer the lookup and pass anything.
        expect(() => string({ format: 'toString' as 'email' })).toThrow(TypeError);
        expect(string({ format: 'email' }).safeParse('not-an-email').ok).toBe(false);
    });

    it('a date bound that names no instant throws instead of dropping the bound', () =>
    {
        // The config-typo shape: `new Date(undefined)` is a Date, and every comparison against
        // it is false, so the bound would be written and never enforced.
        expect(() => date({ min: new Date('nonsense') })).toThrow(TypeError);
        expect(() => date({ max: new Date(NaN) })).toThrow(/valid Date/);
        expect(() => date({ min: '2026-01-01T00:00:00Z' as unknown as Date })).toThrow(/valid Date/);
    });

    it('a valid date bound still builds and still rejects, whatever its realm', () =>
    {
        const bounded = date({ min: new Date('2026-01-01T00:00:00Z') });
        expect(bounded.safeParse('2025-12-31T23:59:59Z').ok).toBe(false);
        expect(bounded.safeParse('2026-06-01T00:00:00Z').ok).toBe(true);
        // A Date from another realm is still a Date - its constructor is simply not ours.
        const foreign = runInNewContext('new Date("2026-01-01T00:00:00Z")') as Date;
        expect(foreign instanceof Date).toBe(false);
        expect(date({ min: foreign }).safeParse('2025-12-31T23:59:59Z').ok).toBe(false);
        expect(date({ min: foreign }).safeParse('2026-06-01T00:00:00Z').ok).toBe(true);
    });
});
