<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/form

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fform?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/form)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework. Applications usually install [`azerothjs`](https://www.npmjs.com/package/azerothjs); depend on this package directly for a narrower surface.

## Overview

Reactive forms: per-field value and error state, synchronous / cross-field / async validation,
numeric coercion, a submit lifecycle, and dynamic field arrays - all exposed as signals, so reading
a field's value or error inside markup subscribes only to that field.

This package owns the form **state**; the validation **rules** live in
[`@azerothjs/schema`](https://github.com/AzerothJS/AzerothJS/tree/main/packages/schema) - THE
validation package - and are re-exported here (`required`, `email`, `minLength`, `phone`, ...).
A field rule can also be a schema node, and `createForm({ schema })` runs one whole-object
schema - the same declaration the api client and the server boundary enforce.

In a `.azeroth` component the idiomatic way to use this package is the **`form` keyword**, which
lowers to `createForm` and pairs with `bind:value` / `bind:checked` for two-way input binding:

```azeroth
import { required, email, minLength, combine } from 'azerothjs';

export default component SignIn
{
    form login = { email: '', password: '' } with {
        validate: {
            email: combine(required('Email is required'), email('Enter a valid email')),
            password: combine(required('Password is required'), minLength(8))
        },
        onSubmit: async (values) => { await signIn(values); }
    };

    <form onSubmit={login.handleSubmit}>
        <input type="email" bind:value={login.email} />
        <Show when={login.touched().email}><span>{login.errors().email}</span></Show>
        <input type="password" bind:value={login.password} />
        <button disabled={login.submitting()}>{login.submitting() ? 'Signing in...' : 'Sign in'}</button>
    </form>
}
```

The same engine is available as a plain runtime API for `.ts` code:

```ts
import { createForm, required, email, minLength, combine } from '@azerothjs/form';

const form = createForm({
    initial: { email: '', password: '' },
    validate: { email: combine(required(), email()), password: required() },
    onSubmit: (values) => console.log(values)
});
```

## Install

```sh
npm install @azerothjs/form
```

(Or just `npm install azerothjs`, which re-exports everything here.)

## Validation layers

Three layers, each with its own job; a per-field error always wins over a cross-field one:

- **`validate`** - sync, per-field: `{ [field]: (value) => string | null }`. Built-in validators
  compose with `combine`: `required`, `minLength`, `maxLength`, `min`, `max`, `pattern`, `email`,
  `url`, `oneOf`, `phone`. Every validator except `required` passes on empty values, so
  `combine(required(), email())` reports sensible errors regardless of order.
- **`validateForm`** - sync, cross-field: `(values) => partial field -> error map`. Password
  confirmation, `end >= start`, and anything else that needs the whole typed snapshot.
- **`validateAsync`** - per-field async checks (username availability, server-side rules):
  `{ [field]: (value, signal: AbortSignal) => Promise<string | null> }`. Runs after the field's
  sync validators pass, debounced (`asyncDebounceMs`, default 300), with an `AbortSignal` that
  cancels superseded requests. `validating()` reports in-flight fields; every pending check is
  awaited before submit.

```ts
const signup = createForm({
    initial: { username: '', password: '', confirm: '' },
    validate: { password: combine(required(), minLength(8)) },
    validateForm: (v) => ({ confirm: v.confirm !== v.password ? 'Passwords must match' : null }),
    validateAsync: {
        username: async (value, signal) => {
            const res = await fetch(`/api/username-available?u=${value}`, { signal });
            return (await res.json()).available ? null : 'That username is taken';
        }
    },
    onSubmit: async (values) => { await register(values); }
});
```

Server errors go on a field with `setError(field, message)`.

## Numeric fields

A field whose initial value is a number stays a `number` end to end: `setValue` (and therefore
`bind:value`) coerces the input's string on the way in, so `values().age` and `onSubmit` see `25`,
not `"25"`. `Number('')` is the empty default, `0`.

## Field arrays

A dynamic list of repeated sub-forms (invoice line items, team members) is `createFieldArray` -
one `createForm` per row with per-row disposal, plus `append` / `remove` / `move` and aggregated
`values()` / `isValid()` / `error()`. In `.azeroth` it is the `form NAME[]` keyword:

```azeroth
form items[] = { description: '', qty: 1 } with {
    validate: { description: required(), qty: min(1) },
    validateArray: (rows) => rows.length === 0 ? 'Add at least one item' : null
};

<For each={items.rows()} key={(item) => item.key}>
    {(item, i) =>
        <fieldset>
            <input bind:value={item.description} />
            <input type="number" bind:value={item.qty} />
            <button type="button" onClick={() => items.remove(i())}>Remove</button>
        </fieldset>
    }
</For>
```

`with { initial: [...] }` seeds starting rows; the `= { ... }` shape is the blank a new row gets.

## API summary

| Export | Role |
| --- | --- |
| `createForm(config)` | `FormApi`: `values()` `errors()` `touched()` `submitting()` `validating()` `isValidating()` `handleSubmit` `setValue` `setError` `reset` ... |
| `createFieldArray(config)` | `FieldArrayApi`: `rows()` `append` `remove` `move` `values()` `isValid()` `error()` `validateAll` `reset` |
| validators | `required` `minLength` `maxLength` `min` `max` `pattern` `email` `url` `oneOf` `combine` `phone` |
| data | `countries`, `getCountry` |
| types | `FormConfig` `FormApi` `FieldValidator` `AsyncFieldValidator` `FieldArrayConfig` `FieldArrayApi` `FieldArrayRow` ... |

`FieldValidator<V>` is deliberately single-argument - `(value) => string | null` - so simple
wrappers like `(v) => required(t('errors.required'))(v)` stay trivial; whole-snapshot rules belong
in `validateForm`.

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
