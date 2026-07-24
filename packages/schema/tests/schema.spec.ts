// @vitest-environment node
//
// The schema core: every combinator's accept/reject behavior, the ALL-errors-in-one-pass
// property, dot-path error naming, and the two headline contracts - types inferred FROM the
// declaration (expectTypeOf), and `refine` running @azerothjs/form's REAL validators so the
// browser's rules and the server boundary share one source of truth.

import { describe, it, expect, expectTypeOf } from 'vitest';
import { email, required, minLength } from '@azerothjs/form';
import {
    string, number, boolean, literal, enumOf, array, object, record, union,
    SchemaError, type Infer, type Issue
} from '@azerothjs/schema';

describe('inference: the type IS the declaration', () =>
{
    it('infers primitives, objects, arrays, optionals, enums', () =>
    {
        const user = object({
            name: string(),
            age: number({ int: true }),
            admin: boolean().optional(),
            role: enumOf(['viewer', 'editor'] as const),
            tags: array(string())
        });
        expectTypeOf<Infer<typeof user>>().toEqualTypeOf<{
            name: string;
            age: number;
            admin: boolean | undefined;
            role: 'viewer' | 'editor';
            tags: string[];
        }>();
        expect(user.safeParse({ name: 'x', age: 1, role: 'viewer', tags: [] }).ok).toBe(true);
    });

    it('literal and union infer narrow types', () =>
    {
        const version = literal(2);
        expectTypeOf<Infer<typeof version>>().toEqualTypeOf<2>();
        expect(version.parse(2)).toBe(2);

        const id = union([string(), number()] as const);
        expectTypeOf<Infer<typeof id>>().toEqualTypeOf<string | number>();
        expect(id.parse('u1')).toBe('u1');
    });

    it('union called variadically (a JS-caller mistake) throws a precise developer error, not a late TypeError', () =>
    {
        expect(() => union(string() as never, number() as never))
            .toThrow(/union\(\) expects an ARRAY of schemas/);
    });
});

describe('combinator behavior', () =>
{
    it('string bounds length', () =>
    {
        expect(string({ min: 2, max: 4 }).parse('abc')).toBe('abc');
        expect(() => string({ min: 2 }).parse('a')).toThrow(SchemaError);
        expect(() => string().parse(42)).toThrow(/Expected a string/);
    });

    it('number: finiteness, integers, bounds, and EXPLICIT coercion only', () =>
    {
        expect(number().parse(3.5)).toBe(3.5);
        expect(() => number({ int: true }).parse(3.5)).toThrow(/integer/);
        expect(() => number().parse(Number.NaN)).toThrow(/Expected a number/);
        expect(() => number().parse('42')).toThrow(/Expected a number/); // JSON sending strings is a bug
        expect(number({ coerce: true }).parse('42')).toBe(42);           // query strings opt in
        expect(() => number({ coerce: true }).parse('4x')).toThrow(/Expected a number/);
    });

    it('boolean coercion accepts the transport spellings only', () =>
    {
        expect(boolean({ coerce: true }).parse('true')).toBe(true);
        expect(boolean({ coerce: true }).parse('0')).toBe(false);
        expect(() => boolean({ coerce: true }).parse('yes')).toThrow(/Expected a boolean/);
        expect(() => boolean().parse('true')).toThrow(/Expected a boolean/);
    });

    it('object strips unknown keys (mass assignment dies at the boundary)', () =>
    {
        const schema = object({ name: string() });
        const parsed = schema.parse({ name: 'ok', admin: true, __proto__pollution: 'x' });
        expect(parsed).toEqual({ name: 'ok' });
    });

    it('record validates every value under its key path', () =>
    {
        const schema = record(number());
        expect(schema.parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
        const result = schema.safeParse({ a: 1, b: 'x' });
        expect(!result.ok && result.errors).toEqual({ b: 'Expected a number' });
    });

    it('array bounds and element paths', () =>
    {
        expect(() => array(string(), { min: 1 }).parse([])).toThrow(/at least 1 item/);
        const result = array(object({ n: number() })).safeParse([{ n: 1 }, { n: 'x' }]);
        expect(!result.ok && result.errors).toEqual({ '1.n': 'Expected a number' });
    });

    it('union takes the first structural match and reports one error otherwise', () =>
    {
        const schema = union([number(), string()] as const);
        expect(schema.parse('x')).toBe('x');
        expect(schema.parse(4)).toBe(4);
        const result = schema.safeParse(true);
        expect(!result.ok && result.errors).toEqual({ '': 'No union variant matched' });
    });
});

describe('every error, one pass, dot paths', () =>
{
    it('collects all failures across nesting in a single safeParse', () =>
    {
        const schema = object({
            profile: object({ email: string(), age: number() }),
            items: array(object({ qty: number({ min: 1 }) }))
        });
        const result = schema.safeParse({
            profile: { age: 'old' },
            items: [{ qty: 0 }, { qty: 2 }, {}]
        });
        expect(result.ok).toBe(false);
        expect(!result.ok && result.errors).toEqual({
            'profile.email': 'Required',
            'profile.age': 'Expected a number',
            'items.0.qty': 'Must be at least 1',
            'items.2.qty': 'Required'
        });
    });

    it('SchemaError names the fields in its message', () =>
    {
        try
        {
            object({ email: string() }).parse({});
            expect.unreachable();
        }
        catch (error)
        {
            expect(error).toBeInstanceOf(SchemaError);
            expect((error as SchemaError).message).toContain('email: Required');
        }
    });
});

describe('string constraints and normalization', () =>
{
    it('trim and lowercase run first and their result is what parses out', () =>
    {
        const schema = string({ trim: true, lowercase: true });
        expect(schema.parse('  Jaina@Theramore.ORG  ')).toBe('jaina@theramore.org');
        expectTypeOf<Infer<typeof schema>>().toEqualTypeOf<string>();
    });

    it('checks run in the stable order: nonempty -> min -> max -> pattern -> format', () =>
    {
        const schema = string({ trim: true, nonempty: true, min: 2, pattern: /^[a-z]+$/ });
        const empty = schema.safeParse('   '); // trimmed to '' -> nonempty fires, not min
        expect(!empty.ok && empty.issues[0]?.code).toBe('nonempty');
        const short = schema.safeParse('a'); // min fires before pattern
        expect(!short.ok && short.issues[0]?.code).toBe('min');
        const bad = schema.safeParse('A1'); // pattern is the first surviving failure
        expect(!bad.ok && bad.issues[0]?.code).toBe('pattern');
    });

    it('formats: email (the form rule), url, uuid, datetime', () =>
    {
        expect(string({ format: 'email' }).parse('jaina@theramore.org')).toBe('jaina@theramore.org');
        expect(string({ format: 'email' }).safeParse('not-an-email').ok).toBe(false);
        expect(string({ format: 'url' }).parse('https://azerothjs.dev/docs')).toContain('https');
        expect(string({ format: 'url' }).safeParse('not a url').ok).toBe(false);
        expect(string({ format: 'uuid' }).parse('123e4567-e89b-12d3-a456-426614174000')).toContain('-');
        expect(string({ format: 'uuid' }).safeParse('123e4567').ok).toBe(false);
        expect(string({ format: 'datetime' }).parse('2026-07-08T12:30:00Z')).toContain('T');
        expect(string({ format: 'datetime' }).safeParse('2026-13-45T99:99:99Z').ok).toBe(false);
        expect(string({ format: 'datetime' }).safeParse('yesterday').ok).toBe(false);
    });

    it('null and undefined fail the required rule, not the type rule', () =>
    {
        const result = string().safeParse(null);
        expect(!result.ok && result.issues[0]).toEqual({ path: '', code: 'required', message: 'Required' });
    });
});

describe('codes, issues, and modes', () =>
{
    const CODES = { required: 'NOT_EMPTY', nonempty: 'NOT_EMPTY', type: 'INVALID_STRING', min: 'MIN_LENGTH', format: 'INVALID_EMAIL' };

    it('every issue carries a stable code; codes/messages maps override per rule', () =>
    {
        const schema = object({
            name: string({ min: 2, codes: CODES, messages: { min: 'Name is too short' } }),
            email: string({ format: 'email', codes: CODES })
        });
        const result = schema.safeParse({ name: 'x', email: 'nope' });
        expect(result.ok).toBe(false);
        expect(!result.ok && result.issues).toEqual([
            { path: 'name', code: 'MIN_LENGTH', message: 'Name is too short' },
            { path: 'email', code: 'INVALID_EMAIL', message: 'Must be a valid email address' }
        ]);
        // The flat map stays derivable and setError-compatible.
        expect(!result.ok && result.errors).toEqual({ name: 'Name is too short', email: 'Must be a valid email address' });
    });

    it('a MISSING field fails through the field schema, so its codes govern required', () =>
    {
        const schema = object({ firstName: string({ codes: CODES }) });
        const result = schema.safeParse({});
        expect(!result.ok && result.issues[0]).toEqual({ path: 'firstName', code: 'NOT_EMPTY', message: 'Required' });
    });

    it('refine issues take a code and message override', () =>
    {
        const schema = string().refine((value) => (value.endsWith('.dev') ? null : 'wrong tld'), { code: 'BAD_TLD', message: 'Only .dev domains' });
        const result = schema.safeParse('azeroth.com');
        expect(!result.ok && result.issues[0]).toEqual({ path: '', code: 'BAD_TLD', message: 'Only .dev domains' });
    });

    it('mode first stops at the first issue in field-declaration order', () =>
    {
        const schema = object({
            firstName: string({ codes: CODES }),
            lastName: string({ codes: CODES }),
            email: string({ format: 'email', codes: CODES })
        });
        const result = schema.safeParse({}, { mode: 'first' });
        expect(!result.ok && result.issues).toEqual([
            { path: 'firstName', code: 'NOT_EMPTY', message: 'Required' }
        ]);
        // Default mode still collects everything.
        const all = schema.safeParse({});
        expect(!all.ok && all.issues.map((issue: Issue) => issue.path)).toEqual(['firstName', 'lastName', 'email']);
    });

    it('SchemaError carries the issues alongside the field map', () =>
    {
        try
        {
            object({ email: string({ codes: CODES }) }).parse({});
            expect.unreachable();
        }
        catch (error)
        {
            expect((error as SchemaError).issues).toEqual([{ path: 'email', code: 'NOT_EMPTY', message: 'Required' }]);
            expect((error as SchemaError).fields).toEqual({ email: 'Required' });
        }
    });
});

describe('refine: the browser form rules run at the server boundary', () =>
{
    it('accepts @azerothjs/form validators verbatim', () =>
    {
        const signup = object({
            email: string().refine(required('Email is required')).refine(email('Enter a valid email')),
            password: string().refine(minLength(8))
        });

        const bad = signup.safeParse({ email: 'not-an-email', password: 'short' });
        expect(bad.ok).toBe(false);
        expect(!bad.ok && bad.errors.email).toBe('Enter a valid email');
        expect(!bad.ok && bad.errors.password).toContain('8');

        const good = signup.safeParse({ email: 'jaina@theramore.org', password: 'longenough' });
        expect(good.ok).toBe(true);
    });

    it('refinements run only on structurally valid values, in order, first failure wins', () =>
    {
        const calls: string[] = [];
        const schema = number()
            .refine((value) =>
            {
                calls.push('first');
                return value > 0 ? null : 'Must be positive';
            })
            .refine(() =>
            {
                calls.push('second');
                return null;
            });

        expect(schema.safeParse('nan').ok).toBe(false);
        expect(calls).toEqual([]); // structural failure short-circuits refinements

        expect(schema.safeParse(-1).ok).toBe(false);
        expect(calls).toEqual(['first']); // first failure stops the chain

        expect(schema.parse(5)).toBe(5);
        expect(calls).toEqual(['first', 'first', 'second']);
    });
});
