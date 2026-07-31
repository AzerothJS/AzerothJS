<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="96" />

# {{name}}

**A fullstack app in one repo: compiled `.azeroth` components, an
`@azerothjs/http` server, and ONE typed API declaration between them.**

[![Built with AzerothJS](https://img.shields.io/badge/built%20with-AzerothJS-5fb3e8)](https://github.com/AzerothJS/AzerothJS)
[![Node >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)

</div>

---

## 🚀 Start here

```sh
npm install
npm run dev
```

Both halves come up under one banner: the server on **:3000**, vite on **:5173**
with `/api` proxied to it. Open :5173, sign the guest book, and watch one schema
validate the same input in the form AND at the server boundary - and the server's
422 land back in the form's own error shape.

---

## ✨ The canon tour

Everything this template teaches, and the file that teaches it.

| Piece | Where | The idea |
| --- | --- | --- |
| **ONE route table** | `application/src/routes.ts` | The router's own table IS the manifest, plus one `render:` field per route (`'static'` / `'server'` / `'client'`). |
| **Client routing** | `application/src/App.azeroth` | `<RouterProvider>` + `<Routes>` + `<Link activeClass>` over that table; composables need no router argument. |
| **ONE declared API** | `server/src/app.ts` | `feature()` - routes, schemas, handlers, streams, colocated; the route name written once. |
| **Typed API client** | `application/src/api.ts` | `createClient<typeof api>(manifest)` - calls fully inferred from the server's own types; the runtime half is a served two-fields-per-route manifest. |
| **Schema-validated form** | `application/src/pages/guest-book.azeroth` | The `form` keyword with the SAME schema the server enforces: one declaration, both boundaries. |
| **Boundary validation** | `server/src/app.ts` | `register` - a forged request gets the 422 whose field map the form displays directly. |
| **SSR, prerender, hydration** | `application/src/entry.server.ts` | `createPageRenderer` renders a url through the route table. The home is prerendered at build, `/guestbook` per request, and `bootClient` hydrates both. |
| **One-origin deploy** | `server/src/main.ts` + `server/Dockerfile` | One container serves API, pages and assets. No CORS between your own halves, ever. |

---

## 📜 Scripts (from this root)

| Command | Does |
| --- | --- |
| `npm run dev` | BOTH halves under one banner: server on :3000, vite on :5173 with `/api` proxied. |
| `npm test` | Both suites: `app.handle()` API tests, then component tests over real DOM. |
| `npm run check` | Every gate: server `tsc --noEmit` + eslint, client `azeroth-tsc` + eslint. |
| `npm run build` | Client bundle, the SSR bundle, then the static prerender pass. The server has no build step, by design. |
| `npm start` | Production: one origin serving the API **and** the built client. |

CI runs exactly these on every push - see `.github/workflows/ci.yml`.

---

## 🗂 Structure

```
application/          the browser half - vite + the azeroth compiler
  src/routes.ts       the one route table (path, component, render mode)
  src/App.azeroth     the shell: nav + the <Routes> outlet
  src/pages/          one component per route
  src/api.ts          the seam to the server: the typed client + its shapes
  src/entry.server.ts the SSR bundle's entry - exports routes + renderPage

server/               the API half - @azerothjs/http, no build step
  src/schemas.ts      the client-safe schemas; the application imports this file
  src/app.ts          THE declared API (feature + register) - pure, what tests exercise
  src/main.ts         the environment, logging, edge pipeline, serve, shutdown
```

---

## 🔌 How the halves talk

- **In dev**, vite serves the client and proxies `/api` to the server. The whole
  wiring is one visible line in `application/vite.config.ts`.
- **In production**, the server serves `application/dist` itself and renders
  `render: 'server'` pages from the SSR bundle (`CLIENT_DIR` and `SSR_ENTRY` in
  `server/.env.example`). One origin, one container.

The API's TYPES cross by relative import (`typeof api` - erased at build, so no
server code can reach the browser); its runtime half is the served manifest.
Change a route's shape in `server/src/app.ts` and the client stops typechecking
immediately.

### Four kinds of route, all declared

Every route lives in the feature - the builder says HOW it speaks, and all four kinds inherit
the feature's guard and appear in the manifest and the OpenAPI document:

| Kind | Builder | Examples |
| --- | --- | --- |
| JSON | `r.get` / `r.post` / ... | the guest book: validated input, validated output, the 422 field map |
| Stream | `r.stream` | `GET /api/assistant` - a server-sent token stream, consumed on the home page by the `stream` keyword |
| Form | `r.form` | a title plus an avatar: text fields validated like a JSON body, files buffered within declared caps |
| Raw | `r.raw` | uploads beyond form scale (`streamMultipart`), webhooks over raw bytes, redirects, downloads, `conditional()` 304s |

The typed client speaks the JSON kind; form/raw/stream routes are filtered from its surface
and refuse loudly if reached untyped - a browser posts `FormData` or opens an `EventSource`
directly. The stream here is the worked example: the `stream` keyword accumulates the events
into one reactive string and cancels the request when you press Stop - which is where a real
handler stops paying a model provider.

---

## 🔬 Devtools

`npm run dev` mounts the inspector in the application: a launcher pill bottom-right with a
live effect count, opening onto the reactive tree, the dependency graph, and a timeline of
every run with the cause that triggered it.

The **Server** tab is the one worth opening here. The server half attaches a bridge in
`server/src/main.ts`, and the tab mirrors its reactive graph live: one root per in-flight
request, the state and effects inside it, and the long-lived stores beside them. That is what
"every request is a reactive root" looks like from the outside - request isolation across
`await`, visible rather than asserted.

Both sides are dev-only by construction. The client is behind `import.meta.env.DEV`, which a
build replaces with `false`, so the branch and its import are eliminated. The server bridge
attaches only under `NODE_ENV=development` and refuses every upgrade that does not present the
per-boot token from a loopback peer with a localhost `Origin`. That graph carries live
application values, tokens and account rows included, so treat the bridge like the debugger port
it is: the token is printed at boot and minted fresh each time, never written to disk.

---

## 🔧 Environment

Copy `server/.env.example` to `server/.env` and adjust; `server/src/main.ts` reads it
into a typed object before anything else runs, and a bad value fails boot with one
error naming every problem.

---

## 🚢 Deploy

One container for the whole app - stage 1 builds the client, stage 2 runs the
server and serves it:

```sh
docker build -f server/Dockerfile -t {{name}} .
docker run -p 3000:3000 {{name}}
```

Build from the repo ROOT (the `.` above), not from `server/`: the workspace
lockfile lives here, and so does the `.dockerignore` that keeps `node_modules`
out of the image. `/api/healthz` answers orchestrator probes.

---

## 📚 Next

- **Add a page**: one row in `application/src/routes.ts` plus its component.
  Choosing how it ships is the `render:` field.
- **Add an endpoint**: one `r.get(...)` line inside the feature in
  `server/src/app.ts` - path, schemas, and handler together. The client gains
  it, typed, with no other change.
- **Add a loader**: give a route a `loader` and the SSR seam carries its data to
  the browser - the handoff wiring in `App.azeroth` is already there.
- **[The AzerothJS repository](https://github.com/AzerothJS/AzerothJS)** for the
  full documentation.
