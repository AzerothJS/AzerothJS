# @azerothjs/renderer

## Overview

The DOM renderer. It turns the `h()` hyperscript calls that `.azeroth` markup
compiles to into real DOM elements, and wires reactive bindings so that only the
attributes, text nodes, and children that actually depend on a changed signal are
updated. There is no virtual DOM and no diffing.

```ts
import { h, render } from '@azerothjs/renderer';
import { createSignal } from '@azerothjs/reactivity';

function Counter() {
    const [n, setN] = createSignal(0);
    return h('button', { onClick: () => setN(c => c + 1) }, () => `Count: ${n()}`);
}

render(Counter, document.getElementById('app')!);
```

## Architecture

`h(tag, props, ...children)` creates an element immediately. For each prop or
child that is a function, it sets up a `createEffect` that re-applies just that
binding when its dependencies change, so updates are localized to the exact node
involved. Event handlers (`onClick`, `onInput`, and the rest) are attached as
listeners; a `ref` prop gives direct access to the created element.

Control-flow components (`Show`, `For`, `Switch`/`Match`, `Portal`, `Dynamic`,
`Suspense`, `Transition`) are ordinary functions returning DOM, built on the same
reactive effects. `For` is keyed: it reuses existing DOM nodes across updates by
key, so only changed rows touch the DOM. Each control-flow component manages the
disposal of the reactive scope for the content it mounts and unmounts, so
removing an element also tears down its effects.

The renderer shares the render-mode flag and SSR/hydration primitives with
`@azerothjs/reactivity`, so `hydrate` can adopt server-rendered markup by walking
it with a hydration cursor instead of creating new nodes.

## Components

| File | Role |
| --- | --- |
| `h.ts` | `h()`: element creation and reactive prop/child binding. |
| `render.ts` | `render()`: mount a component tree into a container. |
| `hydrate.ts` | `hydrate()`: adopt server-rendered markup on the client. |
| `show.ts` | `Show`: conditional rendering. |
| `for.ts` | `For`: keyed list rendering. |
| `switch.ts` | `Switch` and `Match`: multi-case rendering. |
| `portal.ts` | `Portal` and `destroyPortal`: render outside the parent DOM. |
| `dynamic.ts` | `Dynamic`: swap components at runtime. |
| `suspense.ts` | `Suspense`: fallback while resources load. |
| `transition.ts` | `Transition`: CSS enter/leave animation. |
| `ref.ts` | `createRef`: direct element access. |
| `class-binding.ts` | `classList`: reactive class binding. |
| `style-binding.ts` | `styleMap`: reactive inline-style binding. |
| `css.ts` | `css` scoped styles plus `collectStyleSheet`/`resetStyleSheet`. |
| `ssr.ts`, `hydrate.ts` | Server-output and client-adoption support. |
| `types.ts` | `Props`, `Child`, and component prop types. |

## Building

```sh
npm run build -w @azerothjs/renderer
```

## Testing

```sh
npx vitest run test/renderer
```

## Examples

Control-flow components take their content as a `children` prop (a thunk for
`Show`, a render function for `For`), matching how the markup forms compile:

```ts
import { h, Show, For, classList } from '@azerothjs/renderer';
import { createSignal } from '@azerothjs/reactivity';

const [items] = createSignal<string[]>(['a', 'b']);
const [open] = createSignal(true);

h('section', { class: classList({ panel: true, open }) },
    Show({
        when: open,
        fallback: () => h('p', {}, 'hidden'),
        children: () => For({
            each: items,
            key: (item: string) => item,
            children: (item: string) => h('li', {}, item)
        })
    }));
```

In a `.azeroth` file the same UI is written as markup and compiled to these
calls; you rarely call `h()` by hand.

## Contributing

A binding should update the smallest possible piece of the DOM; prefer adding a
focused effect over re-running a larger subtree. New control-flow components
follow the existing pattern: a function returning DOM that owns the reactive
scope for what it mounts. Add tests under `test/renderer`.
