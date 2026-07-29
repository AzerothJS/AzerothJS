<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="96" />

# {{name}}

**An `@azerothjs/http` server with no build step - Node runs the TypeScript source.**

[![Built with AzerothJS](https://img.shields.io/badge/built%20with-AzerothJS-5fb3e8)](https://github.com/AzerothJS/AzerothJS)
[![Node >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)

</div>

---

## 🚀 Start here

```sh
npm install
npm run dev
```

```sh
curl http://localhost:3000/healthz
```

`azeroth dev` is `node --watch` on `src/main.ts`. There is no compile step between
you and the running server: save a file, it restarts.

---

## 📜 Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | `node --watch` via the azeroth CLI - restarts on save. |
| `npm test` | Integration tests through `app.handle(new Request(...))` - no sockets, no test server. |
| `npm run check` | The gate: `tsc --noEmit` over `src/` and `tests/`, then eslint with the azeroth rules. |
| `npm run build` | Nothing, on purpose - the source IS the artifact. |
| `npm start` | Production: `node src/main.ts`. |

CI runs the same gates on every push - see `.github/workflows/ci.yml`.

---

## 🗂 Structure

| Path | Role |
| --- | --- |
| `src/app.ts` | The app, built PURE - routes in, `App` out. No serving, no environment, no side effects. This is what tests exercise. |
| `src/main.ts` | Bootstrap: logging, the edge pipeline (request id, security headers, CORS, rate limit), serve, graceful shutdown. |
| `src/config.ts` | The typed environment, read once - one boot error names every problem. `.env.example` documents every variable. |
| `tests/` | `app.handle()` integration tests. |

That split is the point: because `buildApp` takes its dependencies as arguments and
never touches the environment, a test can drive the entire app with a plain
`Request` object.

---

## 🔧 Environment

Copy `.env.example` to `.env` and adjust; `src/config.ts` reads it into a typed
object. Production reads the real environment instead.

`NODE_ENV=production` locks CORS down to nothing (add your real origins in
`src/main.ts` before going live) and switches request logs to NDJSON under `logs/`.

---

## 🧭 Adding a route

```ts
// src/app.ts
app.get('/widgets/:id', ({ params }) => json({ id: params.id }));
```

Then assert it in `tests/app.spec.ts` - no server needed:

```ts
const response = await buildApp({ dev: true }).handle(new Request('http://x/widgets/7'));
expect(response.status).toBe(200);
```

For a typed contract shared with a browser client, see the `fullstack` template.

---

## 🚢 Deploy

```sh
docker build -t {{name}} .
docker run -p 3000:3000 {{name}}
```

The Dockerfile has no build stage - it copies `src/` and runs it. `/healthz`
answers orchestrator probes, and `SIGTERM` drains in-flight responses before exit.

---

## 📚 Next

- **Add a browser half** - `npm create azeroth@latest` and pick `fullstack`: one
  shared typed contract across both halves, validated at the boundary and in the
  form, plus SSR and hydration.
- **[The AzerothJS repository](https://github.com/AzerothJS/AzerothJS)** for the
  full documentation.
