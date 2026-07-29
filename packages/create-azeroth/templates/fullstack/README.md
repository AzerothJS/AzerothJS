<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="96" />

# {{name}}

**A fullstack app in one repo: compiled `.azeroth` components, an
`@azerothjs/http` server, and ONE typed contract between them.**

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
validate the same input three times - in the form, in the client before the wire,
and at the server boundary.

---

## ✨ The canon tour

Everything this template teaches, and the file that teaches it.

| Piece | Where | The idea |
| --- | --- | --- |
| **ONE route table** | `application/src/routes.ts` | The router's own table IS the manifest, plus one `render:` field per route (`'static'` / `'server'` / `'client'`). |
| **Client routing** | `application/src/App.azeroth` | `<RouterProvider>` + `<Routes>` + `<Link activeClass>` over that table; composables need no router argument. |
| **ONE shared contract** | `server/src/contract.ts` | Routes and schemas declared once, imported by BOTH halves, client-safe by construction. |
| **Typed API client** | `application/src/api.ts` | `createClient(contract)` - calls fully inferred, inputs validated BEFORE the wire. |
| **Schema-validated form** | `application/src/pages/guest-book.azeroth` | The `form` keyword with the SAME schema the server enforces: one declaration, three enforcement points. |
| **Boundary validation** | `server/src/app.ts` | `mountApi` - a forged request gets the 422 whose field map the form displays directly. |
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
  src/api.ts          the typed client, built from the server's contract
  src/entry.server.ts the SSR bundle's entry - exports routes + renderPage

server/               the API half - @azerothjs/http, no build step
  src/contract.ts     THE shared contract; the application imports this file
  src/app.ts          routes in, App out - pure, and what tests exercise
  src/main.ts         bootstrap: config, logging, edge pipeline, serve
  src/config.ts       the typed environment, read once
```

---

## 🔌 How the halves talk

- **In dev**, vite serves the client and proxies `/api` to the server. The whole
  wiring is one visible line in `application/vite.config.ts`.
- **In production**, the server serves `application/dist` itself and renders
  `render: 'server'` pages from the SSR bundle (`CLIENT_DIR` and `SSR_ENTRY` in
  `server/.env.example`). One origin, one container.

The contract is imported by relative path, not over the network: change a route's
shape in `server/src/contract.ts` and the client stops typechecking immediately.

---

## 🔧 Environment

Copy `server/.env.example` to `server/.env` and adjust; `server/src/config.ts`
reads it into a typed object, and a bad value fails boot with one error naming
every problem.

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
- **Add an endpoint**: one `route()` in `server/src/contract.ts` and its handler
  in `server/src/app.ts`. The client gains it, typed, with no other change.
- **Add a loader**: give a route a `loader` and the SSR seam carries its data to
  the browser - the handoff wiring in `App.azeroth` is already there.
- **[The AzerothJS repository](https://github.com/AzerothJS/AzerothJS)** for the
  full documentation.
