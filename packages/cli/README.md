<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />

# @azerothjs/cli

**The `azeroth` command line - one verb per job, and nothing hidden.**

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fcli?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

</div>

---

Part of [AzerothJS](../../README.md) - the fine-grained, zero-dependency, fullstack
TypeScript framework. `azeroth` is the single command line every scaffolded app depends on.

---

## What you get

- **One verb per job** - `dev`, `check`, `build`, `test`, `upgrade`, `doctor`, `info`.
  No sub-command mazes, no aliases.
- **Detection-first, no config file** - the CLI reads your project's shape from what
  already exists (a `package.json`, a vite config) and composes the tools you installed.
- **Nothing hidden** - `--print` shows the exact `node <script>` invocations before
  anything runs; there is no eject because there is nothing to eject.
- **The fullstack conductor** - `azeroth dev` runs the server watch and vite under one
  banner and one Ctrl+C, no second terminal.

---

## Install

```sh
npm install --save-dev @azerothjs/cli
```

New projects start with the [scaffolder](https://www.npmjs.com/package/create-azeroth),
which wires `@azerothjs/cli` in for you:

```sh
npm create azeroth@latest my-app
```

---

## Commands

| Verb | What it does |
| --- | --- |
| `azeroth dev` | Run the app in watch mode - the fullstack conductor (server watch + vite, one banner, one Ctrl+C). |
| `azeroth check` | Every quality gate the project's shape demands, server first: `azeroth-tsc`, `tsc --noEmit`, eslint. |
| `azeroth build` | Deployable artifacts in dependency order (a native backend has none - by design). |
| `azeroth test` | Run each half's vitest suite (server first). |
| `azeroth upgrade` | Move every AzerothJS pin to a target version, install, and run the doctor. |
| `azeroth doctor` | Diagnose the environment against the known failure catalog. |
| `azeroth info` | A paste-able environment block for bug reports. |

---

## Flags

| Flag | Effect |
| --- | --- |
| `--print` | Print the exact child invocations and exit (`dev` / `check` / `build` / `test`; on `upgrade`, the pin table). |
| `--raw` | Verbatim child output in `dev` - no rewriting, no color propagation. |
| `--app <dir>` | Explicit frontend half of a fullstack root. |
| `--server <dir>` | Explicit backend half of a fullstack root. |
| `-v`, `--version` | Print the CLI version. |
| `-h`, `--help` | Show the help text. |

> [!NOTE]
> `NO_COLOR`, `FORCE_COLOR`, and `AZEROTH_LOG` are always honored, `--raw` or not.

---

## `--print` - transparency

> [!TIP]
> Every orchestrating command takes `--print`: it prints the exact child invocations -
> copy-pasteable `cd ... && node ...` lines - and exits without running anything. Children
> are always spawned as `node <absolute script>` from **your** project's `node_modules`
> (never a shell, never a cmd shim), so the CLI orchestrates the tool versions you installed
> and ships none of its own.

```sh
azeroth check --print
```

---

## Project shapes

There is no config file. The CLI detects your project's shape from what already exists:

- **frontend** - a vite config plus `azerothjs` (or `@azerothjs/compiler`).
- **backend** - an `@azerothjs/http` / `ws` / `cron` dependency, no vite config.
  Subdivides by how it must run: a decorator ORM (TypeORM etc.) means `tsc` must emit
  first (**built**); otherwise Node >= 22 runs the TypeScript source directly (**native**).
- **fullstack** - a directory whose children are exactly one frontend and one backend
  (`application/` + `server/`, `website/` + `api/`, ...). Ambiguity fails loud, and
  `--app <dir> --server <dir>` disambiguates.

---

## `azeroth dev` - the conductor

One command replaces the hand-written dev script and the second terminal: the server's
compiler watch (only when decorators demand one), `node --watch` on the emitted output -
gated on the first compile report, so the server starts exactly once - and vite, all inside
one designed frame:

```
  api build │ compiling...
  api build │ ✓ compiled clean
  api       │ 12:27:06 ● listening · http://localhost:5200 · env=development
  api       │ 12:27:09 ● GET /healthz → 200 · 0.48ms

  ✓ Ready in 4.2 s
    api  http://localhost:5200
    web  http://localhost:1420/
```

Fixed-width stream badges (one hue per app half), each tool's session chatter rewritten to
house style with the information intact. Everything real - diagnostics, HMR, your app's log
lines - passes through byte-intact, and colors survive the pipe. When the conductor itself
is piped (CI), output is plain and escape-free end to end. Ctrl+C tears the whole session
down with a one-line farewell.

`--raw` turns the discipline off - verbatim child output, no environment additions - for
when you are debugging the tools themselves. It adds no `NODE_ENV` either, so an app that
reads it boots in production mode under `--raw`: declare it yourself in the environment
(`$env:NODE_ENV='development'` on PowerShell, `NODE_ENV=development azeroth dev --raw` on a
POSIX shell). On a root that declares the dev capability below, the server half is the only
step, so without that variable the scaffold prints its `no SSR bundle on disk` line and
node's watcher sits waiting for a file change.

### One process, one origin

A fullstack root whose `package.json` declares the capability:

```json
"azeroth": { "dev": "server" }
```

runs the server half **alone**. That half serves the pages, the api and vite's HMR socket on one
origin, with vite living inside the process - the same `mountPages` route table and renderer
production uses, fed by vite instead of by a build. The conductor drops the web step and says so
above the frame, which then carries one url:

```
  ! the web step is dropped: the server half serves the pages and vite runs inside it, one origin
  api │ 12:27:06 ● listening · http://127.0.0.1:3000 · env=development

  ✓ Ready in 1.9 s
    api  http://127.0.0.1:3000
```

No second port, no proxy, nothing to keep in sync. The plan still checks that vite is installed -
the session loads the copy `@azerothjs/kit` resolves - so a missing vite is a plan error rather
than a page that fails at the first request. Without the field the conductor keeps both halves,
and halves named with `--app <dir> --server <dir>` cannot opt in: there is no root manifest to
read, and the plan's notes say that too.

---

## `azeroth doctor`

Each check is a distilled real-world failure: an unsupported Node version for the backend
stack, a decorator ORM without `emitDecoratorMetadata` (strip-only Node cannot run it), a
missing `@types/node` (the TS2591 flood), a stale editor extension against the installed
compiler, a stale `.azeroth/types` mirror, `@azerothjs/*` version skew across a fullstack
app's halves, and `shell: true` spawns in project scripts (the Windows argument-splitting
trap). Diagnosis only - doctor never mutates anything.

Two more cover the one-process dev session above:

- **dev capability** - the root declares `"azeroth": { "dev": "server" }`, so the server half has
  to create the session. An entry that never imports `@azerothjs/kit/dev` warns (a session
  factored out into a module the entry imports is fine, which is why it warns rather than fails).
- **dev vite** - the copy of vite the session will actually load, resolved the way node resolves
  it for `@azerothjs/kit` rather than by walking up from a half, reported by path and version
  beside both halves' declared ranges. It warns on a major other than 8, on ranges that disagree
  between the halves, and on a server half that declares no vite while the root declares the
  capability.

---

## Exit codes

`0` success | `1` a gate or child failed | `2` usage or detection error.

---

<div align="center">
<sub>Part of <a href="../../README.md">AzerothJS</a> | <a href="https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE">MIT License</a></sub>
</div>
