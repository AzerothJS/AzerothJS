---

## 🧭 Router (applied)

This app was scaffolded with `--router`: the framework's own client-side router,
no extra dependency.

| Path | Role |
| --- | --- |
| `src/routes.ts` | The one route table - one row per page. |
| `src/pages/` | One component per route. |
| `src/App.azeroth` | The shell: `<Link>` nav plus the `<Routes>` outlet. |

Adding a page is one row plus its component:

```ts
// src/routes.ts
{ path: '/pricing', component: Pricing }
```

`<Link activeClass="active">` marks the current route for you, and the optional
`url` prop on `App` pins a memory history so a test can render any route directly.
