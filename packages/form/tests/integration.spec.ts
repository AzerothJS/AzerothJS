// @vitest-environment happy-dom
//
// Realistic end-to-end exercise of @azerothjs/form. Two angles:
//   1) A composed-validator form driving reactive errors/isValid through a full
//      submit lifecycle (async onSubmit), reading state like any consumer would.
//   2) register() + handleSubmit() wired onto REAL <input>/<form> elements in
//      happy-dom, firing genuine input/blur/submit events and asserting that the
//      DOM, the form state, and onSubmit all stay in lockstep.
// No mocks: real signals, real effects, real DOM nodes via the renderer.
import { describe, it, expect, vi } from 'vitest';
import { createRoot } from '@azerothjs/reactivity';
import { h, render } from '@azerothjs/renderer';
import { createForm, combine, required, minLength, email } from '@azerothjs/form';
import type { FormApi } from '@azerothjs/form';

function flush(): Promise<void>
{
    return new Promise(resolve => setTimeout(resolve, 0));
}

describe('integration - composed validators driving reactive state through submit', () =>
{
    it('walks a sign-up form from invalid to valid and through an async submit', async () =>
    {
        const saved: Array<{ name: string; email: string }> = [];
        let resolveSave!: () => void;
        let form!: ReturnType<typeof buildSignup>;
        let dispose!: () => void;

        function buildSignup(): FormApi<{ name: string; email: string }>
        {
            return createForm({
                initial: { name: '', email: '' },
                validate: {
                    name: combine(required(), minLength(2)),
                    email: combine(required(), email())
                },
                onSubmit: (values) =>
                {
                    return new Promise<void>((resolve) =>
                    {
                        resolveSave = () =>
                        {
                            saved.push(values);
                            resolve();
                        };
                    });
                }
            });
        }

        createRoot((d) =>
        {
            dispose = d;
            form = buildSignup();
        });

        // Initial: both required errors live, form invalid.
        expect(form.errors().name).toBe('This field is required');
        expect(form.errors().email).toBe('This field is required');
        expect(form.isValid()).toBe(false);

        // Partial / wrong input surfaces the format error in order.
        form.setValue('name', 'A'); // too short
        form.setValue('email', 'nope'); // bad format
        expect(form.errors().name).toBe('Must be at least 2 characters');
        expect(form.errors().email).toBe('Invalid email address');
        expect(form.isValid()).toBe(false);

        // A submit attempt while invalid is blocked and marks everything touched.
        form.handleSubmit({ preventDefault()
        {} } as unknown as Event);
        expect(form.touched()).toEqual({ name: true, email: true });
        expect(saved).toEqual([]);

        // Fix both fields -> valid.
        form.setValue('name', 'Ada');
        form.setValue('email', 'ada@example.com');
        expect(form.isValid()).toBe(true);

        // Submit -> onSubmit runs, submitting() true until the promise settles.
        form.handleSubmit({ preventDefault()
        {} } as unknown as Event);
        expect(form.submitting()).toBe(true);
        expect(saved).toEqual([]);

        resolveSave();
        await flush();
        expect(form.submitting()).toBe(false);
        expect(form.submitError()).toBeNull();
        expect(saved).toEqual([{ name: 'Ada', email: 'ada@example.com' }]);

        dispose();
    });

    it('routes a rejected submit into submitError while leaving values intact', async () =>
    {
        const failure = new Error('email already registered');
        let form!: ReturnType<typeof build>;
        let dispose!: () => void;

        function build(): FormApi<{ email: string }>
        {
            return createForm({
                initial: { email: '' },
                validate: { email: combine(required(), email()) },
                onSubmit: () => Promise.reject(failure)
            });
        }

        createRoot((d) =>
        {
            dispose = d;
            form = build();
        });

        form.setValue('email', 'taken@example.com');
        form.handleSubmit({ preventDefault()
        {} } as unknown as Event);
        expect(form.submitting()).toBe(true);

        await flush();
        expect(form.submitting()).toBe(false);
        expect(form.submitError()).toBe(failure);
        // Values survive a failed submit so the user can retry.
        expect(form.values()).toEqual({ email: 'taken@example.com' });

        dispose();
    });
});

describe('integration - register() + handleSubmit on real DOM elements', () =>
{
    it('binds input value, syncs on input, marks touched on blur, and submits via the form', async () =>
    {
        const container = document.createElement('div');
        document.body.appendChild(container);

        const onSubmit = vi.fn();
        let form!: ReturnType<typeof build>;

        function build(): FormApi<{ username: string }>
        {
            return createForm({
                initial: { username: '' },
                validate: { username: combine(required(), minLength(3)) },
                onSubmit
            });
        }

        // Build the form and render the DOM tree inside one root so both the
        // form's validation effect and the input's value binding share an owner.
        createRoot(() =>
        {
            form = build();
            render(() =>
                h('form', { onSubmit: form.handleSubmit },
                    h('input', form.register('username')),
                    h('button', { type: 'submit' }, 'Go')),
            container);
        });

        const input = container.querySelector('input') as HTMLInputElement;
        const formEl = container.querySelector('form') as HTMLFormElement;

        // The registered value getter bound the initial value.
        expect(input.value).toBe('');
        expect(form.touched().username).toBe(false);

        // Type into the input -> onInput reads target.value -> form state updates.
        input.value = 'ab';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(form.values().username).toBe('ab');
        // Live validation: still too short.
        expect(form.errors().username).toBe('Must be at least 3 characters');

        // Blur marks the field touched.
        input.dispatchEvent(new Event('blur'));
        expect(form.touched().username).toBe(true);

        // Submitting the still-invalid form is blocked.
        formEl.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        expect(onSubmit).not.toHaveBeenCalled();

        // Fix the value, then submit successfully.
        input.value = 'ada';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(form.isValid()).toBe(true);

        formEl.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ username: 'ada' });

        container.remove();
    });

    it('handleSubmit calls preventDefault on a real submit event', () =>
    {
        const container = document.createElement('div');
        document.body.appendChild(container);

        let form!: ReturnType<typeof build>;

        function build(): FormApi<{ x: string }>
        {
            return createForm({ initial: { x: 'ok' } });
        }

        createRoot(() =>
        {
            form = build();
            render(() =>
                h('form', { onSubmit: form.handleSubmit },
                    h('input', form.register('x'))),
            container);
        });

        const formEl = container.querySelector('form') as HTMLFormElement;
        const event = new Event('submit', { bubbles: true, cancelable: true });
        formEl.dispatchEvent(event);
        // handleSubmit calls event.preventDefault() -> the event is now cancelled.
        expect(event.defaultPrevented).toBe(true);

        container.remove();
    });

    it('keeps the bound input value in sync when the form is updated programmatically', () =>
    {
        const container = document.createElement('div');
        document.body.appendChild(container);

        let form!: ReturnType<typeof build>;

        function build(): FormApi<{ city: string }>
        {
            return createForm({ initial: { city: 'Oslo' } });
        }

        createRoot(() =>
        {
            form = build();
            render(() => h('input', form.register('city')), container);
        });

        const input = container.querySelector('input') as HTMLInputElement;
        expect(input.value).toBe('Oslo');

        // A programmatic setValue flows back into the DOM via the value binding.
        form.setValue('city', 'Bergen');
        expect(input.value).toBe('Bergen');

        container.remove();
    });
});
