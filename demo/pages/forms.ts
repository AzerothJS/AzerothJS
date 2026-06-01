// ============================================================================
// AZEROTHJS DEMO — Forms Page
// ============================================================================
//
// Reactive forms with createForm: per-field validation, touched
// tracking, async submit with loading + error, and the phone
// validator's national-format support.
//
// ============================================================================

import {
    h,
    Show,
    createSignal,
    createForm,
    combine,
    required,
    minLength,
    email,
    phone,
    defineComponent,
    type FormApi
} from '@azerothjs/core';
import { DemoCard, PageHeader, Callout } from '../ui.ts';

// A `type` (not `interface`) so it satisfies createForm's
// `Record<string, unknown>` constraint — type aliases get an
// implicit index signature for that assignability; interfaces don't.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type SignupValues = {
    name: string;
    email: string;
    phone: string;
};

type SignupForm = FormApi<SignupValues>;
type SignupField = keyof SignupValues;

/** Renders a labelled input wired to a form field, with its error
 *  shown only once the field has been touched. */
function Field(
    form: SignupForm,
    name: SignupField,
    label: string,
    placeholder: string
): HTMLElement
{
    return h('div', { class: 'field' },
        h('label', { class: 'field-label' }, label),
        h('input', {
            class: 'text-input',
            type: 'text',
            placeholder,
            ...form.register(name)
        }),
        Show({
            when: () => form.touched()[name] && form.errors()[name] !== null,
            children: () => h('p', { class: 'field-error' }, () => form.errors()[name] ?? '')
        }));
}

const SignupDemo = defineComponent(() =>
{
    const [done, setDone] = createSignal(false);

    const form: SignupForm = createForm<SignupValues>({
        initial: { name: '', email: '', phone: '' },
        validate: {
            name: combine(required(), minLength(2)),
            email: combine(required(), email()),
            // National format accepted: '09170459330' validates the
            // same as '+989170459330'.
            phone: combine(required(), phone({ defaultCountry: 'IR' }))
        },
        onSubmit: async (values) =>
        {
            // Simulate a server round-trip.
            await new Promise<void>(resolve => setTimeout(resolve, 700));

            // Demo server-side validation: reject a reserved email.
            if (values.email.toLowerCase() === 'taken@example.com')
            {
                form.setError('email', 'That email is already registered');
                throw new Error('email taken');
            }

            setDone(true);
        }
    });

    return DemoCard(
        {
            title: 'Sign-up Form',
            description: 'createForm gives reactive values, errors, touched, and a submit lifecycle. The phone field accepts national OR E.164 format.',
            tags: ['createForm', 'validators', 'phone']
        },
        h('form', { onSubmit: form.handleSubmit, class: 'signup-form' },
            Field(form, 'name', 'Name', 'Ada Lovelace'),
            Field(form, 'email', 'Email', 'you@example.com (try taken@example.com)'),
            Field(form, 'phone', 'Phone (IR)', '09170459330 or +989170459330'),
            h('button', {
                class: 'btn btn-primary btn-block',
                type: 'submit',
                disabled: () => form.submitting()
            }, () => form.submitting() ? 'Submitting…' : 'Create account'),
            Show({
                when: () => form.submitError() !== null,
                children: () => h('p', { class: 'field-error' }, () => `Submit failed: ${ String(form.submitError()) }`)
            }),
            Show({
                when: done,
                children: () => h('p', { class: 'form-success' }, '✅ Account created!')
            })
        ),
        h('button', {
            class: 'btn btn-ghost',
            type: 'button',
            onClick: () =>
            {
                setDone(false);
                form.reset();
            }
        }, 'Reset')
    );
});

/** The Forms route page. */
export const FormsPage = defineComponent(() =>
    h('div', { class: 'page' },
        PageHeader('Forms', 'Reactive validation, touched-state, and an async submit lifecycle — no form library required.'),
        Callout('tip', 'The phone field accepts both 09170459330 and +989170459330. Errors appear only after you blur a field; submitting touches them all.'),
        SignupDemo({})
    ));
