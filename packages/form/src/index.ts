// Public API for the forms package.
//
// createForm(config) builds a reactive form whose state is exposed as standard
// signal getters. Use form.register(name) to spread props onto an <input>, and
// form.handleSubmit straight on <form onSubmit>. State is signals and memos
// underneath - the same composition story as the rest of AzerothJS.
//
// Validators compose via combine(required(), email(), ...). Every validator
// except required silently passes on empty values, so combine produces sensible
// errors regardless of ordering.
//
// Not in v1: async validators (compose with createResource for now), checkbox /
// radio / select register variants (use setValue), field-array helpers (compose
// manually with For), and cross-field validation (a top-level validateForm).

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
