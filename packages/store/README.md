# @azerothjs/store

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

## Architecture

The factory is a plain function whose return value is the store's public surface,
so there is no schema, reducer protocol, or `this`. On the first `useStore()`
call the factory runs inside a `createRoot`, which gives any `createEffect`,
`createMemo`, or `onRootDispose` it sets up an ownership scope to live in. The
result is cached, so the store is a lazy singleton: it is created on first use and
shared from then on.

Stores compose: one store's factory can call another store's `useStore()`.

## Components

| File | Role |
| --- | --- |
| `create-store.ts` | `createStore`: the lazy-singleton factory wrapper. |

## Building

```sh
npm run build -w @azerothjs/store
```

## Testing

```sh
npx vitest run test/store
```

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

## Contributing

The package is intentionally minimal; keep it that way. State shape and update
logic belong in the factory the caller writes, not in this package. Add tests
under `test/store`.
