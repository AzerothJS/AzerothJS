# {{name}}

An [AzerothJS](https://github.com/AzerothJS/AzerothJS) backend. No build step:
Node >= 24 runs the TypeScript source directly.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | `node --watch` via the azeroth CLI - restarts on save |
| `npm test` | integration tests via `app.handle(new Request(...))` - no server needed |
| `npm run check` | typecheck (`tsc --noEmit`) |
| `npm run build` | nothing, on purpose - the source IS the artifact |
| `npm start` | production: `node src/main.ts` |

## Structure

| Path | Role |
| --- | --- |
| `src/app.ts` | The app, built pure - routes only. This is what tests exercise. |
| `src/main.ts` | Bootstrap: logging, the edge pipeline (security headers, CORS, rate limit), serve, graceful shutdown. |
| `src/config.ts` | The typed environment - one boot error names every problem. `.env.example` documents the variables. |
| `tests/` | `app.handle()` integration tests. |

## Environment

Copy `.env.example` to `.env` and adjust. Production reads the real environment;
`NODE_ENV=production` locks down CORS (add your origins in `src/main.ts`) and
switches request logs to NDJSON in `logs/`.

## Deploy

```sh
docker build -t {{name}} .
docker run -p 3000:3000 {{name}}
```

The Dockerfile has no build stage - it copies `src/` and runs it. `/healthz`
answers orchestrator probes.
