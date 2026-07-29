<div align="center">

<img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/tile-dark.png" alt="AzerothJS" width="120" />

# create-azeroth

**Scaffold a frontend, backend, or fullstack AzerothJS app with the whole toolchain wired.**

[![npm](https://img.shields.io/npm/v/create-azeroth?color=2ea44f)](https://www.npmjs.com/package/create-azeroth)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

</div>

---

Part of [AzerothJS](../../README.md) - the fine-grained, zero-dependency, fullstack
TypeScript framework. The scaffolder is the day-one path: two questions at most, then a
working app.

---

## ✨ What you get

- **The whole canon, wired** - the [`azeroth`](https://www.npmjs.com/package/@azerothjs/cli)
  CLI verbs as your npm scripts, eslint with the azeroth rules, and `azeroth-tsc` as the
  typecheck gate.
- **Two questions at most** - a name and a shape; opinions live in the templates, not in
  a questionnaire.
- **CI-safe** - pass both answers as arguments and it asks nothing.
- **Zero peers** - nothing to install first; `npm create azeroth@latest` is the whole
  entry point.

---

## 🚀 Usage

```sh
npm create azeroth@latest my-app
```

Then:

```sh
cd my-app
npm install
npm run dev
```

Non-interactive (CI) - pass the shape explicitly; options come only from flags:

```sh
npm create azeroth@latest my-app -- --template fullstack --tailwind
```

> [!NOTE]
> `npm create azeroth` is the canonical entry (it resolves this package,
> `create-azeroth`). Do not use `npx azeroth` to start a project - the bare `azeroth`
> name on npm is an unrelated package. The real `azeroth` CLI comes with your scaffolded
> app as [`@azerothjs/cli`](https://www.npmjs.com/package/@azerothjs/cli) and runs
> locally via `npx azeroth dev` inside it.

---

## 🧱 Templates

| Template | What it scaffolds |
| --- | --- |
| `frontend` | A vite app in `.azeroth` components: the compiler plugin wired, eslint with the azeroth rules, `azeroth-tsc` as the typecheck gate. |
| `backend` | An `@azerothjs/http` server with **no build step** - Node >= 24 runs the TypeScript source directly, and `azeroth dev` is `node --watch`. |
| `fullstack` | `application/` + `server/` as npm workspaces under one root; one `npm run dev` runs both halves under one banner, with the vite proxy line in plain sight in `vite.config.ts`. |

Every template ships the [`azeroth`](https://www.npmjs.com/package/@azerothjs/cli) verbs
as its scripts - `dev`, `check`, `build`, `test` - and nothing else to configure. The
two shapes that run TypeScript with no build step (`backend`, `fullstack`) require
Node >= 24; `frontend` compiles through vite and runs on Node >= 22.

## 🧩 Options

A curated set per shape, asked as yes/no in interactive runs and passed as flags in CI:

| Option | Templates | What it adds |
| --- | --- | --- |
| `--router` | `frontend` | Pages + nav with the framework's **own** client-side router - a route table, two pages, and `<Link>` navigation, zero extra dependencies. |
| `--tailwind` | `frontend`, `fullstack` | Tailwind v4 via `@tailwindcss/vite` (no PostCSS config), with the starter's design tokens mapped to utilities through `@theme inline`. |

The two compose: `--router --tailwind` scaffolds the routed app styled with utilities.

---

<div align="center">
<sub>Part of <a href="../../README.md">AzerothJS</a> · <a href="https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE">MIT License</a></sub>
</div>
