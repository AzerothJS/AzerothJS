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

For a fullstack app, one command replaces the hand-written dev script and the second
terminal: the server's compiler watch (only when decorators demand one), `node --watch`
on the emitted output - gated on the first successful emit - and vite, all under one
banner with `[api]`/`[web]`-prefixed output. Ctrl+C tears the whole session down.

For a single-tool shape the honest thing happens: a frontend `azeroth dev` IS vite,
verbatim; a native backend IS `node --watch src/main.ts`. The banner says so.

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
