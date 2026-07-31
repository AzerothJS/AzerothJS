<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />
</p>

# azerothjs / router

[![npm](https://img.shields.io/npm/v/azerothjs?color=2ea44f)](https://www.npmjs.com/package/azerothjs)

The client router of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - part of the
[`azerothjs`](https://www.npmjs.com/package/azerothjs) package, imported from it directly.

```sh
npm install azerothjs
```

## Overview

The current location is a SIGNAL. Anything that reads it - a `useParams()` call, a
conditional in markup, a `<Link>`'s active state - updates only the parts of the UI that
depend on what changed; navigation never re-renders a tree.

Routes are DATA. Every matched level's loader runs in PARALLEL on navigation, guards run
root-to-leaf before anything renders or loads, code-split routes hold the previous
screen until their chunk lands, and scroll restoration + route-change focus are on by
default. One route table drives the client, the server render, and the SSR data handoff.

## Quick start

```azeroth
// app.azeroth
import { RouterProvider, Routes, createRouter } from 'azerothjs';
import { routes } from './routes';

export default component App()
{
    const router = createRouter({ routes });

    <RouterProvider router={ router }>
        <main>
            <Routes fallback={ () => <h1>Not found</h1> } />
        </main>
    </RouterProvider>
}
```

```ts
// routes.ts - routes are data; nesting makes layouts
import type { Route } from 'azerothjs';
import Home from './pages/home.azeroth';
import UsersLayout from './pages/users-layout.azeroth';
import UserList from './pages/user-list.azeroth';

export const routes: Route[] = [
    { path: '/', component: Home },
    {
        path: '/users',
        component: UsersLayout,
        children: [
            { path: '', component: UserList },
            { path: ':id', lazy: () => import('./pages/user-profile.azeroth') }
        ]
    }
];
```

A layout places its nested content with `<Outlet>`:

```azeroth
// users-layout.azeroth
import { Outlet } from 'azerothjs';

export default component UsersLayout(props: { children?: unknown })
{
    <section>
        <h1>Users</h1>
        <Outlet children={ props.children } />
    </section>
}
```

Inside a `<RouterProvider>`, composables and components need no router argument:
`useRoute()`, `useParams()`, `useNavigate()`, `<Link to="/users">`. The explicit
argument (`useRoute(router)`) remains for tests and nested routers.

## Typed routes - `defineRoute`

A handle carries the pattern's param types, the loader's data type, and the search
schema's value type - adopt it route by route, plain objects stay first-class:

```ts
import { defineRoute } from 'azerothjs';
import { object, number, enumOf } from '@azerothjs/schema';

export const userRoute = defineRoute('/users/:id', {
    lazy: () => import('./pages/user-profile.azeroth'),
    loader: async ({ params, signal }) => fetchUser(params.id, signal),   // params.id: string
    search: object({ tab: enumOf(['posts', 'bio']).optional(), page: number({ coerce: true }).optional() })
});
```

```azeroth
// user-profile.azeroth
import { useLoader, useSearch, useNavigate } from 'azerothjs';
import { userRoute } from '../routes';

export default component UserProfile()
{
    const user = useLoader(userRoute);      // Resource<User> - typed, no cast
    const search = useSearch(userRoute);    // { tab?: 'posts' | 'bio'; page?: number } - COERCED
    const { navigate } = useNavigate();

    <article>
        <h1>{ user.data()?.name }</h1>
        <button onClick={ () => navigate(userRoute.to({ id: '7' }, { search: { tab: 'bio' } })) }>
            IntelligentQuantum's bio
        </button>
    </article>
}
```

`userRoute.to({ id })` is compile-checked against the pattern; a mistyped search key is
a compile error; `?page=4` arrives as the number `4`. An invalid query never crashes a
route someone reached by URL - it degrades to `{}` with one console warning.

## Data loading

Every matched level may declare a loader; on navigation ALL levels start
simultaneously - a layout loads beside its leaf, never in a waterfall:

```ts
loader: async ({ params, query, signal, parent }) =>
{
    // `parent` resolves with the nearest ancestor loader's data.
    // Await it ONLY when this level truly depends on it - parallel is the default.
    const account = await parent;
    return fetchOrders(params.id, signal);
}
```

- `useLoader()` in a route component reads ITS level (falling back to the nearest
  ancestor that loads); `useLoader(handle)` is exact and typed.
- `router.pending()` is true while any loader or lazy chunk of the current navigation
  is in flight - the top-bar signal.
- Loaders re-run when params change and abort (via `signal`) when navigation supersedes
  them.

## Guards, redirects, blockers

```ts
{
    path: '/admin',
    component: AdminLayout,
    guard: ({ from }) => auth.signedIn() ? true : '/login',   // target = redirect
    children: [ ... ]
}
```

- `guard` runs root-to-leaf BEFORE loaders and rendering: `false` vetoes (previous
  location restored), a target or `redirect(...)` goes elsewhere, `true` passes. Async
  guards hold the navigation; first veto wins.
- A loader THROWS `redirect('/login')` to turn its navigation into another one - on the
  client and during SSR alike.
- `router.block(fn)` registers a leave blocker (unsaved forms): return `false` to stay.
  Browser back/forward blocking is best-effort and synchronous-only - use
  `window.confirm` for pop prompts.

## The location payload

```ts
const location = useRoute();
location().pathname;        // '/users/7'
location().navigationKind;  // 'push' | 'replace' | 'pop'
location().delta;           // -1 back, +1 forward, 0 otherwise
location().key;             // this history entry's stable stamp
```

History entries are stamped, so back vs forward is knowable and each entry keys its
own scroll position. The `<Routes transition>` callback receives the same fields -
directional route animations are one comparison.

## Scroll and focus - managed by default

Push/replace scrolls to top (or the `#hash` target); pop RESTORES the position
recorded for that entry. After each navigation the new route content receives focus
(mark a specific element with `data-route-focus` to aim it), so keyboard and
screen-reader users land where the navigation took them.

Opt-outs and overrides: `createRouter({ scroll: false })`, `{ focus: false }`, a
`scrollBehavior` callback, or a per-navigation `navigate(to, { scroll: false })`.

## Links

```azeroth
<Link to="/users" activeClass="is-active">Users</Link>          // active at /users/7 too (prefix)
<Link to="/users" activeClass="is-active" end>Users</Link>      // exact only
<Link to={ () => `/users/${ selected() }` }>Open</Link>         // reactive destination
```

A `<Link>` is a real `<a href>`: ctrl-click, middle-click, copy-link, and external URLs
all behave natively; only plain in-app clicks are intercepted. `activeClass` toggles
with `aria-current="page"` in lockstep.

## SSR: one route table, data crossing once

```ts
// server
const result = await matchAndLoad(routes, request.url, { signal: request.signal });
if (result !== null && 'redirect' in result)
{
    return redirectResponse(result.redirect);            // a real 302 - guards run here too
}
const page = renderToDocument(() => App({}), { head: loaderHandoffScript(result) });

// client (hydration)
const router = createRouter({ routes, initialLoaderData: readLoaderHandoff() });
```

`matchAndLoad` runs the SAME guards and the SAME per-level parallel loaders the client
router runs, and pre-resolves lazy chunks so the synchronous render finds every
component ready. The handoff payload is versioned and keyed to the exact URL - a stale
or mismatched payload degrades to a normal client fetch, never to wrong data.

## API surface

| Import | Role |
| --- | --- |
| `createRouter`, `Router` | The orchestrator: reactive `location`/`match`, per-level `loaders`, `pending`, `navigate`/`replace`/`back`/`forward`/`href`, `block`. |
| `RouterProvider` | Context: composables and components drop the router argument. |
| `Routes`, `Outlet`, `Link` | The DOM side: dispatch, nesting, navigation anchors. |
| `defineRoute` | Typed route handles: pattern-typed params, loader-typed data, schema-typed search. |
| `redirect` | The sentinel loaders throw (and guards return) to re-aim a navigation. |
| `useRoute`, `useMatch`, `useParams`, `useQuery`, `useNavigate` | Reactive slices of the location. |
| `useLoader`, `useSearch` | This level's loader resource; the validated, typed search params. |
| `matchAndLoad`, `loaderHandoffScript`, `readLoaderHandoff` | The SSR data handoff, both directions. |
| `createBrowserHistory`, `createMemoryHistory` | History adapters (browser; SSR/tests). |

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
