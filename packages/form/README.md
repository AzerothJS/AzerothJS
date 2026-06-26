# @azerothjs/form

## Overview

Reactive forms: per-field value and error state, synchronous validation, and a
submit lifecycle, all exposed as signals. `createForm(config)` builds a form whose
state composes with the rest of AzerothJS the same way any other reactive state
does.

```ts
import { createForm, required, email, combine } from '@azerothjs/form';

const form = createForm({
    initial: { email: '', password: '' },
    validate: {
        email: combine(required(), email()),
        password: required()
    },
    onSubmit: values => console.log(values)
});
```

In markup, spread `form.register(name)` onto an input and attach
`form.handleSubmit` to the form's `onSubmit`.

## Architecture

Form state is built from signals and memos, so reading a field's value or error
inside markup subscribes only to that field. Validators are run on every value
change and on submit. Every validator except `required` passes on empty values,
so `combine(required(), email())` produces sensible errors regardless of order:
an empty field reports "required", a filled one reports format errors.

`register(name)` returns the props to spread onto a standard `<input>` (value,
event handlers, and so on); `handleSubmit` validates all fields and, if valid,
calls the configured `onSubmit`. The form's shape is defined by the keys of
`initial`.

## Components

| File | Role |
| --- | --- |
| `create-form.ts` | `createForm`: form state, `register`, submit lifecycle, and its types. |
| `validators.ts` | `required`, `minLength`, `maxLength`, `min`, `max`, `pattern`, `email`, `url`, `oneOf`, `combine`. |
| `phone.ts` | `phone`: phone-number validation with options. |
| `countries.ts` | `countries` and `getCountry`: country reference data. |

## Building

```sh
npm run build -w @azerothjs/form
```

## Examples

```ts
import { createForm, required, minLength, combine } from '@azerothjs/form';

const form = createForm({
    initial: { name: '', age: 0 },
    validate: { name: combine(required(), minLength(2)) },
    onSubmit: values => save(values)
});

// In markup, spread register() onto text inputs and attach handleSubmit:
//   <form onSubmit={form.handleSubmit}>
//     <input {...form.register('name')} />
//   </form>

// For inputs register() does not cover (checkbox, radio, select), set values
// from a custom handler:
form.setValue('age', 30);
```

`form.values()`, `form.errors()`, and `form.isValid()` are signal getters, so
reading them in markup updates only what depends on them; `form.reset()` restores
the initial state.

## Limitations

The first version does not include async validators (compose with
`createResource`), dedicated checkbox/radio/select `register` variants (use
`setValue`), field-array helpers (compose with `For`), or cross-field validation.

## Contributing

Keep validators pure functions that pass on empty input (except `required`), so
they compose predictably under `combine`.
