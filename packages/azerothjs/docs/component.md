<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />
</p>

# azerothjs / component

[![npm](https://img.shields.io/npm/v/azerothjs?color=2ea44f)](https://www.npmjs.com/package/azerothjs)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework. Applications usually install [`azerothjs`](https://www.npmjs.com/package/azerothjs); depend on this package directly for a narrower surface.

## Overview

The component-runtime layer beneath the renderer. It is **not** a component-definition API - 
components are authored as `component` blocks in `.azeroth` files and compiled. What this package
provides is the runtime infrastructure those compiled components and the renderer's control flow rely
on:

- `destroyComponent(element)` - node-bound subtree teardown (dispose reactive scopes, run cleanups,
  recurse into children);
- `ErrorBoundary` - catch errors thrown while rendering a subtree and render a fallback, with a reset
  callback to retry;
- the **co-range** helpers - comment-marker placement ranges that the renderer's control-flow
  components (`Show`, `For`, `Switch`, ...) use to mark and update where they insert content.

```ts
import { ErrorBoundary } from 'azerothjs';
```

```azeroth
import { ErrorBoundary } from 'azerothjs';

component App
{
    <ErrorBoundary fallback={ (err, reset) => <button onClick={ reset }>Retry - { String(err) }</button> }>
        <RiskyThing />
    </ErrorBoundary>
}
```

## Install

```sh
npm install azerothjs
```

## Architecture

A compiled component's reactive state lives in a `createRoot` scope tied to the element it produces.
`destroyComponent(element)` walks that element's subtree, disposing the reactive scopes and running
cleanups so nothing leaks when a node is removed - the same teardown contract `render()` and the test
helpers use.

A setup read such as `state draft = props.name` takes a snapshot for this instance. An editor in
a layout's children or inside an `ErrorBoundary` keeps its draft when the name changes. Read
`props.name` in markup or in a `derived` value consumed by markup to display the current name.
To start a fresh editor, remove and reinsert its branch, or change the identity in a keyed row:

```azeroth
<For each={ [revision] } key={ version => version }>
    <div><Editor name={ name } /></div>
</For>
```

`ErrorBoundary` catches a throw during child construction or in a later owned effect or memo.
Its fallback receives a `reset` callback to retry construction with the current values. To validate
later prop changes, perform the check in an effect. An ordinary read during child or fallback
setup does not subscribe the boundary to that prop.

The **co-range** helpers are framework infrastructure, not app-facing API. A control-flow component
marks its position with a comment-marker range (`createCoMarkers`), appends/clears content within it
(`appendToCo` / `clearCo`), and adopts an existing range during hydration (`adoptCoRange`). They live
in this package - rather than the renderer - because they need `destroyComponent`, and the renderer
depends on `component`, not the reverse.

## Slots and children

A component can receive markup in a named prop, for example
`<Frame badge={ <Badge/> }/>`. Each read of `props.badge` constructs the markup.
Testing `props.badge !== undefined` and then displaying `{ props.badge }` constructs two
badges. Both can run effects and start requests even though only one appears on screen.

Use the value supplied by `Show` to test and display a slot in one evaluation:

```azeroth
component Frame(props: { badge?: Child })
{
    <section>
        <Show when={ props.badge } let={ badge }>{ badge }</Show>
    </section>
}
```

Import the `Child` type from `azerothjs`. For nested markup such as
`<Frame><Badge/></Frame>`, the compiler supplies a children builder. Each placement
of `{ props.children }` builds it again. Testing `props.children !== undefined`
checks whether the builder exists without calling it. Passing `props.children` itself
as a `when` condition invokes the builder to determine truthiness. Use `let=` to
display that result.

For repeated reads of the same named slot, `derived badge = props.badge;` caches its
value between dependency changes. The derived value is evaluated at construction, so
its component can be alive while the branch that would display it is hidden.

## Components

| File | Role |
| --- | --- |
| `destroy-component.ts` | `destroyComponent`: node-bound subtree teardown. |
| `error-boundary.ts` | `ErrorBoundary` and `ErrorBoundaryProps`. |
| `co-range.ts` | `createCoMarkers`, `appendToCo`, `clearCo`, `adoptCoRange`, `CoTarget`. |
| `destroy-hooks.ts` | Teardown bookkeeping shared by the above. |
| `types.ts` | Shared component types. |

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
