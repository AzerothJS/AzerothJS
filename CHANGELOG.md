# Changelog

All notable changes to AzerothJS are documented here. The monorepo is versioned in
lockstep: one version covers every `@azerothjs/*` package, the `azerothjs` entry
package, and both editor integrations.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org).

## [Unreleased]

The terminal-experience release: `azeroth dev` becomes a designed frame instead of a
pipe multiplexer, and the logger's developer face renders meaning instead of strings.

### Added

- **cli**: the dev conductor's line discipline - fixed-width colored stream badges
  (one hue per app half, dim `│` gutter), blank lines swallowed, each tool's session
  chatter rewritten to house style with its information intact (tsc watch banners →
  `compiling...` / `✓ compiled clean` / `✖ N errors`; node --watch lifecycle →
  `↻ restarting` / `crashed`), vite's identity block folded into one composed
  `✓ Ready in ...` frame listing every half's URL, and a one-line farewell on Ctrl+C.
- **cli**: `azeroth dev --raw` - verbatim child output, no environment additions,
  for debugging the tools themselves.
- **cli**: capability propagation - children keep their colors and pretty log faces
  under the conductor's pipe (`FORCE_COLOR` tier + `AZEROTH_LOG=pretty`, forwarded
  only when the conductor itself is on a TTY and never overriding the user's own
  environment); a piped/CI conductor stays byte-clean end to end.
- **cli**: `check`/`build` gained dim step headings and a closing verdict line
  (`✓ all checks passed` / `✓ build complete`).
- **logger**: `prettySink({ hide })` - context fields a human should not re-read on
  every line (a constant `service`, a `requestId`) can be hidden from the pretty
  face only; NDJSON faces and files always keep every field.
- **logger**: semantic values on the pretty face - `http(s)://` URLs render in the
  brand ice-blue, `status` codes as verdicts (2xx green / 3xx cyan / 4xx yellow /
  5xx red), request methods in their REST colors.
- **logger**: request sentences - a record shaped like `logRequests` output renders
  as `GET /healthz → 200 · 0.48ms` instead of `key=value` scaffolding; incomplete
  shapes (or hiding any ingredient) fall back to ordinary pairs.

### Changed

- **cli**: the server half of a dev session now starts on tsc's first compile
  report instead of a file-existence heuristic - one compile, one boot, no doubled
  `listening` line; tsc watch runs `--pretty` (colored diagnostics under the pipe)
  and node runs `--watch-preserve-output` (a child must not reset the terminal).
- **cli**: the live dev view no longer echoes full child command lines - `--print`
  remains the transparency surface, `--raw` still echoes them.
- **cli**: `doctor` verdict marks joined the glyph vocabulary (`✓`/`✖`/`−` with
  ASCII fallbacks).
- **logger**: the pretty face's calm rules - seconds-only dim clock (sub-second
  precision lives in measured fields), bold messages, `info` drops its level word
  (the icon carries it) while warn/error keep theirs with level-tinted messages,
  field pairs hang off dim interpuncts, and the tautological `url=` label drops
  before a URL value. Display only: values are never altered.
- **logger**: quiet text renders as a real gray at 256/truecolor tiers instead of
  ANSI faint, which several Windows console hosts draw as plain - the dim/bold
  hierarchy now survives every terminal.
- **logger**: `supportsUnicode()` is true on every Windows console a supported Node
  can run in (the env-marker allowlist was obsolete), and `colorTier()` recognizes
  the JetBrains terminal and defaults a bare Windows TTY to truecolor.

### Fixed

- **cli**: the dev supervisor no longer loses child colors, prints doubled boot
  lines, or lets `node --watch` clear the terminal on restart.
- **logger**: `logRequests` documentation taught a silent-terminal configuration
  (`stream: fileStream(...)` with no tee); the README now shows the tee recipe.

## [1.0.0-beta.1] - 2026-07-24

The first 1.0 beta. The framework becomes a full stack with one entry point: a
scaffolder (`npm create azeroth`), a CLI that understands every project shape, an
error pipeline and middleware model apps can shape without forking, and a logger
that persists. Everything below rode through the production pass: every new package
hardened file by file, every gate green (2017 tests), all 23 packages publint-clean.

### Added

- `@azerothjs/logger`: log files. `fileStream(target)` is a buffered NDJSON writer -
  point it at a file to append forever, or at a folder for day-named files with
  size rotation and retention. Rotation is RENAME-FREE (a new name opens; the old file
  stops growing), the design that is correct on Windows where open files cannot be
  renamed. Lines batch in a bounded buffer and land on a size threshold, a flush
  interval, `flush()`/`close()`, and process exit; overflow and write failures DROP and
  are counted (one stderr notice + an in-band `log lines dropped` record on recovery) -
  logging never blocks the event loop and never breaks the app. `fileSink()` is the
  record-level form and `teeSink(...sinks)` fans out with per-sink throw isolation
  (pretty console + file is the canonical pair). Used as the logger's `stream`, the
  fused fast path is untouched: emit benchmarks are unchanged, and file throughput
  measured ~10x pino's default file destination (~6x its async mode, at a fraction of
  the memory) on the reference machine.

- `@azerothjs/cli`: the `azeroth` command line - `dev` (the fullstack conductor: compiler
  watch when decorators demand one, `node --watch` gated on the first emit, and vite, under
  one banner with prefixed output), `check` (every gate the project's shape demands),
  `build` (artifacts in dependency order; a native backend deliberately has none), `doctor`
  (a catalog of real-world failure diagnoses), and `info`. No config file - the project's
  shape (frontend / backend native-vs-built / fullstack) is detected from what already
  exists, and ambiguity fails loud with `--app`/`--server` to disambiguate. `--print` on any
  orchestrating command prints the exact child invocations and exits: children are always
  `node <absolute script>` from the project's own node_modules - never a shell, never a cmd
  shim - so there is nothing hidden and nothing to eject.
- `create-azeroth`: `npm create azeroth@latest` - the day-one path. Three templates
  (frontend / backend / fullstack), at most two questions, opinions in the templates
  instead (eslint with the azeroth rules, the `azeroth-tsc` gate, the CLI verbs as
  scripts, the vite proxy line in plain sight). The backend template has no build step;
  the fullstack template is `application/` + `server/` workspaces under one root where
  one `npm run dev` runs both halves.

- `@azerothjs/http`: `new App({ serializeError })` reshapes the error wire body so an app can
  speak its own envelope (`{ success, code, field, message }`, JSON:API, ...) without
  reimplementing the one error path. The hook returns a plain value to replace the body (the
  kernel keeps the error's status and mandated headers - a 405 `Allow`, a 429 `Retry-After`), a
  `Response` for full control, or `undefined` to keep the default `{ error: { code, message } }`.
  It applies uniformly to every error, route-miss 404s included; a throwing serializer falls back
  to the default shape, so the last-resort error path can never break.
- `@azerothjs/http`: `app.with(middleware)` opens a SCOPED registration view - the middleware runs
  only for the routes registered through the returned app, not globally like `use`. It shares the
  parent's route table, chains (`app.with(throttle).with(auth).get(...)`) with full context-type
  accumulation, and never mutates the parent (a later `app.use` does not reach into an already-opened
  fork). Removes the per-handler guard-call boilerplate when only some routes need auth/throttle.

## [0.9.0-beta.4] - 2026-07-21

### Added

- The backend stack is now published to npm: `@azerothjs/http` (web-standard
  HTTP kernel), `@azerothjs/ws` (RFC 6455 WebSockets), `@azerothjs/api`
  (contract-first, type-safe API layer), and `@azerothjs/cron` (zero-dependency
  scheduler). They were previously private and consumable only via vendored
  tarballs; a clean `npm install @azerothjs/http` now resolves.

## [0.9.0-beta.3] - 2026-07-20

### Added

- `azeroth/unsafe-narrow-in-show` lint rule: flags `guard()!.x` inside a
  `<Show when={ guard() }>` whose children read the guarded value a second time
  via non-null assertion instead of using the callback form. That second read is
  independent of the one `when` already checked and can observe `null` even
  while the branch is mounted - `!` is erased at compile time, so it gives no
  runtime protection. Surfaces through `eslint .`, the Vite build, and editor
  diagnostics alike, with no separate wiring (it lives in the shared markup
  lint pass all three already read from).

### Fixed

- Reactive DOM attribute bindings written as a function literal or a bare
  getter reference (`class={ () => ... }`, `class={ computeClass }`) now
  update correctly. Dependency analysis cannot see reactive reads hidden
  inside those forms, so they previously rendered once and silently stopped
  reacting.
- `<ErrorBoundary>` no longer crashes ("insertBefore: parameter 1 is not of
  type 'Node'") when `children`/`fallback` resolves to a thunk chain (a
  function returning a function) instead of an already-built node.
- The Vite dev server's incremental type checker no longer serves stale
  diagnostics after editing a plain `.ts` dependency mid-session - file
  watcher changes now invalidate the checker's cached snapshot instead of
  pinning to the first-seen copy for the rest of the session.
- Same-line whitespace between inline markup children (`{ label } <span>`) is
  preserved as a single space instead of being dropped, which previously
  fused neighboring inline content together.
- `<Transition>` now warns once when its target has `display: contents`
  (which generates no box, so transform/opacity never paint and
  `transitionend` never fires) instead of silently snapping at the timeout
  fallback with no explanation.
- The packaged VS Code extension ships with its icon again (a missing build
  step left it out).

## [0.9.0-beta.2] - 2026-07-19

### Fixed

- Renderer `bindContent` now resolves a `children` thunk to its node instead of
  stringifying the function, so a component handed a function-returning-node as
  its children renders correctly.

## [0.9.0-beta.1] - 2026-07-19

### Added

- Route transitions: `<Routes transition="page">` animates route swaps with
  `<Transition>`'s 6-class family - the outgoing route plays its leave (removal
  deferred until it completes) while the incoming enters alongside, so cross-fades
  and directional drifts are pure CSS. The function form receives
  `{ from, to, navigation }` and returns a name per swap (or null for instant),
  and the new `router.navigationKind()` reports what caused each change
  (`'push' | 'replace' | 'pop'`) - a back-navigation can animate differently
  than a forward one. Rapid navigation flushes still-leaving routes instantly.
- `<TransitionGroup>`: keyed list enter/leave animation - items play the enter
  family when their key joins and the leave family (removal deferred) when it
  departs. The primitive toast stacks and notification trays hand-roll today.
- Virtualization: `createVirtualizer` (headless, equality-guarded window memo -
  scrolling within the same window is a reactive non-event, closing the
  re-slice-per-scroll-frame trap) and `<VirtualList>` (the packaged vertical
  scroller: spacer, absolute row positioning, keyed reuse). Fixed row size and
  explicit viewport height in v1.
- [`@azerothjs/logger`](packages/logger), the framework's voice: one zero-dependency
  logger with two faces - colored, iconed developer output on a TTY and pino-class
  NDJSON in production - with child loggers whose bound context serializes once,
  free disabled levels (below-threshold methods ARE a no-op), field redaction that
  runs before any sink, Error serialization with the full `cause` chain, honest
  color rules (NO_COLOR/FORCE_COLOR/TTY), a browser console face, and
  `AZEROTH_LOG` environment control. Measured ahead of pino on every emit path and
  ~10x ahead of winston. It also ships the AzerothJS startup banner: `serve()` now
  announces the bound addresses and measured ready time on a dev terminal (silence
  it with `banner: false`; it is always silent piped or in production), the Vite
  dev server prints the same identity with the compiled component count, and
  `attachWebSockets` and the cron scheduler take a structural `logger` for
  lifecycle visibility (connections; job runs, overlap skips, failures) without
  either package gaining a dependency. The repository also carries the project
  mark (`assets/`) - now the VS Code extension icon AND the JetBrains plugin
  icon. The frontend runtime packages deliberately stay logger-free: hot-path
  browser code carries no logging weight.
- `jsonEncoder(schema)` in `@azerothjs/http`: compiles a response declaration (the same
  `@azerothjs/schema` combinators that validate request bodies) into a shape-specialized
  JSON serializer - key strings prebuilt, primitive fields quoted inline behind an
  escape guard, byte-identical output to `json(data)` for declared shapes, with
  JSON.stringify fallback for anything the declaration cannot describe. The
  declaration-driven twin of `readValidated`: one reads the boundary through the
  schema, the other writes it. Schema combinators now carry internal structural
  metadata to make this compile-from-declaration possible.
- Client-only builds: `azeroth({ ssr: false })` compiles every component without
  its SSR/hydration branch and substitutes a constant render mode, so the SSR
  machinery minifies out of the bundle entirely - the js-framework-benchmark app
  dropped from 24.0 kB to 16.1 kB (5.4 kB gzip). Leave the default on for any app
  that calls `renderToString`/`hydrate`.

### Changed

- `<Transition>` now CANCELS a mid-flight run when toggled instead of queueing:
  a half-entered sheet reverses from exactly where it is (same element, state
  preserved) - rapid open/close feels crisp instead of "finish, then reverse".
- Every class across the packages now keeps its internals in native `#` private
  fields instead of TypeScript's erased `private` keyword: internals are genuinely
  unreachable at runtime, so nothing internal can silently become load-bearing
  API. Code that reached into undocumented members via casts will now find them
  gone - they were never API.
- Compiled markup got materially faster, measured on
  [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark)
  (keyed): CPU geometric mean went from 1.29x to 1.07x of hand-written vanilla
  DOM, ahead of React, Angular, and Vue and even with Solid and Ripple, with the
  field's best select-row, swap-rows, and first-paint numbers. The work behind it:
  - A text hole that is its element's only child (`<td>{ row.id }</td>`) compiles
    anchor-free: one text node driven in place, no comment-marker pair per hole.
  - A `<For>` row expression with no reactive reads (`{ row.id }`) binds once
    instead of carrying a per-row effect; reactivity is decided by expression
    shape, so getter calls (`{ row.label() }`) stay live.
  - Compiled event handlers on bubbling event types are now DELEGATED to one
    document-level listener per type (matching the documented template-path
    contract); non-bubbling types keep per-element listeners.
  - `<For>` clears and full replacements collapse to one bulk `textContent`
    write when the list spans its parent, and a two-row swap reconciles with two
    moves instead of a position map and LIS pass.
  - `destroyComponent` returns in constant time when no element anywhere holds a
    destroy hook - removing a thousand hook-free rows no longer walks each
    subtree.
  - Devtools registration records are only allocated while a devtools hook is
    attached, taking a per-signal/effect/root allocation off the hot paths.
  - A single `class:` toggle compiles to a bare conditional instead of an
    array/filter/join per evaluation.
- `@azerothjs/http` got faster on the wire, measured against Express, Koa, NestJS,
  and Fastify with autocannon (100 connections, interleaved same-machine A/B):
  ahead of Express/Koa/Nest on every scenario by wide margins, and ahead of
  Fastify on the five-scenario geometric mean (~4%) - winning JSON echo (+14%),
  param routes (+9%, via `jsonEncoder`), and 404 (+14%), behind only on
  hello-world (-9%) and a 5-deep middleware chain (-5%). Part of the hello gap is
  the per-request reactive root (request-isolated stores + guaranteed cleanup,
  which the others do not offer; measured at ~3%, opt out with
  `new App({ requestRoot: false })`). The work behind it:
  - Response bodies now travel as STRINGS all the way to the socket, where Node
    encodes natively during the write - no TextEncoder pass, no byte-array
    allocation per response; Content-Length comes from a native byte count.
    `PayloadResponse` encodes lazily for anything that genuinely reads bytes.
  - The per-route middleware chain runs SYNCHRONOUSLY while middlewares return
    plain values - no microtask hop per middleware per request; the first
    thenable result switches that request onto the promise path unchanged.
  - The request root stopped allocating per request: the dispatch closure and
    cleanup-error options are per-app now, and the cleanup registry only exists
    once a handler registers teardown.
  - Dispatch runs synchronously end to end for a handler that returns a plain
    Response - no promise machinery until something genuinely asynchronous
    (an async handler, or HEAD body cancellation) enters the path.
- `@azerothjs/ws` measured against the `ws` library and socket.io (echo, 1000-way
  broadcast, connection churn, 5000 idle connections): ahead of socket.io on every
  line, ahead of `ws` on single-connection echo and idle memory (-11%), even on
  the rest - no code changes needed.

## [0.8.0-beta.2] - 2026-07-17

### Changed

- `<Match when>` accepts any value and matches while it is truthy, exactly like
  `<Show when>` - `when={ phase() === 'connected' && activeConfig() }` no longer
  needs an explicit boolean coercion.
- CJS bundles (tsserver plugin, VS Code server) carry a real `import.meta.url`,
  anchoring native-TypeScript resolution at the installed bundle instead of the
  process working directory.
- Release flow retries the editor-lockfile sync while the npm registry catches up
  with a fresh publish, and runs it on resumed (`--no-bump`) releases too.

### Fixed

- Editor/CI type checking: a function literal passed to a factory prop
  (`<ErrorBoundary fallback={ (error, reset) => ... }>`) now takes its parameter
  types from the prop's declared signature instead of falling to implicit `any`
  under a strict tsconfig.
- Docs: `<For>`'s keyed row reuse - and how to keep row values live through
  getters - is now documented in the renderer README.

## [0.8.0-beta.1] - 2026-07-16

### Added

- The backend, published for the first time: [`@azerothjs/http`](packages/http)
  (zero-dependency, web-standard HTTP kernel - every request is a reactive root),
  [`@azerothjs/schema`](packages/schema) (validation whose TypeScript types are
  inferred from the declaration, shared by browser forms, the api client, and the
  server boundary), [`@azerothjs/api`](packages/api) (declare a contract once, get
  the server mount and a fully inferred client), [`@azerothjs/ws`](packages/ws)
  (RFC 6455 WebSocket server from scratch), and [`@azerothjs/cron`](packages/cron)
  (cron scheduling with honest timezone/DST semantics). Each stands alone; a
  backend-only service needs no frontend packages.
- Markup lint with autofix: spacing/punctuation rules for `.azeroth` interpolations
  run in the compiler's build-time lint and through the ESLint processor, and are
  fixable with `eslint --fix`.

### Changed

- **BREAKING:** `azerothjs` (unscoped) is now the framework's entry package and the
  compiler's code-generation target. Install `azerothjs` instead of `@azerothjs/core`
  and import from `'azerothjs'`; `@azerothjs/core` is removed and receives no further
  releases.
- **BREAKING:** a component with more than one top-level markup region is now a
  compile error (`azeroth/multiple-roots`). Previously every region except the last
  was silently discarded; wrap siblings in a single root element instead.
- Published type declarations are now compiled under `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, and `isolatedDeclarations`: optional properties where
  absent and `undefined` mean the same thing are spelled `| undefined`, and indexed
  reads are guarded throughout the runtime.
- Validation rules (`required`, `email`, `phone`, the `countries` dataset, ...) moved
  to `@azerothjs/schema` as the single source of validation truth; `@azerothjs/form`
  re-exports them, so existing imports keep working.
- Mount points and route components are typed as `MountNode`
  (`HTMLElement | DocumentFragment`), so a component may render a fragment.
- Release flow publishes to npm before pushing the tag, so CI triggered by the push
  always finds the released versions on the registry.
- All READMEs rewritten for npm: root front page, `azerothjs` flagship page (now
  covering the server side), and per-package pages with install instructions;
  non-ASCII punctuation removed from authored text repo-wide.

### Fixed

- Compiler: a markup child expression starting on the line after its opening `{`
  compiled to a bare `return;` (JavaScript ASI), silently dropping the child - the
  classic symptom was `<For>` failing with "renderItem is not a function". Generated
  returns are parenthesized now, with a regression test.
- Reactivity: a truthy non-function value returned from an effect body (for example
  `createEffect(() => list.push(x))` - `push` returns a number) was registered as a
  cleanup and crashed the next run's cleanup pass; non-function returns are ignored.
- `.azeroth` parser: HTML comments (`<!-- -->`) now fail with a specific, actionable
  message instead of a generic markup parse error.
- Compiler README documented the explicit-dependency effect as `watch (deps)`; the
  keyword is `effect (deps)`.

## [0.7.0-beta.1] - 2026-07-02

### Added

- `form` keyword: first-class forms in `.azeroth` (`form f = shape with { ... }`),
  including the array form `form rows[]` for dynamic lists of repeated sub-forms.
- Form engine: cross-field validation (`validateForm`), per-field async validation
  (`validateAsync` with AbortSignal + debounce), numeric field coercion, and
  `createFieldArray`.
- Cross-language editor intelligence: Find References / Go to Definition / Rename
  across the `.ts` and `.azeroth` boundary in both editors, with result spans mapped
  to real source positions.
- `reactive` semantic-token modifier: names declared by reactive keywords get a
  distinct, themeable color in VS Code and JetBrains.
- JetBrains: usage-aware inspections (a `.ts` export used only from `.azeroth` files
  is no longer flagged unused) and `.azeroth`-aware Find Usages.
- Generated type projections (`.azeroth/types` mirror with declaration maps) so
  editors without tsserver-plugin support resolve `.azeroth` imports with full types.
- CI: editor plugins built, verified (JetBrains Plugin Verifier), and attached to
  GitHub Releases; typecheck and coverage gates.

### Changed

- **BREAKING:** published packages require Node >= 24.
- `props {}` blocks removed: component props are standard TypeScript parameters.
- `watch` folded into `effect (deps)`; `bind:` on components lowers to
  `value` + `on<Prop>Change`.

## [0.6.0-beta.1] - 2026-06-21

- Component-only `.azeroth` authoring model, unified compiler IR, and the rebuilt
  editor tooling stack (language service, language server, VS Code extension,
  JetBrains plugin, tsserver plugin, ESLint processor).

[Unreleased]: https://github.com/AzerothJS/AzerothJS/compare/v0.9.0-beta.4...HEAD
[0.9.0-beta.4]: https://github.com/AzerothJS/AzerothJS/compare/v0.9.0-beta.3...v0.9.0-beta.4
[0.9.0-beta.3]: https://github.com/AzerothJS/AzerothJS/compare/v0.9.0-beta.2...v0.9.0-beta.3
[0.9.0-beta.2]: https://github.com/AzerothJS/AzerothJS/compare/v0.9.0-beta.1...v0.9.0-beta.2
[0.9.0-beta.1]: https://github.com/AzerothJS/AzerothJS/compare/v0.8.0-beta.2...v0.9.0-beta.1
[0.8.0-beta.2]: https://github.com/AzerothJS/AzerothJS/compare/v0.8.0-beta.1...v0.8.0-beta.2
[0.8.0-beta.1]: https://github.com/AzerothJS/AzerothJS/compare/v0.7.0-beta.1...v0.8.0-beta.1
[0.7.0-beta.1]: https://github.com/AzerothJS/AzerothJS/compare/v0.6.0-beta.1...v0.7.0-beta.1
[0.6.0-beta.1]: https://github.com/AzerothJS/AzerothJS/releases/tag/v0.6.0-beta.1
