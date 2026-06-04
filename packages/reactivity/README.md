# @azerothjs/reactivity

## Overview

Fine-grained reactivity primitives: signals, effects, and memos, plus the
ownership, batching, and async helpers built on them. This is the foundation the
rest of the framework depends on; it has no dependencies of its own and no DOM
requirement, so it runs in the browser, on the server, and in tests unchanged.

The model is pull-based and fine-grained. A signal holds a value; reading it
inside an effect or memo subscribes that computation to it; writing a new value
re-runs only the computations that actually read it. There is no virtual DOM and
no component-level re-render.

```ts
import { createSignal, createEffect, createMemo } from '@azerothjs/reactivity';

const [count, setCount] = createSignal(0);
const doubled = createMemo(() => count() * 2);

createEffect(() => console.log(count(), doubled()));  // logs 0 0
setCount(c => c + 1);                                 // logs 1 2
```

## Architecture

A single module-level "current subscriber" tracks which computation is running.
Reading a signal registers the current subscriber as a dependency; writing
notifies dependents. Effects and memos set themselves as the current subscriber
while they run, which is how dependencies are discovered automatically rather
than declared.

Ownership is explicit. `createRoot` establishes a disposal scope; effects, memos,
and `onCleanup` callbacks created inside it are torn down together when the root
is disposed. This is what lets a component (or a route, or a store) clean up all
of its reactive state at once.

Batching coalesces synchronous writes: inside `batch`, dependent effects run once
at the end rather than after each write. `untrack` reads a signal without
subscribing to it.

The package also carries the shared render-mode flag and the SSR/hydration
primitives the renderer and server build on, so both client and server reactivity
go through one implementation.

## Components

| File | Role |
| --- | --- |
| `signal.ts` | `createSignal`: the reactive value primitive. |
| `effect.ts` | `createEffect`: a side effect that re-runs when its dependencies change. |
| `memo.ts` | `createMemo`: a cached derived value. |
| `batch.ts` | `batch`: coalesce synchronous writes into one update. |
| `untrack.ts` | `untrack`: read without subscribing. |
| `on.ts` | `on`: explicit dependency lists for effects/memos. |
| `create-root.ts` | `createRoot`, ownership and disposal scopes. |
| `on-cleanup.ts`, `on-root-dispose.ts` | Cleanup registration. |
| `create-resource.ts` | `createResource`: async data as a signal. |
| `create-stream.ts` | `createStream`: streamed/incremental async data. |
| `create-deferred.ts`, `create-selector.ts` | Deferred values and keyed selection. |
| `catch-error.ts` | `catchError`: scoped error handling for reactive code. |
| `render-mode.ts` | The shared client/string/hydrate render-mode flag. |
| `ssr.ts`, `hydration.ts` | SSR node markers and the hydration cursor. |
| `types.ts` | `Signal`, `Getter`, `Setter`, and related types. |

A `Signal<T>` is the tuple `[Getter<T>, Setter<T>]`, where `Getter<T>` is
`() => T` and `Setter<T>` is `(next: T | ((prev: T) => T)) => void`.

## Building

```sh
npm run build -w @azerothjs/reactivity
```

## Testing

```sh
npx vitest run test/reactivity
```

## Examples

```ts
import { createSignal, createEffect, batch, onCleanup, createRoot } from '@azerothjs/reactivity';

createRoot(dispose => {
    const [first, setFirst] = createSignal('Ada');
    const [last, setLast] = createSignal('Lovelace');

    createEffect(() => {
        const handle = setInterval(() => {}, 1000);
        onCleanup(() => clearInterval(handle));
        console.log(`${first()} ${last()}`);
    });

    batch(() => {           // one effect run, not two
        setFirst('Grace');
        setLast('Hopper');
    });

    dispose();              // tears down the effect and its cleanup
});
```

## Contributing

The internal wiring (the current-subscriber register, the effect queue, the
batching flag) is deliberately not exported; primitives share it through direct
module imports. Keep new primitives composed from the existing ones where
possible, and add tests under `test/reactivity`.
