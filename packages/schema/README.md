<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />

# @azerothjs/schema

**AzerothJS validation schema core - zero-dependency validators that infer their TypeScript types**

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fschema?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/schema)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

</div>

---

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework. One home for every validation rule, frontend and backend: schema combinators plus the single-argument field validators (`required`, `email`, `minLength`, `phone`, ...) the browser form consumes. `azerothjs` keeps the form *state* machinery and imports its rules from here.

- Declare a schema once and get all three from one source: runtime validation, the inferred static type (`Infer<typeof schema>`), and stable error codes clients switch on.
- Combinators (`object`, `string`, `number`, `array`, `union`, ...) and single-argument field validators (`required`, `email`, `phone`, ...) share one rule set, so the browser form and the server boundary agree by construction.
- Failures collect into a flat field-path map (`{ 'items.0.email': '...' }`) that drops straight into a form's `setError` or an HTTP 422 body.
- ESM-only, Node >= 22, no dependencies.

---

## 📦 Install

```sh
npm install @azerothjs/schema
```

---

## 🚀 Quickstart

```ts
import { object, string, number, type Infer } from '@azerothjs/schema';

const User = object({
    name: string({ trim: true, min: 2 }),
    age: number({ int: true, min: 0 })
});

type User = Infer<typeof User>; // { name: string; age: number }

const result = User.safeParse({ name: '  Ada ', age: 36 });
if (result.ok)
{
    result.value; // { name: 'Ada', age: 36 } - normalized (name trimmed)
}
else
{
    result.errors; // flat field-path -> message map, ready for setError
}
```

---

## 📖 Overview

One declaration drives runtime validation, the compile-time type, and the error codes your
clients switch on - no interface written twice, no JSON Schema in a JavaScript costume, no
codegen, and no second hand-rolled validation layer for "real" DTOs:

```ts
import { object, string, number, type Infer } from '@azerothjs/schema';

// Map the built-in rule names onto YOUR application's stable error enum, once.
const CODES = { required: 'NOT_EMPTY', type: 'INVALID_STRING', min: 'MIN_LENGTH', max: 'MAX_LENGTH', format: 'INVALID_EMAIL' };

const createAccount = object({
    firstName: string({ trim: true, nonempty: true, min: 2, max: 100, pattern: /^[a-zA-Z\s\-']+$/, codes: CODES }),
    email: string({ trim: true, lowercase: true, format: 'email', max: 255, codes: CODES })
        .refine((value) => isDisposable(value) ? 'Disposable email addresses are not allowed' : null,
            { code: 'DISPOSABLE_EMAIL' }),
    age: number({ int: true, min: 13 })
});

type CreateAccount = Infer<typeof createAccount>;
// { firstName: string; email: string; age: number }

const result = createAccount.safeParse(input);            // collect every failure
const first = createAccount.safeParse(input, { mode: 'first' }); // or stop at the first
// failure: { ok: false,
//            errors: { email: 'Must be a valid email address', ... },     // setError-ready
//            issues: [{ path: 'email', code: 'INVALID_EMAIL', message: '...' }, ...] }
```

> [!NOTE]
> The parsed value is the **normalized** one - `trim`/`lowercase` run first and their result is
> what your handler receives.

---

## 🏗️ The deliberate shapes

- **Errors are a flat field-path map** - `{ 'items.0.email': 'Enter a valid email' }`. This is
  the exact shape `azerothjs`'s form `setError` consumes and the HTTP layer's 422 carries: a
  server-side failure lands in the browser form untouched.
- **Every failure also carries a stable code.** Failures collect as ordered *issues*
  (`{ path, code, message }`); the flat map is derived from them. Codes default to the rule
  that failed (`required`, `min`, `format`, ...) and every node takes `codes` / `messages`
  override maps - your application speaks its own error enum without a translation layer.
  Clients switch on codes; messages are for humans.
- **`refine` takes a form validator.** `azerothjs`'s form `FieldValidator` is
  `(value) => string | null`; `refine` accepts that shape structurally, so
  `string().refine(email())` runs the SAME rule the browser form runs - one source of
  validation truth, zero import coupling. `refine(fn, { code, message })` names the issue.
- **Coercion is explicit.** `number({ coerce: true })` opts into string conversion where the
  transport is stringly (query strings, form posts) - a JSON body sending `"42"` for a number
  is a client bug worth its 422.

`object()` **strips unknown keys**, so a mass-assignment payload dies at the boundary. String
checks run in a stable, documented order: required, type, normalization, `nonempty`, `min`,
`max`, `pattern`, `format`, then refinements.

---

## 🌐 One call at the HTTP boundary

`@azerothjs/http`'s `readValidated(request, schema)` reads the JSON body (Content-Type and
size limits enforced) and validates it in one call - a failure is the standard 422 whose
`details.fields` feeds the form and whose `details.issues` carry your codes:

```ts
app.post('/accounts', async (request) =>
{
    const input = await readValidated(request, createAccount, { mode: 'first' });
    // input: CreateAccount - typed, normalized, validated
});
```

---

## 🧠 One schema, three boundaries

The same declaration validates in the browser form (`createForm({ schema })`), in the api
client before the request leaves, and at the server boundary - one source of truth, three
enforcement points, identical failures:

```ts
const form = createForm({ initial: { name: '', email: '', age: 0 }, schema: createAccount }); // (a) browser
const client = createClient(contract, { baseUrl: '/api' });                                    // (b) pre-wire
app.post('/accounts', async (request) => json(await readValidated(request, createAccount)));   // (c) server
```

---

## 🗓️ Dates on the wire - `date()`

JSON cannot carry a Date, so `date()` IS the codec: the wire shape is the ISO 8601 string
`JSON.stringify` already produces, parsing turns it back into a Date instance, and a Date
instance passes through untouched. The gate is the same ISO rule as
`string({ format: 'datetime' })` - `Date.parse` alone is too lenient to trust.

```ts
const event = object({ title: string(), at: date({ min: new Date() }) });
event.parse({ title: 'launch', at: '2026-08-07T12:30:00Z' }).at.getUTCHours(); // 12
```

Server handlers store and return real Dates; the OpenAPI document says
`{ type: 'string', format: 'date-time' }`; the typed client's return types say `string`
(`Wire<T>`) because the manifest carries no schemas to revive them with.

## 🧩 Combinators and validators

Combinators: `string` `number` `boolean` `literal` `enumOf` `array` `object` `record` `union`,
each with `.optional()` and `.refine()`. String formats: `email`, `url`, `uuid`, `datetime`.

Field validators (the `(value) => message | null` shape, composable with `combine()`):
`required` `minLength` `maxLength` `min` `max` `pattern` `email` `url` `oneOf` `phone` - plus
the `countries` dataset (and `getCountry`) behind `phone`. The `email()` validator and
`string({ format: 'email' })` share one rule.

---

## 🔗 Related

- [AzerothJS monorepo](../../README.md) - the full framework, guides, and the language reference.
- [`azerothjs`](https://www.npmjs.com/package/azerothjs) - the frontend framework; its `createForm` consumes these validators.
- [`@azerothjs/http`](https://www.npmjs.com/package/@azerothjs/http) - `readValidated(request, schema)` validates request bodies at the server boundary.

---

<div align="center">
<sub>Part of <a href="../../README.md">AzerothJS</a> · <a href="https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE">MIT License</a></sub>
</div>
