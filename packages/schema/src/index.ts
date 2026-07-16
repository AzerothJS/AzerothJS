/**
 * MODULE: schema - THE validation package of AzerothJS, frontend and backend
 *
 * One home for every rule: the schema combinators whose TypeScript types are INFERRED from
 * the declaration (schema.ts), the single-argument field validators the browser form's
 * `validate` option consumes (validators.ts), and the phone/countries dataset (phone.ts,
 * countries.ts). One schema drives runtime validation at the server boundary, the static
 * types on both sides of the wire, and the rules the browser form runs - `@azerothjs/form`
 * keeps the form STATE machinery and imports its rules from here. Failures collect into the
 * flat field-path map the form's setError and the HTTP layer's ValidationError already speak.
 *
 * See ./schema.ts for the combinators and the design rationale.
 */

export {
    string, number, boolean, literal, enumOf, array, object, record, union,
    SchemaError
} from './schema.ts';
export type {
    Schema, Infer, ShapeType, Refinement, FieldValidator, FieldErrors, ParseResult,
    Issue, ParseOptions, RuleOverrides, RefineOptions, StringOptions, NumberOptions
} from './schema.ts';

export {
    required, minLength, maxLength, min, max, pattern, email, url, oneOf, combine
} from './validators.ts';

export { phone } from './phone.ts';
export type { PhoneOptions } from './phone.ts';

export { countries, getCountry } from './countries.ts';
export type { CountryInfo } from './countries.ts';
