<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/logo-transparent.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/router

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Frouter?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/router)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained reactive framework. Applications usually install [`azerothjs`](https://www.npmjs.com/package/azerothjs); depend on this package directly for a narrower surface.

## Overview

Client-side routing built on the framework's reactivity. The current location is
a signal, so anything that reads it (an `<Outlet>`, a `useParams()` call, a
conditional in markup) updates only the parts of the UI that depend on the route.
Routing is manual-first: you create an explicit `Router` instance and place
`<Routes>`, `<Link>`, and `<Outlet>` yourself.

```ts
import { createRouter, Routes, Link } from '@azerothjs/router';

const router = createRouter({
    routes: [
        { path: '/', component: Home },
        { path: '/users/:id', component: User }
    ]
});
```

## Install

```sh
npm install @azerothjs/router
```

## Architecture

`createRouter(config)` builds a router over a history adapter (a browser history
by default) and exposes the current location as reactive state. Path patterns are
compiled once by `compilePath` into matchers that extract params (`:id`) and
support nested layouts; query strings are parsed and stringified by `parseQuery`
and `stringifyQuery`.

`<Routes>` renders the component for the matched route and provides the value for
any `<Outlet>` in a layout, so nested routes render their children inside their
parent layout. `<Link>` renders an anchor that navigates without a full page
load. The composables (`useRoute`, `useMatch`, `useParams`, `useQuery`,
`useNavigate`) read or act on the router's reactive location; `useLoader` exposes
data loaded for the active route.

Because the location is a signal, navigation does not re-render a tree; it
invalidates exactly the reactive reads that depend on what changed.

## Components

| File | Role |
| --- | --- |
| `router.ts` | `createRouter`, the `Router` type, `targetToFullPath`. |
| `history.ts` | `createBrowserHistory` / `createMemoryHistory` and the history adapter. |
| `path-pattern.ts` | `compilePath`: path matching and param extraction. |
| `query.ts` | `parseQuery`, `stringifyQuery`. |
| `routes.ts` | `Routes`: render the matched route. |
| `link.ts` | `Link`: client-side navigation anchor. |
| `outlet.ts` | `Outlet`: render nested-route content in a layout. |
| `use-route.ts` | `useRoute`, `useMatch`, `useParams`, `useQuery`, `useNavigate`. |
| `use-loader.ts` | `useLoader`: data for the active route. |
| `types.ts` | `Route`, `RouteLocation`, `RouterConfig`, and related types. |

`RouterConfig` requires `routes: Route[]` and accepts an optional `base` path for
apps served under a sub-path.


## Examples

Nested layout with an outlet and a param. A layout component receives the nested
content as its `children` prop and forwards it to `<Outlet>`:

```ts
import { createRouter, Routes, Outlet, Link, useParams } from '@azerothjs/router';
import { h } from '@azerothjs/renderer';

const router = createRouter({
    routes: [
        {
            path: '/dashboard',
            component: (props: { children?: HTMLElement }) => h('div', {},
                h('nav', {}, Link({ to: '/dashboard/profile', router, children: 'Profile' })),
                Outlet({ children: props.children })),
            children: [
                { path: 'profile', component: () => h('p', {}, 'profile') }
            ]
        }
    ]
});

function User() {
    const params = useParams(router);
    return h('h1', {}, () => `User ${params().id}`);
}
```

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
