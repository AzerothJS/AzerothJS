# @azerothjs/component

## Overview

The component-runtime layer beneath the renderer. It is **not** a component-definition API —
components are authored as `component` blocks in `.azeroth` files and compiled. What this package
provides is the runtime infrastructure those compiled components and the renderer's control flow rely
on:

- `destroyComponent(element)` — node-bound subtree teardown (dispose reactive scopes, run cleanups,
  recurse into children);
- `ErrorBoundary` — catch errors thrown while rendering a subtree and render a fallback, with a reset
  callback to retry;
- the **co-range** helpers — comment-marker placement ranges that the renderer's control-flow
  components (`Show`, `For`, `Switch`, …) use to mark and update where they insert content.

```ts
import { ErrorBoundary } from '@azerothjs/component';
```

```azeroth
import { ErrorBoundary } from '@azerothjs/core';

component App
{
    <ErrorBoundary fallback={(err, reset) => <button onClick={reset}>Retry — {String(err)}</button>}>
        <RiskyThing />
    </ErrorBoundary>
}
```

## Architecture

A compiled component's reactive state lives in a `createRoot` scope tied to the element it produces.
`destroyComponent(element)` walks that element's subtree, disposing the reactive scopes and running
cleanups so nothing leaks when a node is removed — the same teardown contract `render()` and the test
helpers use.

`ErrorBoundary` runs its child in a scoped error handler; a throw during render (or in an effect)
swaps in the fallback instead of crashing the tree, and the fallback receives a `reset` to retry.

The **co-range** helpers are framework infrastructure, not app-facing API. A control-flow component
marks its position with a comment-marker range (`createCoMarkers`), appends/clears content within it
(`appendToCo` / `clearCo`), and adopts an existing range during hydration (`adoptCoRange`). They live
in this package — rather than the renderer — because they need `destroyComponent`, and the renderer
depends on `component`, not the reverse.

## Components

| File | Role |
| --- | --- |
| `destroy-component.ts` | `destroyComponent`: node-bound subtree teardown. |
| `error-boundary.ts` | `ErrorBoundary` and `ErrorBoundaryProps`. |
| `co-range.ts` | `createCoMarkers`, `appendToCo`, `clearCo`, `adoptCoRange`, `CoTarget`. |
| `destroy-hooks.ts` | Teardown bookkeeping shared by the above. |
| `types.ts` | Shared component types. |

## Building

```sh
npm run build -w @azerothjs/component
```

## Contributing

Teardown and co-range logic is the load-bearing part: it is what keeps the framework leak-free as
nodes come and go. Keep it in one place and let both `destroyComponent` and the control-flow
components go through it, rather than re-implementing range placement per control-flow component.
