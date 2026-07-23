<p align="center">
    <img src="https://raw.githubusercontent.com/AzerothJS/AzerothJS/main/assets/logo-transparent.png" alt="AzerothJS" width="120" />
</p>

# create-azeroth

[![npm](https://img.shields.io/npm/v/create-azeroth?color=2ea44f)](https://www.npmjs.com/package/create-azeroth)

Scaffold an [AzerothJS](https://github.com/AzerothJS/AzerothJS) app.

```sh
npm create azeroth@latest
```

Two questions at most - a name and a shape - then:

```sh
cd my-app
npm install
npm run dev
```

## Templates

- **frontend** - a vite app in `.azeroth` components: the compiler plugin wired,
  eslint with the azeroth rules, `azeroth-tsc` as the typecheck gate.
- **backend** - an `@azerothjs/http` server with **no build step**: Node >= 24 runs
  the TypeScript source directly; `azeroth dev` is `node --watch`.
- **fullstack** - `application/` + `server/` as npm workspaces under one root; one
  `npm run dev` runs both halves under one banner, and the vite proxy line that wires
  them is in plain sight in `vite.config.ts`.

Every template ships the [`azeroth`](https://www.npmjs.com/package/@azerothjs/cli)
verbs as its scripts - `dev`, `check`, `build` - and nothing else to configure.
Non-interactive use (CI): `npm create azeroth@latest my-app -- --template fullstack`.

## License

[MIT](https://github.com/AzerothJS/AzerothJS/blob/main/LICENSE)
