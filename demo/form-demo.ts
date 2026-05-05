// ============================================================================
// AZEROTHJS — Form Demo
// ============================================================================
//
// Self-contained demonstration of @azerothjs/form. Exercises:
//   - createForm with built-in validators composed via combine()
//   - required(), minLength(), email(), phone() — the standard library
//   - countries dataset for populating a <select> dropdown
//   - register(name) for ergonomic <input> wiring
//   - touched-gated error display (errors only after blur)
//   - submitting() / submitError() lifecycle on a fake async save
//   - reset() returning the form to a clean slate
//
// The fake save resolves after 600 ms and rejects ~30 % of the
// time so visitors can see both success and failure paths
// without rebuilding.
//
// ============================================================================

import {
    defineComponent,
    h,
    createSignal,
    createMemo,
    createForm,
    required,
    minLength,
    email,
    phone,
    combine,
    countries,
    type CountryInfo
} from '@azerothjs/core';

// ── Fake async save ──────────────────────────────────────────

/**
 * Simulates an API call. 600 ms delay; rejects ~30 % of the time
 * with a realistic-looking error message.
 */
function saveFeedback(payload: { name: string; email: string; phoneNumber: string }): Promise<void>
{
    return new Promise<void>((resolve, reject) =>
    {
        setTimeout(() =>
        {
            // Deterministic-ish "random" so demos aren't TOO chaotic:
            // about 1 in 3 attempts fails.
            if (Math.random() < 0.3)
            {
                reject(new Error(`Server rejected (${ payload.email })`));
            }
            else
            {
                resolve();
            }
        }, 600);
    });
}

// ── Country picker — sortable, filterable subset ─────────────
//
// Three preset modes for the demo:
//   - 'all'     : every country in the dataset
//   - 'us-eu'   : just US/UK/EU
//   - 'mena'    : Middle-East / North-Africa region
//
// In production code you'd usually pass a static array of ISO
// codes; here we let the user toggle between presets to see the
// validator's behaviour change live.

type CountryPreset = 'all' | 'us-eu' | 'mena';

const PRESET_LABELS: Record<CountryPreset, string> = {
    'all': 'All countries',
    'us-eu': 'US + UK + Western Europe',
    'mena': 'Middle East + North Africa'
};

const PRESET_CODES: Record<CountryPreset, readonly string[]> = {
    'all': [],
    'us-eu': ['US', 'GB', 'IE', 'FR', 'DE', 'ES', 'IT', 'NL', 'BE', 'CH', 'AT', 'PT', 'SE', 'NO', 'DK', 'FI'],
    'mena': ['IR', 'IQ', 'SA', 'AE', 'EG', 'MA', 'TN', 'DZ', 'LY', 'JO', 'LB', 'SY', 'YE', 'OM', 'QA', 'BH', 'KW']
};

/** Sorts the supplied codes into a CountryInfo[] for `<option>` rendering. */
function resolveCountries(preset: CountryPreset): CountryInfo[]
{
    if (preset === 'all') return countries;
    const filter = new Set(PRESET_CODES[preset]);
    return countries.filter(c => filter.has(c.code));
}

// ── Component ────────────────────────────────────────────────

export const FormDemo = defineComponent(() =>
{
    // Local counter — bumps on every successful save. Demonstrates
    // that onSubmit's success path observably mutates UI.
    const [savedCount, setSavedCount] = createSignal(0);
    const [lastSaved, setLastSaved] = createSignal<{ name: string; email: string; phoneNumber: string } | null>(null);

    // Country preset for the phone validator. Stored as a signal
    // so the phone validator can react to it via a getter.
    const [preset, setPreset] = createSignal<CountryPreset>('all');

    // Memo: resolved CountryInfo[] for the current preset. Used
    // both for the <select> dropdown population and for showing
    // the country count in the helper text.
    const presetCountries = createMemo(() => resolveCountries(preset()));

    const form = createForm({
        initial: { name: '', email: '', phoneNumber: '' },
        // Built-in validators composed via combine(). required()
        // gates first so the user gets the obvious "required"
        // message on empty input; subsequent validators only fire
        // once the field has a value.
        validate: {
            name: combine(
                required('Name is required'),
                minLength(2, 'Name must be at least 2 characters')
            ),
            email: combine(
                required('Email is required'),
                email('Must look like an email address')
            ),
            phoneNumber: (value) =>
            {
                // The phone validator's `countries` list is captured
                // at call time, so we re-build the validator inside
                // this wrapper to follow the preset signal. Empty
                // preset means "all" → omit the option entirely.
                const codes = preset() === 'all'
                    ? undefined
                    : Array.from(PRESET_CODES[preset()]);
                return combine(
                    required('Phone is required'),
                    phone({ countries: codes })
                )(value);
            }
        },
        onSubmit: async (values) =>
        {
            await saveFeedback(values);
            // Only reaches here on success — increment counter
            // and remember what we sent so the UI can echo it.
            setSavedCount(n => n + 1);
            setLastSaved({ ...values });
            // Clear the form for the next entry. reset() restores
            // values, errors, and touched to their initial state.
            form.reset();
        }
    });

    /** A reactive error <p> that only renders text after the field is touched. */
    function fieldError(field: 'name' | 'email' | 'phoneNumber'): HTMLElement
    {
        return h('p', { class: 'form-demo-error' }, () =>
        {
            const isTouched = form.touched()[field];
            const message = form.errors()[field];
            return isTouched && message ? message : '';
        });
    }

    return h('div', { class: 'glass' },
        // Feature tag chips — match the visual pattern of every
        // other demo card. Each tag names a public API exercised
        // by this demo.
        h('div', { class: 'feature-tags' },
            ...['createForm', 'register', 'handleSubmit', 'submitting',
                'submitError', 'reset', 'required', 'minLength', 'email',
                'phone', 'countries', 'combine']
                .map(tag => h('span', { class: 'feature-tag' }, tag))
        ),
        h('h2', {}, '📝 Form — Validation, Submit, Errors'),

        h('form',
            {
                class: 'form-demo',
                // novalidate disables the browser's built-in popup
                // validation — we render our own messages and want
                // submit attempts to flow through `handleSubmit`.
                novalidate: true,
                // autocomplete="off" prevents Chrome's autofill from
                // firing phantom focus/blur events on the fields a
                // few seconds after page load. Without this, the
                // synthetic blur marks every field as touched and
                // the "required" errors appear without any user
                // interaction. (Demo-only — real apps usually want
                // autofill enabled and gate errors differently.)
                autocomplete: 'off',
                onSubmit: form.handleSubmit
            },

            // ── Name field ────────────────────────────────────
            h('label', { class: 'form-demo-row' },
                h('span', { class: 'form-demo-label' }, 'Name'),
                h('input',
                    {
                        ...form.register('name'),
                        type: 'text',
                        // Per-field autocomplete is required because
                        // Chrome ignores form-level "off" for known
                        // field types like email/tel.
                        autocomplete: 'off',
                        placeholder: 'Ada Lovelace'
                    }
                ),
                fieldError('name')
            ),

            // ── Email field ───────────────────────────────────
            h('label', { class: 'form-demo-row' },
                h('span', { class: 'form-demo-label' }, 'Email'),
                h('input',
                    {
                        ...form.register('email'),
                        type: 'email',
                        autocomplete: 'off',
                        placeholder: 'ada@example.com'
                    }
                ),
                fieldError('email')
            ),

            // ── Country preset selector ───────────────────────
            //
            // Drives the phone validator's `countries:` option.
            // Switching the preset changes which calling-code
            // prefixes are accepted by `phone()` — try entering
            // a +98 number, then flip to "US + UK + Western
            // Europe" and submit to see the country filter reject
            // it.
            h('label', { class: 'form-demo-row' },
                h('span', { class: 'form-demo-label' }, 'Phone — accept countries from'),
                h('select',
                    {
                        class: 'form-demo-select',
                        value: () => preset(),
                        onChange: (e: Event) =>
                        {
                            const next = (e.target as HTMLSelectElement).value as CountryPreset;
                            setPreset(next);
                        }
                    },
                    ...(['all', 'us-eu', 'mena'] as const).map(key =>
                        h('option', { value: key }, PRESET_LABELS[key])
                    )
                ),
                h('p', { class: 'form-demo-hint' }, () =>
                {
                    const list = presetCountries();
                    if (preset() === 'all')
                    {
                        return `${ list.length } countries — any valid E.164 number passes`;
                    }
                    return `${ list.length } countries: ${
                        list.slice(0, 6).map(c => c.code).join(', ')
                    }${ list.length > 6 ? '…' : '' }`;
                })
            ),

            // ── Phone field ───────────────────────────────────
            h('label', { class: 'form-demo-row' },
                h('span', { class: 'form-demo-label' }, 'Phone'),
                h('input',
                    {
                        ...form.register('phoneNumber'),
                        type: 'tel',
                        autocomplete: 'off',
                        placeholder: '+1 (415) 555-1234'
                    }
                ),
                fieldError('phoneNumber')
            ),

            // ── Action row ────────────────────────────────────
            h('div', { class: 'form-demo-actions' },
                h('button',
                    {
                        type: 'submit',
                        class: 'btn-primary',
                        disabled: () => form.submitting() || !form.isValid()
                    },
                    () => form.submitting() ? 'Saving…' : 'Save'
                ),
                h('button',
                    {
                        type: 'button',
                        class: 'btn-ghost',
                        onClick: () => form.reset(),
                        disabled: () => form.submitting()
                    },
                    'Reset'
                )
            ),

            // ── Submit-error banner ───────────────────────────
            h('div', { class: 'form-demo-status' }, () =>
            {
                const err = form.submitError();
                if (err)
                {
                    const span = document.createElement('span');
                    span.className = 'form-demo-status-error';
                    span.textContent = `❌ ${ err instanceof Error ? err.message : String(err) }`;
                    return span;
                }

                const last = lastSaved();
                if (last)
                {
                    const span = document.createElement('span');
                    span.className = 'form-demo-status-ok';
                    span.textContent = `✓ Saved ${ last.name } (${ last.email } · ${ last.phoneNumber }) — total: ${ savedCount() }`;
                    return span;
                }

                const span = document.createElement('span');
                span.className = 'form-demo-status-idle';
                span.textContent = 'Fill in the form and click Save. ~30% of submissions will fail to demonstrate the error path.';
                return span;
            })
        ) // ← closes the inner <form>
    );
});
