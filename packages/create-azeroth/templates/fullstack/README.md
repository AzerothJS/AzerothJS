# {{name}}

An [AzerothJS](https://github.com/AzerothJS/AzerothJS) fullstack app:
`application/` (compiled `.azeroth` components on vite) + `server/`
(`@azerothjs/http`, no build step) - one command runs both.

## The canon tour (what this template teaches)

| Piece | Where | The idea |
| --- | --- | --- |
| ONE route table | `application/src/routes.ts` | The router's own table IS the manifest - plus one `render:` field per route ('static' / 'server' / 'client') |
| Client routing | `application/src/App.azeroth` | `<RouterProvider>` + `<Routes>` + `<Link activeClass>` over that table; composables need no router argument |
| ONE shared contract | `server/src/contract.ts` | Routes + schemas declared once; imported by BOTH halves; client-safe by construction |
| Typed API client | `application/src/api.ts` | `createClient(contract)` - calls fully inferred, inputs validated BEFORE the wire |
| Schema-validated form | `application/src/pages/guest-book.azeroth` | The `form` keyword with the SAME schema the server enforces - one declaration, three enforcement points |
| Boundary validation | `server/src/app.ts` | `mountApi` - a forged request gets the 422 whose field map the form displays |
| SSR, prerender, hydration | `application/src/entry.server.ts` + `main.azeroth` | `createPageRenderer` SSRs through the router's guards and loaders; the home is prerendered at build, `/guestbook` per request; `bootClient` hydrates both |
| One-origin deploy | `server/src/main.ts` (`mountPages`) + `server/Dockerfile` | One container serves API + pages + assets; orchestrator probe; CI runs the same gates as local |

## Scripts (from this root)

| Command | Does |
| --- | --- |
| `npm run dev` | BOTH halves under one banner: the server on :3000, vite on :5173 with `/api` proxied |
| `npm test` | both suites: `app.handle()` API tests + component tests over real DOM |
| `npm run check` | every gate: server `tsc --noEmit`, client `azeroth-tsc` + eslint |
| `npm run build` | artifacts in dependency order (the server has none - by design) |
| `npm start` | production: the server serves the API **and** the built client - one origin |

## How the halves talk

- **Dev**: vite serves the client and proxies `/api` to the server
  (`application/vite.config.ts` - the whole wiring is that one visible line).
- **Production**: the server serves `application/dist` itself (`CLIENT_DIR` in
  `server/.env.example`), so the deployed app is ONE origin - no CORS between
  your own halves, ever.

## Environment

Copy `server/.env.example` to `server/.env` and adjust; `src/config.ts` reads it
into a typed object - a bad value fails boot with one error naming every problem.

## Deploy

One container for the whole app (stage 1 builds the client, stage 2 runs the
server and serves it):

```sh
docker build -f server/Dockerfile -t {{name}} .
docker run -p 3000:3000 {{name}}
```

`/api/healthz` answers orchestrator probes. CI runs the same gates you run
locally (`.github/workflows/ci.yml`): check, build, test.
