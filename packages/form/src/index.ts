// ============================================================================
// AZEROTHJS — Forms Public API
// ============================================================================
//
// EXPORTED (public):
//   createForm()  — Reactive form: values, errors, touched, dirty,
//                   submitting, submitError, plus DOM-friendly
//                   register() helpers.
//
//   Validator factories — drop-in helpers for the `validate` map:
//     required, minLength, maxLength, min, max,
//     pattern, email, url, oneOf, combine, phone
//
//   Country dataset — for phone validation and UI dropdowns:
//     countries, getCountry, CountryInfo
//
// HOW IT FITS:
//
//   `createForm(config)` builds a reactive form whose state is
//   exposed as standard signal getters. Use `form.register(name)`
//   to spread props onto an `<input>`; use `form.handleSubmit`
//   straight on `<form onSubmit>`. Everything is signals + memos
//   underneath — same composition story as the rest of AzerothJS.
//
//   Validators compose via `combine(required(), email(), ...)`.
//   Every validator except `required` silently passes on empty
//   values, so `combine` produces sensible errors regardless of
//   ordering.
//
// NOT IN v1:
//   - Async validators (compose with createResource for now)
//   - Checkbox / radio / select register variants (use setValue)
//   - Field-array helpers (compose manually with For)
//   - Cross-field validation (use a top-level validateForm later)
//
// ============================================================================

export { createForm } from './create-form.ts';
export type {
    FormConfig,
    FormApi,
    FieldValidator,
    RegisteredFieldProps
} from './create-form.ts';

export {
    required,
    minLength,
    maxLength,
    min,
    max,
    pattern,
    email,
    url,
    oneOf,
    combine
} from './validators.ts';

export { phone } from './phone.ts';
export type { PhoneOptions } from './phone.ts';

export { countries, getCountry } from './countries.ts';
export type { CountryInfo } from './countries.ts';
