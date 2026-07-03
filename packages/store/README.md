# @azerothjs/store

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fstore?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/store)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained reactive framework. Applications usually install [`azerothjs`](https://www.npmjs.com/package/azerothjs); depend on this package directly for a narrower surface.

## Overview

A small reactive state container for state that should be shared across
components without prop drilling. `createStore(factory)` returns a `useStore`
function; the factory runs once on first use and every later call returns the
same instance.

```ts
import { createStore } from '@azerothjs/store';
import { createSignal } from '@azerothjs/reactivity';

const useCounter = createStore(() => {
    const [count, setCount] = createSignal(0);
    const increment = () => setCount(c => c + 1);
    return { count, increment };
});

// Anywhere in the app:
const { count, increment } = useCounter();
```

## Install

```sh
npm install @azerothjs/store
```

## Architecture

The factory is a plain function whose return value is the store's public surface,
so there is no schema, reducer protocol, or `this`. On the first `useStore()`
call the factory runs inside a `createRoot`, which gives any `createEffect`,
`createMemo`, or `onRootDispose` it sets up an ownership scope to live in. The
result is cached, so the store is a lazy singleton: it is created on first use and
shared from then on.

Instances are keyed by the active store scope. On the client there is one stable scope, so the store
is an app-wide singleton; under SSR each request renders in its own scope (`runInStoreScope`) and gets
an isolated instance, so concurrent requests never share state.

Stores compose: one store's factory can call another store's `useStore()`.

## Components

| File | Role |
| --- | --- |
| `create-store.ts` | `createStore`: the lazy-singleton factory wrapper. |


## Examples

A store composed from another store:

```ts
import { createStore } from '@azerothjs/store';
import { createSignal, createMemo } from '@azerothjs/reactivity';

const useAuth = createStore(() => {
    const [user, setUser] = createSignal<string | null>(null);
    return { user, login: (name: string) => setUser(name) };
});

const useDashboard = createStore(() => {
    const auth = useAuth();                 // shares the same auth instance
    const greeting = createMemo(() => `Hello ${auth.user() ?? 'guest'}`);
    return { greeting };
});
```

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
