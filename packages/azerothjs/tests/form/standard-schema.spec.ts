// @vitest-environment happy-dom
//
// Bring-your-own-validator in forms: FormConfig.schema and per-field validate entries
// accept any SYNCHRONOUS Standard Schema validator (the Zod/Valibot shape) beside the
// native @azerothjs/schema - a team keeps its existing schemas without rewriting them.
// An ASYNC foreign schema is a loud configuration error (the sync pipeline runs per
// keystroke; async checks belong in validateAsync), never a silent skip.
import { describe, it, expect } from 'vitest';
import { createRoot, createForm } from 'azerothjs';

/** A hand-built foreign validator in the exact Standard Schema v1 shape (a Zod stand-in). */
function foreignSchema<T>(check: (value: T) => Array<{ message: string; path?: Array<PropertyKey> }>): {
    '~standard': { version: 1; vendor: 'zod-stand-in'; validate: (value: unknown) => { value: T; issues?: undefined } | { issues: Array<{ message: string; path?: Array<PropertyKey> }> } };
}
{
    return {
        '~standard': {
            version: 1,
            vendor: 'zod-stand-in',
            validate: (value: unknown) =>
            {
                const issues = check(value as T);
                return issues.length === 0 ? { value: value as T } : { issues };
            }
        }
    };
}

describe('foreign Standard Schema validators in createForm', () =>
{
    it('a foreign whole-form schema maps issues onto fields and clears them when fixed', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({
                initial: { email: '', age: 30 },
                schema: foreignSchema<{ email: string; age: number }>((values) =>
                    values.email.includes('@') ? [] : [{ message: 'Email must contain @', path: ['email'] }])
            });

            form.handleSubmit(new Event('submit'));
            expect(form.errors().email).toBe('Email must contain @');
            expect(form.errors().age).toBeNull();

            form.setValue('email', 'jaina@theramore.org');
            expect(form.errors().email).toBeNull(); // previously flagged, now cleared
            dispose();
        });
    });

    it('a foreign per-field validator reports its first issue message', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({
                initial: { name: 'ok' },
                validate: {
                    name: foreignSchema<string>((value) =>
                        value.length >= 2 ? [] : [{ message: 'Too short' }])
                }
            });
            form.setValue('name', 'x');
            expect(form.errors().name).toBe('Too short');
            form.setValue('name', 'xy');
            expect(form.errors().name).toBeNull();
            dispose();
        });
    });

    it('an ASYNC foreign schema throws a descriptive configuration error', () =>
    {
        createRoot((dispose) =>
        {
            const asyncSchema = {
                '~standard': {
                    version: 1 as const,
                    vendor: 'async-zod',
                    validate: () => Promise.resolve({ value: {} })
                }
            };
            // The eager isValid derivation runs the schema at creation - the
            // misconfiguration fails FAST, at createForm itself.
            expect(() => createForm({
                initial: { a: '' },
                schema: asyncSchema as never
            })).toThrow(/ASYNCHRONOUS.*validateAsync/s);
            dispose();
        });
    });
});
