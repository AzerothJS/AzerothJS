import { describe, it, expect, vi } from 'vitest';
import { createRoot, createForm } from '@azerothjs/core';

// ── Helpers ──────────────────────────────────────────────────

/** A controlled deferred — lets tests step through async submit timing. */
function makeDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (err: unknown) => void;
    }
{
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) =>
    {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function flush(): Promise<void>
{
    for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** Builds an Input event whose `event.target.value` is the supplied string. */
function inputEvent(value: string): Event
{
    const input = document.createElement('input');
    input.value = value;
    const event = new Event('input', { bubbles: true });
    Object.defineProperty(event, 'target', { value: input });
    return event;
}

// ─────────────────────────────────────────────────────────────

describe('createForm', () =>
{
    it('returns a form whose values() matches the initial config', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({
                initial: { name: 'Ada', email: 'ada@example.com' }
            });

            expect(form.values()).toEqual({
                name: 'Ada',
                email: 'ada@example.com'
            });

            // Errors and touched start clean.
            expect(form.errors()).toEqual({ name: null, email: null });
            expect(form.touched()).toEqual({ name: false, email: false });
            expect(form.submitting()).toBe(false);
            expect(form.submitError()).toBeNull();

            dispose();
        });
    });

    it('updates values() when register(name).onInput fires', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({
                initial: { name: '', email: '' }
            });

            const fieldProps = form.register('name');
            expect(fieldProps.name).toBe('name');
            expect(fieldProps.value()).toBe('');

            fieldProps.onInput(inputEvent('Turing'));

            expect(fieldProps.value()).toBe('Turing');
            expect(form.values().name).toBe('Turing');
            expect(form.values().email).toBe(''); // other fields untouched

            dispose();
        });
    });

    it('runs validators on every change and populates errors()', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({
                initial: { email: '' },
                validate: {
                    email: v => v.includes('@') ? null : 'Invalid email'
                }
            });

            // Initial validation runs synchronously — empty string
            // doesn't include '@', so error is set immediately.
            expect(form.errors().email).toBe('Invalid email');
            expect(form.isValid()).toBe(false);

            form.setValue('email', 'ada@example.com');
            expect(form.errors().email).toBeNull();
            expect(form.isValid()).toBe(true);

            form.setValue('email', 'broken');
            expect(form.errors().email).toBe('Invalid email');
            expect(form.isValid()).toBe(false);

            dispose();
        });
    });

    it('handleSubmit calls onSubmit with current values and toggles submitting', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const deferred = makeDeferred<void>();
            const onSubmit = vi.fn(() => deferred.promise);

            const form = createForm({
                initial: { name: 'Ada' },
                onSubmit
            });

            const event = new Event('submit');
            Object.defineProperty(event, 'preventDefault', {
                value: vi.fn()
            });

            form.handleSubmit(event);

            expect((event.preventDefault as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
            expect(onSubmit).toHaveBeenCalledOnce();
            expect(onSubmit).toHaveBeenCalledWith({ name: 'Ada' });
            expect(form.submitting()).toBe(true);

            deferred.resolve();
            await flush();

            expect(form.submitting()).toBe(false);
            expect(form.submitError()).toBeNull();

            dispose();
        });
    });

    it('handleSubmit does NOT call onSubmit when validation fails', () =>
    {
        createRoot((dispose) =>
        {
            const onSubmit = vi.fn();
            const form = createForm({
                initial: { email: '' },
                validate: {
                    email: v => v.includes('@') ? null : 'Invalid'
                },
                onSubmit
            });

            const event = new Event('submit');
            Object.defineProperty(event, 'preventDefault', {
                value: vi.fn()
            });

            form.handleSubmit(event);

            expect(onSubmit).not.toHaveBeenCalled();
            expect(form.submitting()).toBe(false);

            // Submitting also marks all fields touched so errors
            // become visible to the user even before they blur.
            expect(form.touched().email).toBe(true);

            dispose();
        });
    });

    it('reset() returns values, errors, touched, and submitError to initial state', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({
                initial: { name: 'Ada', email: '' },
                validate: {
                    email: v => v.includes('@') ? null : 'Invalid'
                }
            });

            // Mutate everything.
            form.setValue('name', 'Turing');
            form.setValue('email', 'turing@example.com');
            form.register('name').onBlur();
            form.setError('name', 'Server says no');

            expect(form.values()).toEqual({
                name: 'Turing',
                email: 'turing@example.com'
            });
            expect(form.touched().name).toBe(true);
            expect(form.errors().name).toBe('Server says no');

            form.reset();

            expect(form.values()).toEqual({
                name: 'Ada',
                email: ''
            });
            expect(form.touched()).toEqual({ name: false, email: false });
            // After reset, errors are blanked unconditionally — the
            // form returns to a "no interaction yet" state. The
            // validator will run again on the next setValue (and
            // it'd flag the empty email then), but until then we
            // present a clean slate. This matches React Hook Form
            // and Solid Form conventions.
            expect(form.errors()).toEqual({ name: null, email: null });
            expect(form.submitError()).toBeNull();

            // Sanity-check the "validator runs again on next change"
            // half of the contract: typing an invalid value into
            // email should reinstate the error.
            form.setValue('email', 'still-bad');
            expect(form.errors().email).toBe('Invalid');

            dispose();
        });
    });

    it('captures onSubmit rejections in submitError() (Promise reject + sync throw)', async () =>
    {
        await createRoot(async (dispose) =>
        {
            const deferred = makeDeferred<void>();
            const form = createForm({
                initial: { name: 'Ada' },
                onSubmit: () => deferred.promise
            });

            const event = new Event('submit');
            Object.defineProperty(event, 'preventDefault', { value: vi.fn() });
            form.handleSubmit(event);
            expect(form.submitting()).toBe(true);

            const failure = new Error('server down');
            deferred.reject(failure);
            await flush();

            expect(form.submitting()).toBe(false);
            expect(form.submitError()).toBe(failure);

            dispose();
        });

        // Synchronous throw path — separate root so state is fresh.
        createRoot((dispose) =>
        {
            const failure = new Error('sync boom');
            const form = createForm({
                initial: { name: 'Ada' },
                onSubmit: () =>
                {
                    throw failure;
                }
            });

            const event = new Event('submit');
            Object.defineProperty(event, 'preventDefault', { value: vi.fn() });
            form.handleSubmit(event);

            expect(form.submitError()).toBe(failure);
            expect(form.submitting()).toBe(false);

            dispose();
        });
    });

    it('touched()[field] becomes true after register(name).onBlur fires', () =>
    {
        createRoot((dispose) =>
        {
            const form = createForm({
                initial: { name: '', email: '' }
            });

            expect(form.touched()).toEqual({ name: false, email: false });

            form.register('name').onBlur();
            expect(form.touched()).toEqual({ name: true, email: false });

            form.register('email').onBlur();
            expect(form.touched()).toEqual({ name: true, email: true });

            // Blurring an already-touched field is idempotent.
            form.register('name').onBlur();
            expect(form.touched()).toEqual({ name: true, email: true });

            dispose();
        });
    });
});
