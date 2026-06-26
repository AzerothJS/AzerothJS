# @azerothjs/core

## Overview

An umbrella package that re-exports the framework's public packages from one
place. Installing `@azerothjs/core` gives access to reactivity, the renderer, the
component system, the store, forms, the router, and server-side rendering through
a single import.

```ts
import {
    createSignal, createMemo, h, render,
    Show, For,
    createRouter, Link, Routes,
    createForm, createStore,
    renderToDocument
} from '@azerothjs/core';
```

## Architecture

This package contains no implementation of its own. It re-exports the public API
of each underlying package:

- `@azerothjs/reactivity`
- `@azerothjs/renderer`
- `@azerothjs/component`
- `@azerothjs/store`
- `@azerothjs/form`
- `@azerothjs/router`
- `@azerothjs/server`

Importing from `@azerothjs/core` and importing from the individual packages give
the same exports. Tree-shaking drops anything unused either way, so the choice is
about explicitness and dependency surface, not bundle size. Use `@azerothjs/core`
for convenience in an application; depend on individual packages when you want a
narrower dependency list (for example a library that only needs reactivity).

## Components

| File | Role |
| --- | --- |
| `index.ts` | Re-exports the public API of every underlying package. |

For the documentation of any given API, see the README of the package it comes
from:

- [reactivity](../reactivity/README.md)
- [renderer](../renderer/README.md)
- [component](../component/README.md)
- [store](../store/README.md)
- [form](../form/README.md)
- [router](../router/README.md)
- [server](../server/README.md)

## Building

```sh
npm run build -w @azerothjs/core
```

It depends on all the re-exported packages being built first; the repository root
`npm run build` builds in dependency order.

## Examples

A small application assembled entirely from `@azerothjs/core`:

```ts
import { createSignal, h, render } from '@azerothjs/core';

function App() {
    const [n, setN] = createSignal(0);
    return h('button', { onClick: () => setN(c => c + 1) }, () => `Count: ${n()}`);
}

render(App, document.getElementById('app')!);
```

## Contributing

When a re-exported package adds or changes a public export, mirror it here so the
umbrella stays in sync. Keep this package a pure re-export with no logic of its
own.
