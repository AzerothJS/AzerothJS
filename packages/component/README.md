# @azerothjs/component

## Overview

The component system: a way to define components with lifecycle hooks on top of
the renderer and reactivity. It provides both a function style
(`defineComponent`) and a class style (`AzerothComponent`), the `onMount` and
`onDestroy` hooks, an `ErrorBoundary`, and `destroyComponent` for explicit
teardown.

```ts
import { defineComponent, onMount } from '@azerothjs/component';
import { h } from '@azerothjs/renderer';
import { createSignal } from '@azerothjs/reactivity';

const Hello = defineComponent<{ name: string }>(props => {
    const [count, setCount] = createSignal(0);
    onMount(() => console.log('mounted'));
    return h('button', { onClick: () => setCount(c => c + 1) },
        () => `Hi ${props.name}, clicked ${count()}`);
});
```

## Architecture

A component is a function from props to a DOM element. `defineComponent` wraps a
setup function so that its reactive state and lifecycle hooks are bound to the
element it returns: the setup runs inside an ownership scope, `onMount` callbacks
fire after the element is in the document, and `onDestroy` callbacks (and any
cleanup returned from `onMount`) run when the element is destroyed.
`destroyComponent(element)` triggers that teardown for any component element.

`AzerothComponent` is the class equivalent: a base class with an abstract
`render(): HTMLElement` and the same lifecycle, for code that prefers classes or
needs to hold instance state. Both styles share one lifecycle implementation.

`ErrorBoundary` catches errors thrown while rendering its subtree and renders a
fallback instead, with a reset callback to retry.

## Components

| File | Role |
| --- | --- |
| `define-component.ts` | `defineComponent`, `onMount`, `onDestroy`, `destroyComponent`. |
| `azeroth-component.ts` | `AzerothComponent` base class and `ReactiveState`. |
| `destroy-hooks.ts` | Lifecycle/cleanup bookkeeping shared by both styles. |
| `error-boundary.ts` | `ErrorBoundary` and its props. |
| `types.ts` | `Component`, `ComponentSetup`, `LifecycleHook`. |

`ComponentSetup<P>` is `(props: P) => HTMLElement`. A `LifecycleHook` may return a
cleanup function; for `onMount` that cleanup runs on destroy.

## Building

```sh
npm run build -w @azerothjs/component
```

## Testing

```sh
npx vitest run test/component
```

## Examples

Class style:

```ts
import { AzerothComponent } from '@azerothjs/component';
import { h } from '@azerothjs/renderer';

class Clock extends AzerothComponent {
    private timer = 0;

    onMount() {
        this.timer = setInterval(() => {}, 1000) as unknown as number;
    }

    onDestroy() {
        clearInterval(this.timer);
    }

    render() {
        return h('time', {}, 'tick');
    }
}
```

## Contributing

Keep the two styles behaviorally identical; lifecycle and cleanup logic lives in
one place (`destroy-hooks.ts`) and both `defineComponent` and `AzerothComponent`
go through it. Add tests under `test/component`.
