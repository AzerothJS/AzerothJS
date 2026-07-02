/**
 * MODULE: @azerothjs/form - public API
 *
 * createForm(config) builds a reactive form whose state is exposed as standard signal getters; use
 * form.register(name) to spread props onto an <input> and form.handleSubmit straight on
 * <form onSubmit>. State is signals and memos underneath - the same composition story as the rest of
 * AzerothJS, so errors flow to <ErrorBoundary> and submitting() into <Suspense>.
 *
 * Validators compose via combine(required(), email(), ...). Every validator EXCEPT required() silently
 * passes on empty values, so combine() produces sensible errors regardless of ordering. phone() plus
 * the countries dataset/getCountry cover international phone input without a libphonenumber dependency.
 *
 * Cross-field rules go in a top-level validateForm (the whole typed snapshot -> a partial error map);
 * per-field server checks go in validateAsync (debounced, AbortSignal-cancelled, awaited on submit). A
 * dynamic list of repeated sub-forms is createFieldArray (one createForm per row + add/remove/reorder). NOT
 * IN V1: checkbox/radio/select register variants (use setValue). Every symbol below is documented at its
 * definition.
 */

export { createForm } from './create-form.ts';
export type {
    FormConfig,
    FormApi,
    FieldValidator,
    AsyncFieldValidator,
    RegisteredFieldProps
} from './create-form.ts';

export { createFieldArray } from './field-array.ts';
export type {
    FieldArrayConfig,
    FieldArrayApi,
    FieldArrayRow
} from './field-array.ts';

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
