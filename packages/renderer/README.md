<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/logo-transparent.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/renderer

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Frenderer?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/renderer)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained reactive framework. Applications usually install [`azerothjs`](https://www.npmjs.com/package/azerothjs); depend on this package directly for a narrower surface.

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

## Install

```sh
npm install @azerothjs/renderer
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
key, so only changed rows touch the DOM. The flip side is deliberate: a value baked
into a surviving row at creation time (a captured label, a formatted date) stays as
it was - read changing values through a getter or signal inside the row so they
update in place. Each control-flow component manages the
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
| `islands.ts` | `hydrateIslands`: partial hydration of marked islands. |
| `ssr.ts` | Server-output (string-mode) support. |
| `delegate.ts`, `template.ts`, `container-disposers.ts` | Event delegation, compiler-emitted clone helpers, and mount-scope disposal. |
| `types.ts` | `Props`, `Child`, and component prop types. |


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

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
