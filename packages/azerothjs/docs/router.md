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
            <Routes fallback={ () => <h1>Not found</h1> }
                    blocked={ (state) => <h1>{ state.status === 401 ? 'Sign in' : 'No access' }</h1> } />
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
import { Outlet, type MountNode } from 'azerothjs';

export default component UsersLayout(props: { children?: MountNode })
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
    // `params` holds what THIS level and its ancestors bind, never a descendant's -
    // that is the set this level's result is cached under.
    return fetchOrders(params.id, signal);
}
```

- `useLoader()` in a route component reads ITS level (falling back to the nearest
  ancestor that loads); `useLoader(handle)` is exact and typed.
- `router.pending()` is true while any loader or lazy chunk of the current navigation
  is in flight - the top-bar signal.
- Loaders re-run when THEIR OWN inputs change - the params bound at or above their level
  and their declared query - and abort (via `signal`) when navigation supersedes them. A
  layout does not re-run when only a leaf param changes, which is why its loader receives
  the params at or above its level and never a descendant's: its result is cached under
  that same slice, so a value derived from a descendant's param would be served for every
  other value that param can take. To use a descendant's param, read it in a COMPONENT via
  `useParams()`, or read that level's data via `useLoader(handle)`.
- Put a request that depends on a leaf parameter in that leaf's loader and pass
  `params.id` to the fetcher. For data keyed by a search parameter, declare the query
  on the route and use its `query` argument. A signal read inside the loader samples its
  current value. Use `router.revalidate()` when application code needs to refresh the
  current loaders explicitly. To refresh one level, capture its resource with
  `const data = useLoader(handle)` in the component and call `data.refetch()` from the
  refresh control. With the data cache disabled, a nested level refreshes using its
  own current parameters and declared query.

## Route state during navigation

A guard can admit a destination while its lazy component is still loading. During
that hold, and while a replaced segment animates out, `useMatch()`, `useParams()`
and the params returned by `useRoute()` belong to that segment.
A retained layout follows the ready descendant. The pathname, query and hash follow
the URL. A missing or blocked page has a null segment match, empty params and idle loaders.

`useLoader()` keeps its selected level's last data, error, loading and refreshing
values when the router moves to another key. Calling `refetch()` through an obsolete
key or a retired segment resolves without starting a request. Passing the same router
explicitly keeps the segment scope. `useLoader(router)` selects the deepest loading
level and `useLoader(handle, router)` selects the handle's level. For navigation-wide
state, read `router.match()`, `router.location()` or `router.loaders[level]` directly.
A hook outside a routed segment or given a different router also reads that router's state.
Bare `useSearch()` validates the live query with its segment's schema. Explicit
`useSearch(router)` uses the admitted leaf's schema, and a route handle fixes the
schema even across navigation. The loader snapshot guarantee uses the key bindings
provided by `createRouter`. A custom structural router supplying only `loaders`
continues to expose those supplied resources.

Inside a layout, `useRenderedMatch()` follows the route its enclosing `Routes` is ready
to display. A synchronous read can precede the DOM update. A layout can use it to
retry a failed outlet once its next destination is ready. The fallback owns the
subscription, so a successful retry disposes it.

```ts
const rendered = useRenderedMatch();
return ErrorBoundary({
    children: () => Outlet({ children }),
    fallback: (_error, reset) => {
        on([rendered], reset, { skipInitial: true });
        return h('p', {}, 'Could not display this page.');
    }
});
```

## Guards, redirects, blockers

```ts
{
    path: '/admin',
    component: AdminLayout,
    guard: ({ from }) => auth.signedIn() ? true : '/login',   // target = redirect
    children: [ ... ]
}
```

- `guard` runs root-to-leaf BEFORE loaders and rendering: `true` passes, a target or
  `redirect(...)` goes elsewhere, and `false` / `forbidden()` / `unauthorized()` DENY.
  Async guards hold the navigation; first veto wins.
- A synchronous client guard can track reactive state. In the example above, changing
  `auth.signedIn()` causes the guard to evaluate access again.
- On the first client load, `router.state().kind` is `'pending'` while a guard decides.
  A fresh client render leaves the route range empty. Hydration leaves the served
  page visible and inert until it can adopt the same URL and presentation. If the
  client settles on another page, it renders that page fresh inside the route range.
  An unknown URL reports `'not-found'` immediately. A server-provided blocked
  verdict is available on the first client read.
- During a later guard wait, `router.state()` and the route content keep the previous
  settled result. Read `router.pending()` for a navigation indicator. Exhaustive
  switches over `RouteState` must handle `pending`, `match`, `blocked`, and
  `not-found`. Count a 404 only in the `not-found` case.
- Guards receive the destination's query. Editing the query runs the guards again.
  Its loader starts after admission. Fragment-only changes keep the current guard
  and loader. A guard can normalize its own URL by redirecting to a different query
  and then admitting that canonical URL.
- A denied navigation settles AT the target URL in the blocked state - it does not rewind.
  `<Routes blocked={...}>` renders it, SSR answers 401 or 403 with that same UI, and the
  route itself never renders in either mode, so a deep link and an in-app click agree.
- A guard makes every route under it identity-dependent, so the kit refuses
  `render: 'static'` (prerender and ISR) anywhere below one - a cached or prerendered
  page answers without running guards. Keep guarded subtrees server-rendered: put the
  guard on a layout whose children are `render: 'server'`, and let the public static
  pages live on a sibling branch.
- A loader THROWS `redirect('/login')` to turn its navigation into another one - on the
  client and during SSR alike.
- `router.block(fn)` registers a leave blocker (unsaved forms): return `false` to stay.
  Browser back/forward blocking is best-effort and synchronous-only - use
  `window.confirm` for pop prompts.

## Page actions (forms without client JS)

A route can declare an `action`: what a form on that page POSTs to. `mountPages` registers
a POST for the page's own path, so a plain `<form method="post">` works with no fetch, no
bundle and no event handler.

```ts
{
    path: '/todos',
    component: TodoPage,
    loader: () => listTodos(),
    action: async ({ form }) =>
    {
        const text = (form.get('text') ?? '').trim();
        if (text === '') { return { fields: { text: 'Required' } }; }   // refused: 422
        await addTodo(text);
        return undefined;                                              // accepted: 303
    }
}
```

- **Returning `undefined`** means the write happened: the answer is a **303 back to the same URL**,
  so the loader re-runs, the page shows the change, and a refresh cannot re-submit it
  (POST/Redirect/GET).
- **Returning a value** means it did not: the page re-renders at **422** with that value readable
  through `useActionResult()`. That is where field errors go.
- **Throwing `redirect(...)`** sends the visitor somewhere else entirely. The target is judged by
  the same rule as every other redirect: one that leaves the app's origin is refused (a 500, never
  a `Location`), and `unsafeUrl(...)` opts a deliberate one out.
- A page with no `action` still answers **405** to a POST, which is the honest response.
- **The page's guards run first**, through the same walk its GET runs, so a write is gated by
  exactly what gates the page. A visitor a guard turns away gets the page's own blocked UI at the
  guard's status (an enhanced submit gets the 401 or 403 envelope), a guard that redirects sends
  the submit there, and the action never runs. The CSRF check runs before the guards, so a
  cross-site submit reaches neither.
- An `action` cannot live on a `render: 'static'` page (a prerendered or cached page has no
  request to mint a form token for) or on a route with children (a layout is not a page); both
  are refused at mount and at build. Under `locales.routing: 'prefix'` the page accepts its form
  at its bare path and at every prefixed one.

### CSRF

A page action is a browser-reachable write, so the token is verified BEFORE the action runs.
A plain form cannot set a header, so it travels in a hidden `_csrf` field instead, and the
framework strips it before your action sees the fields:

```html
<input type="hidden" name="_csrf" value={ token } />
```

Pass `mountPages` the SAME options you gave `csrfCookie` (`csrf: { ... }`); the defaults
already agree, and a mismatch fails closed with a 403 rather than silently accepting. Rendering
the token into the form is still the application's job - note that `csrfCookie` mints it on the
RESPONSE, so a visitor's very first page load has no cookie yet and its form would carry an
empty token. It never mints on a page a shared cache may store (an ISR or prerendered page), so
a form there renders an empty token too.

### `<Form>`

`<Form>` renders that form and carries the token for you. Without JS it posts natively;
with JS it intercepts the submit, asks the same action for its JSON representation, and
revalidates the page in place - same scroll, same focus, no reload. An action that redirects
answers the enhanced submit with `{ ok: true, redirect }`, and `<Form>` navigates there. A
refusal that never reached your action - a guard, the CSRF check, a fault - settles
`onSettled({ ok: false })` with no result, leaves the previous validation verdict on screen, and
logs the status once. When the browser holds no token cookie it can count on (an ISR page
posting to a server page's action, or a jar that also holds another server's token cookie), the
enhanced submit first asks `/__azeroth/csrf` under the router base, once per form, and posts the
token that answer names, and asks again once that cookie has gone, as after a logout. A form
whose action is another origin never asks, so its field carries only the token the page
rendered. That ask is answered by `csrfCookie`, so a page that can come from a shared cache posts
only when `csrfCookie` runs in front of `mountPages`.

```azeroth
// todo-page.azeroth
import { Form, useActionResult, useLoader } from 'azerothjs';

export default component TodoPage()
{
    const todos = useLoader();
    const refusal = useActionResult();

    <Form>
        <input name="text" />
        <p class="error">{ refusal()?.fields?.text }</p>
        <button type="submit">Add</button>
    </Form>
}
```

The refusal arrives in the same `useActionResult()` either way, so the page is written once and
behaves the same whether or not the enhancement ran. `onSettled` hears the enhanced outcome;
it is never called on the native path, where the answer is a navigation rather than a value.

## Prefetching

A link can warm its destination before anyone clicks it - the lazy chunks download and the
loaders run, into the SAME cache entries the navigation will read.

```azeroth
<Link to="/users/42" prefetch="hover">Ada</Link>
```

| `prefetch` | when |
| --- | --- |
| absent | never. Prefetching spends a visitor's bandwidth on a guess, so it is opt-in |
| `"hover"` | pointer-enter or keyboard focus - the intent signal with the best hit rate |
| `"viewport"` | the first time the link is scrolled into view |
| `"render"` | immediately. Suits a small primary nav and nothing else |

`router.prefetch(to)` does the same thing programmatically, and resolves when the warming
settles. Failures are swallowed: a fetch nobody asked for must never surface as an error.

The sharing is the whole design. A prefetch fills the cache the navigation reads rather than
a cache of its own, so hovering and then clicking fetches ONCE, two links to the same place
cost one fetch, and a click that lands while the prefetch is still in flight JOINS it instead
of starting a second.

A warmed value is held for its first reader for 30 seconds. Without that hold every prefetch
would be discarded by the very navigation it was meant to make instant - a loader entry with
no subscribers is otherwise refetched the moment something subscribes, which is right when
nobody asked for it and wrong when somebody asked early. The hold is spent by that first
reader, so returning to the page later refetches like any other visit.

## The location payload

```ts
const location = useRoute();
location().pathname;        // '/users/7'
location().navigationKind;  // 'push' | 'replace' | 'pop'
location().delta;           // -1 back, +1 forward, 0 otherwise
location().key;             // this history entry's stable stamp. Opaque: compare keys with each other.
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
| `notFound` | The sentinel a loader throws when the route matched but its content does not exist: 404, not 500. |
| `unauthorized`, `forbidden` | What a guard returns to deny at 401 or 403; `router.state()` reports which. |
| `useRoute`, `useMatch`, `useParams`, `useQuery`, `useNavigate` | Reactive slices of the location. |
| `useRenderedMatch` | The route ready for the enclosing `Routes` instance. |
| `useLoader`, `useSearch` | This level's loader resource; the validated, typed search params. |
| `matchAndLoad`, `loaderHandoffScript`, `readLoaderHandoff` | The SSR data handoff, both directions. |
| `createBrowserHistory`, `createMemoryHistory` | History adapters (browser; SSR/tests). |

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
