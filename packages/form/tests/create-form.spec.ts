// @vitest-environment node
//
// Full behavioral coverage for createForm (create-form.ts). Form state is
// DOM-independent - values/errors/touched/dirty/submitting/isValid are plain
// signals/memos and setValue/setError/reset/handleSubmit are plain methods - so
// this suite runs in a DOM-less node environment. The form is always built
// inside a createRoot so its internal validation effect has an owner, and the
// root is disposed at the end of each test. No mocks: real signals, real effects.
import { describe, it, expect, vi } from 'vitest';
import { createRoot, createEffect } from '@azerothjs/reactivity';
import { createForm, required, minLength, combine, email } from '@azerothjs/form';
import type { FormApi } from '@azerothjs/form';

// Lets a microtask-resolving promise settle and gives the reactive system a tick.
function flush(): Promise<void>
{
    return new Promise(resolve => setTimeout(resolve, 0));
}

describe('createForm — initial state', () =>
{
    it('exposes the initial values, with all errors null and nothing touched/dirty', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({ initial: { name: 'Ada', age: 36 } });
            expect(form.values()).toEqual({ name: 'Ada', age: 36 });
            expect(form.errors()).toEqual({ name: null, age: null });
            expect(form.touched()).toEqual({ name: false, age: false });
            expect(form.dirty()).toEqual({ name: false, age: false });
            expect(form.submitting()).toBe(false);
            expect(form.submitError()).toBeNull();
            expect(form.isValid()).toBe(true);
            dispose();
        });
    });

    it('runs validators eagerly so isValid reflects invalid initial values', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({
                initial: { name: '' },
                validate: { name: required() }
            });
            // The validation effect runs on creation, so an empty required field
            // is already errored even before any interaction.
            expect(form.errors().name).toBe('This field is required');
            expect(form.isValid()).toBe(false);
            dispose();
        });
    });
});

describe('createForm — setValue and reactive values', () =>
{
    it('updates a field via setValue and reflects it in values()', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({ initial: { name: '', email: '' } });
            form.setValue('name', 'Grace');
            expect(form.values()).toEqual({ name: 'Grace', email: '' });
            form.setValue('email', 'grace@example.com');
            expect(form.values()).toEqual({ name: 'Grace', email: 'grace@example.com' });
            dispose();
        });
    });

    it('notifies a downstream effect when values change', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({ initial: { q: '' } });
            const seen: string[] = [];
            // values() subscribes to every field collectively; the effect is
            // owned by this root and torn down by dispose() at the end. The body
            // returns void - an effect's return value is treated as a cleanup.
            createEffect(() =>
            {
                seen.push(form.values().q);
            });
            form.setValue('q', 'a');
            form.setValue('q', 'b');
            expect(seen).toEqual(['', 'a', 'b']);
            dispose();
        });
    });
});

describe('createForm — live validation on change', () =>
{
    it('re-validates synchronously on every value change', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({
                initial: { name: '' },
                validate: { name: combine(required(), minLength(3)) }
            });
            expect(form.errors().name).toBe('This field is required');

            form.setValue('name', 'ab');
            expect(form.errors().name).toBe('Must be at least 3 characters');
            expect(form.isValid()).toBe(false);

            form.setValue('name', 'abc');
            expect(form.errors().name).toBeNull();
            expect(form.isValid()).toBe(true);
            dispose();
        });
    });

    it('leaves un-validated fields error-free regardless of their value', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({
                initial: { a: '', b: '' },
                validate: { a: required() }
            });
            form.setValue('b', 'anything');
            expect(form.errors().b).toBeNull();
            expect(form.errors().a).toBe('This field is required');
            dispose();
        });
    });
});

describe('createForm — touched, dirty, isValid reactivity', () =>
{
    it('marks a field touched via the registered onBlur handler', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({ initial: { name: '' } });
            expect(form.touched().name).toBe(false);
            form.register('name').onBlur();
            expect(form.touched().name).toBe(true);
            dispose();
        });
    });

    it('reports dirty by value comparison for primitives', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({ initial: { name: 'init' } });
            expect(form.dirty().name).toBe(false);
            form.setValue('name', 'changed');
            expect(form.dirty().name).toBe(true);
            // Setting it back to the initial value clears dirty (reference equal).
            form.setValue('name', 'init');
            expect(form.dirty().name).toBe(false);
            dispose();
        });
    });

    it('treats object/array fields as always dirty after the first write (reference comparison)', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm<{ tags: string[] }>({ initial: { tags: [] } });
            expect(form.dirty().tags).toBe(false);
            // A new array reference - even if structurally equal - reads as dirty.
            form.setValue('tags', []);
            expect(form.dirty().tags).toBe(true);
            dispose();
        });
    });

    it('isValid is a live memo over the errors map', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({
                initial: { email: '' },
                validate: { email: combine(required(), email()) }
            });
            expect(form.isValid()).toBe(false);
            form.setValue('email', 'bad');
            expect(form.isValid()).toBe(false);
            form.setValue('email', 'good@example.com');
            expect(form.isValid()).toBe(true);
            dispose();
        });
    });
});

describe('createForm — setError', () =>
{
    it('injects a server-side error onto a specific field', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({ initial: { username: '' } });
            form.setError('username', 'Username taken');
            expect(form.errors().username).toBe('Username taken');
            expect(form.isValid()).toBe(false);
            dispose();
        });
    });

    it('survives editing a DIFFERENT (un-validated) field — the validation effect merges', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({
                initial: { username: '', bio: '' },
                // username has NO validator, so the merge leaves its injected error.
                validate: { bio: required() }
            });
            form.setError('username', 'Username taken');
            form.setValue('bio', 'hello');
            // Editing bio re-ran validation, but username (no validator) keeps its error.
            expect(form.errors().username).toBe('Username taken');
            dispose();
        });
    });

    it('a validated field re-validates over an injected error when its own value changes', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({
                initial: { name: 'ok' },
                validate: { name: required() }
            });
            form.setError('name', 'Server says no');
            expect(form.errors().name).toBe('Server says no');
            // Editing the validated field itself recomputes its error, clearing the injection.
            form.setValue('name', 'still ok');
            expect(form.errors().name).toBeNull();
            dispose();
        });
    });
});

describe('createForm — handleSubmit', () =>
{
    it('calls preventDefault and marks every field touched', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({ initial: { a: 'x', b: 'y' } });
            const preventDefault = vi.fn();
            form.handleSubmit({ preventDefault } as unknown as Event);
            expect(preventDefault).toHaveBeenCalledTimes(1);
            expect(form.touched()).toEqual({ a: true, b: true });
            dispose();
        });
    });

    it('blocks onSubmit when validation fails', () =>
    {
        createRoot((dispose) =>
        {
            const onSubmit = vi.fn();
            const form = createForm({
                initial: { name: '' },
                validate: { name: required() },
                onSubmit
            });
            form.handleSubmit({ preventDefault()
            {} } as unknown as Event);
            expect(onSubmit).not.toHaveBeenCalled();
            // Errors are now visible because all fields were marked touched.
            expect(form.touched().name).toBe(true);
            expect(form.errors().name).toBe('This field is required');
            dispose();
        });
    });

    it('calls onSubmit with the current values when valid', () =>
    {
        createRoot((dispose) =>
        {
            const onSubmit = vi.fn();
            const form = createForm({
                initial: { name: '' },
                validate: { name: required() },
                onSubmit
            });
            form.setValue('name', 'Ada');
            form.handleSubmit({ preventDefault()
            {} } as unknown as Event);
            expect(onSubmit).toHaveBeenCalledTimes(1);
            expect(onSubmit).toHaveBeenCalledWith({ name: 'Ada' });
            dispose();
        });
    });

    it('re-validates against a fresh snapshot, catching values set after the last effect run', () =>
    {
        createRoot((dispose) =>
        {
            const onSubmit = vi.fn();
            const form = createForm({
                initial: { name: 'valid' },
                validate: { name: required() },
                onSubmit
            });
            // Make it invalid right before submit; handleSubmit recomputes errors.
            form.setValue('name', '');
            form.handleSubmit({ preventDefault()
            {} } as unknown as Event);
            expect(onSubmit).not.toHaveBeenCalled();
            expect(form.errors().name).toBe('This field is required');
            dispose();
        });
    });

    it('does nothing harmful when valid but no onSubmit is configured', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({ initial: { name: 'ok' } });
            expect(() =>
                form.handleSubmit({ preventDefault()
                {} } as unknown as Event)
            ).not.toThrow();
            expect(form.submitting()).toBe(false);
            dispose();
        });
    });
});

describe('createForm — async submit lifecycle', () =>
{
    it('toggles submitting() true for the duration of a pending onSubmit promise', async () =>
    {
        let resolveSubmit!: () => void;
        let form!: ReturnType<typeof buildAsyncForm>;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            form = buildAsyncForm(() => new Promise<void>(r =>
            {
                resolveSubmit = r;
            }));
        });

        form.setValue('name', 'Ada');
        expect(form.submitting()).toBe(false);
        form.handleSubmit({ preventDefault()
        {} } as unknown as Event);
        // Promise is pending -> submitting is true.
        expect(form.submitting()).toBe(true);

        resolveSubmit();
        await flush();
        // Resolution flips submitting back to false; no submitError.
        expect(form.submitting()).toBe(false);
        expect(form.submitError()).toBeNull();
        dispose();
    });

    it('populates submitError and clears submitting when onSubmit rejects', async () =>
    {
        const failure = new Error('network down');
        let form!: ReturnType<typeof buildAsyncForm>;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            form = buildAsyncForm(() => Promise.reject(failure));
        });

        form.setValue('name', 'Ada');
        form.handleSubmit({ preventDefault()
        {} } as unknown as Event);
        expect(form.submitting()).toBe(true);

        await flush();
        expect(form.submitting()).toBe(false);
        expect(form.submitError()).toBe(failure);
        dispose();
    });

    it('populates submitError and clears submitting on a synchronous throw in onSubmit', () =>
    {
        const failure = new Error('boom');
        createRoot((dispose) =>
        {
            const form = createForm({
                initial: { name: 'Ada' },
                onSubmit: () =>
                {
                    throw failure;
                }
            });
            form.handleSubmit({ preventDefault()
            {} } as unknown as Event);
            expect(form.submitError()).toBe(failure);
            expect(form.submitting()).toBe(false);
            dispose();
        });
    });

    it('clears a previous submitError at the start of a new valid submit', async () =>
    {
        let mode: 'reject' | 'resolve' = 'reject';
        const failure = new Error('first attempt');
        let form!: ReturnType<typeof buildAsyncForm>;
        let dispose!: () => void;
        createRoot((d) =>
        {
            dispose = d;
            form = buildAsyncForm(() => mode === 'reject' ? Promise.reject(failure) : Promise.resolve());
        });

        form.setValue('name', 'Ada');
        form.handleSubmit({ preventDefault()
        {} } as unknown as Event);
        await flush();
        expect(form.submitError()).toBe(failure);

        mode = 'resolve';
        form.handleSubmit({ preventDefault()
        {} } as unknown as Event);
        // submitError is cleared synchronously before the new attempt runs.
        expect(form.submitError()).toBeNull();
        await flush();
        expect(form.submitError()).toBeNull();
        dispose();
    });
});

describe('createForm — reset', () =>
{
    it('restores values, errors, touched and submitError to their initial state', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({
                initial: { name: 'Ada', note: '' },
                validate: { name: required() }
            });
            form.setValue('name', '');
            form.setValue('note', 'edited');
            form.register('name').onBlur();
            form.setError('note', 'server error');

            expect(form.values()).toEqual({ name: '', note: 'edited' });
            expect(form.touched().name).toBe(true);

            form.reset();
            expect(form.values()).toEqual({ name: 'Ada', note: '' });
            expect(form.errors()).toEqual({ name: null, note: null });
            expect(form.touched()).toEqual({ name: false, note: false });
            expect(form.dirty()).toEqual({ name: false, note: false });
            expect(form.submitError()).toBeNull();
            expect(form.isValid()).toBe(true);
            dispose();
        });
    });
});

// --- helpers -------------------------------------------------------------

// Builds a one-field form with an async onSubmit driver, used by the lifecycle
// tests. Kept generic over the onSubmit body so each test controls timing.
function buildAsyncForm(onSubmit: () => Promise<void>): FormApi<{ name: string }>
{
    return createForm({
        initial: { name: '' },
        validate: { name: required() },
        onSubmit
    });
}
