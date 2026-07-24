<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />
</p>

# @azerothjs/cli

[![npm](https://img.shields.io/npm/v/%40azerothjs%2Fcli?color=2ea44f)](https://www.npmjs.com/package/@azerothjs/cli)

Part of [AzerothJS](https://github.com/AzerothJS/AzerothJS) - the fine-grained fullstack framework.
The `azeroth` command line: one verb per job, and nothing hidden.

## Install

```sh
npm install --save-dev @azerothjs/cli
```

## Commands

```
azeroth dev      Run the app in watch mode - the fullstack conductor
azeroth check    Every quality gate the project's shape demands
azeroth build    Deployable artifacts in dependency order
azeroth doctor   Diagnose the environment against the known failure catalog
azeroth info     A paste-able environment block for bug reports
```

There is no config file. The CLI detects your project's shape from what already exists:

- **frontend** - a vite config plus `azerothjs` (or `@azerothjs/compiler`)
- **backend** - an `@azerothjs/http`/`ws`/`api`/`cron` dependency, no vite config.
  Subdivides by how it must run: a decorator ORM (TypeORM etc.) means tsc must emit
  first (**built**); otherwise Node >= 24 runs the TypeScript source directly (**native**)
- **fullstack** - a directory whose children are exactly one frontend and one backend
  (`application/` + `server/`, `website/` + `api/`, ...); ambiguity fails loud, and
  `--app <dir> --server <dir>` disambiguates

## `azeroth dev` - the conductor

One command replaces the hand-written dev script and the second terminal: the server's
compiler watch (only when decorators demand one), `node --watch` on the emitted output -
gated on the first COMPILE REPORT, so the server starts exactly once - and vite, all
inside one designed frame:

```
  api build │ compiling...
  api build │ ✓ compiled clean
  api       │ 12:27:06 ● listening · http://localhost:5200 · env=development
  api       │ 12:27:09 ● GET /healthz → 200 · 0.48ms

  ✓ Ready in 4.2 s
    api  http://localhost:5200
    web  http://localhost:1420/
```

Fixed-width stream badges (one hue per app half), each tool's session chatter rewritten
to house style with the information intact - tsc's watch banners become `compiling...`
and `✓ compiled clean` / `✖ 3 errors`, node's restarts become `↻ restarting`, vite's
identity block folds into the composed ready frame. Everything real - diagnostics, HMR,
your app's log lines - passes through byte-intact. Colors survive the pipe: the
conductor forwards its terminal's capabilities to children (your own `NO_COLOR`,
`FORCE_COLOR`, and `AZEROTH_LOG` always win), and when the conductor itself is piped
(CI), output is plain and escape-free end to end. Ctrl+C tears the whole session down
with a one-line farewell.

`--raw` turns the discipline off - verbatim child output, no environment additions -
for when you are debugging the tools themselves.

## Transparency

Every orchestrating command takes `--print`: it prints the exact child invocations -
copy-pasteable `cd ... && node ...` lines - and exits without running anything.
There is nothing to eject because nothing is hidden. Children are always spawned as
`node <absolute script>` from YOUR project's node_modules (never a shell, never a
cmd shim), so the CLI orchestrates the tool versions you installed and ships none of
its own.

## `azeroth doctor`

Each check is a distilled real-world failure: Node < 24 for the backend stack, a
decorator ORM without `emitDecoratorMetadata` (strip-only Node cannot run it), a
missing `@types/node` (the TS2591 flood), a stale editor extension against the
installed compiler, a stale `.azeroth-types` mirror, `@azerothjs/*` version skew
across a fullstack app's halves, and `shell: true` spawns in project scripts (the
Windows argument-splitting trap). Diagnosis only - doctor never mutates anything.

## Exit codes

`0` success · `1` a gate or child failed · `2` usage or detection error.

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
