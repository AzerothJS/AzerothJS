# Changelog

All notable changes to AzerothJS are documented here. The monorepo is versioned in
lockstep: one version covers every `@azerothjs/*` package, the `azerothjs` entry
package, and both editor integrations.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed (pre-1.0 release review)

An adversarial review against the built/packed distribution found and this release fixes:

- **A prop-less `<C/>` no longer crashes** a component that reads its props. The prop-less-tag
  optimization emits `C()`; the component now takes `props = {}`, so a defaulted/optional-props
  component used with no attributes renders instead of throwing `Cannot read properties of undefined`.
- **A builtin's `fallback` prop is no longer double-wrapped.** The compiler wrapped
  `fallback={(error, reset) => ...}` in an extra `() => (...)` thunk, so `<ErrorBoundary>` received
  `undefined` for its error/reset and `<Routes fallback>` crashed (blank app on any unmatched URL).
  A function-literal fallback now passes through; a bare-markup fallback is still wrapped.
- **Block-bodied render callbacks stay reactive.** A hole in markup returned from
  `{(row) => { ...; return <span>{ signal }</span>; }}` was emitted as a one-shot value and never
  updated; it is now wrapped in a getter like the expression-bodied form.
- **Component props parameters lower correctly.** A parameter named anything other than `props`
  (`component C(p: P)`) and NESTED destructuring (`{ pos: { x, y } }`) now work; a **rest element**
  (`{ a, ...rest }`) is rejected with a located `azeroth/unsupported-props-rest` error instead of
  silently emitting code that reads an unbound `rest`.
- **A fragment-root component mounts.** `component F { <>...</> }` returned a bare array that crashed
  `render()` and serialized to `[object Object],...`; `render()` and `renderToString()` now handle a
  multi-node root as direct children.
- **HTML character references in text are decoded.** `&amp;`/`&lt;`/`&nbsp;`/`&copy;`/`&mdash;`/`&#38;`
  render as their characters (matching HTML/JSX/Vue/Svelte) instead of as literal entity text.
- **Cross-field `validateForm` errors clear.** A field flagged only by `validateForm` that returns the
  documented partial map (`{}` when valid) now clears once the fields agree, so a fixed
  password-confirm form becomes valid; previously it stayed `isValid() === false` forever.
- **`@azerothjs/schema` `record()` is prototype-pollution safe.** An untrusted `__proto__` key is
  stored as an own property (via `defineProperty`) instead of invoking the prototype setter, so it
  neither poisons the parsed object nor is silently dropped.
- **Devtools no longer leaks signals.** With a hook attached, a disposed component's signals are now
  swept from the registry when their root disposes (signals have no disposal event of their own), so
  a long dev session no longer grows unbounded and the graph snapshot returns to baseline.
- **The reactive graph no longer pins a disposed consumer.** `track()`'s dedup cache
  (`producer.seenConsumer`) is cleared when that consumer unlinks, so a long-lived signal does not
  retain an unmounted reader's closure.
- **Internal package dependencies use `^1.0.0`, not an exact pin**, so a patch to one framework
  package no longer forces a duplicate copy of another in a consumer's tree.
- **Every package exports `./package.json`** (tools that `require.resolve('pkg/package.json')` work),
  and `@azerothjs/kit` declares `"sideEffects": false`.
- **create-azeroth templates run on first `npm run dev`.** The backend and fullstack templates
  imported `fileStream` from `@azerothjs/logger` (it lives on `@azerothjs/logger/node`); the fullstack
  root `npm start` now runs the server from its own workspace so the production command boots.
- **Source maps are line-accurate.** The compiler emitted one coarse mapping for a whole component, so
  a runtime throw's stack, a debugger breakpoint, and the devtools' creation-line attribution all
  resolved to the component's declaration line instead of the real construct. Each emitted construct
  (state/derived/effect/form/factory and the markup) now carries its own source anchor, so a `derived`
  resolves to its own `.azeroth` line.
- **Route-change focus no longer draws a stray focus ring around the page.** After a navigation the
  router moves focus into the new route for keyboard and screen-reader users; when the app has not
  marked a `[data-route-focus]` target it focuses the content root via a transient `tabindex="-1"`,
  which drew the browser's default focus ring around the whole region (a two-tone box that read as a
  stray window border, most visibly after a keyboard-driven navigation). The router now tags that
  fallback region with `data-azeroth-route-focus-fallback` for the duration of the programmatic focus
  and injects one overridable, author-level stylesheet rule that hides the ring for it - never touching
  the element's inline styles. An app-marked `[data-route-focus]` target is left entirely alone and
  stays fully stylable.

### Added

- **`@azerothjs/devtools` rewritten as a primitive-aware inspector.** The panel now speaks
  the authoring language: each declared `form`/`resource`/`store`/`stream`/`selector`/
  `deferred` renders as ONE named, collapsible group with a live status badge (a resource
  shows pending/ready/error, a form valid/invalid/submitting), and bare `state`/`derived`/
  `effect` rows carry their declared names and current values. New chrome: an icon rail
  (Components / Timeline / Graph / Performance / Server / Settings), a search-first toolbar
  (Ctrl+K), an adaptive master-detail inspector (right pane wide, bottom drawer narrow), a
  windowed components list that stays smooth at thousands of nodes, burst-grouped timeline
  rows, and empty states that teach. Persisted layout state is validated and clamped on
  every restore, so a saved geometry can never come back off-screen.
- **Devtools hook protocol v2** (`azerothjs`, additive). Nodes carry `primitive`/`group`/
  `groupName` so higher-level primitives are attributable to their internals, and
  `DevtoolsHook.run(id, cause)` reports the DIRECT producer whose change triggered each run
  (the timeline's `run values <- email` is measured, not inferred). The higher-level
  constructors gained an optional `name` option (`createStore` gained an options parameter);
  `on()` accepts `{ name }` too. Zero-cost-when-detached is unchanged.
- **Keyword names flow to devtools automatically.** On the dev server the compiler passes
  every reactive keyword's declared identifier as its debug name (`state count` ->
  `createSignal(0, { name: "count" })`); an explicit `with { name }` wins, and `store` now
  accepts a `with { ... }` options clause. Every keyword's `with { name }` completes and
  documents in both editors. Production output is byte-identical to before.
- **Server inspection bridge** (`@azerothjs/devtools/server`). `attachDevtools(served.server)`
  exposes a dev-only WebSocket (`/__azeroth/devtools`) streaming the server's reactive graph -
  requests are reactive roots - and the panel's Server tab mirrors it live with the same
  components view and inspector. Refuses to run under `NODE_ENV=production`; browser
  connections are limited to localhost origins by default. `@azerothjs/ws` becomes an
  optional peer of the devtools package.

### Changed

- **`@azerothjs/logger` is now browser-safe at its main entry.** `createLogger` and the sinks
  (`prettySink`/`ndjsonSink`/`consoleSink`/`teeSink`), the banner, serialization, and the color
  utilities load in a bundler without touching a Node builtin, so a frontend can `createLogger()`
  for structured console output. The Node-only pieces moved to a `@azerothjs/logger/node`
  subpath: the file sinks (`fileStream`/`fileSink`, which use `node:fs`/`node:path`) and the
  terminal prompts (`select`/`textInput`/`intro`/`outro`, which use `node:readline`). Update
  server/CLI imports of those to `@azerothjs/logger/node`; everything else is unchanged. This
  fixes a Vite "Module node:path has been externalized for browser compatibility" crash when a
  client imported the logger.

### Fixed

- **`@azerothjs/devtools` panel is now isolated in a shadow root.** The panel mounted as a
  light-DOM child of `<body>`, so the host app's global CSS (a Tailwind preflight `*{}` reset,
  a theme's inherited `color`, `border`, or `box-sizing`) leaked in and could collapse it to a
  broken white strip at the window edge. It now mounts inside an `attachShadow({ mode: 'open' })`
  host with its own base stylesheet, fully isolating it from - and from leaking into - the page.
  The host element is inert (out of flow, zero-size) so it can never shift the app's layout.
- **Hydration of element/list holes.** A reactive hole that returns an element or a list
  (`{cond ? <A/> : <B/>}`, `{items.map(...)}`) hydrated to the literal text
  `[object Object]` - the hole's `h()` output is a hydration descriptor in hydrate mode,
  and the hole driver stringified it instead of adopting the server nodes. It now adopts
  the server content on the first run, as `<Show>`/`<For>` already did.
- **Streaming responses run request cleanups at the stream's end**, not when the handler
  returns. `onRequestCleanup` teardown for a streaming body (SSE, static file, multipart,
  any `new Response(stream)`) previously fired while the stream was still producing,
  releasing a pooled connection/transaction mid-flight. Buffered responses are unchanged.
- **Hydration no longer falls back to a full client render** for elements rendered with
  `innerHTML`/`textContent` (their content is owned by the prop), or for a `<table>` whose
  `<tr>` rows the browser wrapped in an implicit `<tbody>` (now tolerated).
- **Owner/scheduler robustness.** A reactive node created under an already-disposed owner
  (the `runWithOwner(getOwner(), …)`-after-await pattern) is now torn down immediately
  instead of leaking; disposers registered *during* teardown run instead of being dropped;
  and a throwing effect no longer strands the rest of a flush - the others still run and the
  error surfaces after.
- **`{ secret: true }` config values** are redacted on the `console.log`/`util.inspect` path,
  not only `JSON.stringify` (added the `nodejs.util.inspect.custom` hook).
- **Compiler diagnostics for a missing `;` before markup.** `state count = 0` with no
  semicolon followed by markup silently dropped the markup and emitted broken JS; it is now
  an `azeroth/unterminated-declaration` error. Markup placed directly as a declaration value
  is flagged too.
- **`<script>`/`<style>` are parsed as raw-text (CDATA).** Their content (CSS, a JSON-LD
  `<script type="application/ld+json">`) is read verbatim and serialized unescaped, instead
  of being parsed for `{ … }` holes and HTML-escaped (which corrupted `&`/`<`).
- **`evalConstant`** no longer folds a multi-statement slice to its first expression,
  which silently dropped the remainder.
- Clearer errors for `<For each={…}>` with a nullish value (renders nothing) or a non-array,
  and for `renderToString(App())` called without the `() =>` thunk.

### Changed

- **`azerothjs` is now a ranged peer dependency** (`^1.0.0`) of `@azerothjs/http`,
  `@azerothjs/kit`, `@azerothjs/testing`, and `@azerothjs/devtools`, instead of an exact
  regular dependency. The runtime holds module-level state (the per-request store scope), so
  an exact pin let a version skew install a second copy and silently break request isolation;
  a ranged peer dedupes to one copy.
- **`typescript` is a required peer of `@azerothjs/compiler`** (no longer marked optional):
  the package eagerly loads TypeScript-backed analysis, so it was never truly optional.

## [1.0.0] - 2026-07-26

The first stable release. Every package, the `azerothjs` entry package, and both
editor integrations move to 1.0.0 in lockstep.

### Changed (production readiness)

- **engines**: the Node floor is now `>=22` (down from `>=24`) - Node 22 is Active LTS
  through 2027 and every published package runs on it. The zero-build backend's
  `node src/main.ts` needs unflagged native TypeScript (Node 22.18+, 23.6+, or 24),
  which `azeroth doctor` now checks precisely.
- **@azerothjs/compiler**: `lintMarkup(node, source, options?)` - the `source` argument is
  now required (was optional, which silently disabled the interpolation-spacing rule -
  a legacy call shape).
- **@azerothjs/eslint-plugin / language-server**: `azerothjs` is now an (optional) peer
  dependency of the compiler and language-server, so a compiler that emits imports for a
  runtime version the app doesn't have is caught by npm instead of a raw ESM error. The
  compiler's `vite` peer is `>=8` (it uses vite 8's `transformWithOxc`).

### Fixed (editor markup model)

- **@azerothjs/compiler**: a root markup element written directly after a reactive block -
  `effect { ... } <div>...`, `dispose { ... } <ul>...` - is now recognized as markup by the
  scanner (a block-closing `}` begins expression position), so the editor gives it semantic
  tokens, hover, and completion. It already compiled; only the editor's markup model missed it.

### Changed (drift-proofing)

- The language server's reactive-keyword set (semantic tokens), name-keyword set (hover), and
  void-element set (auto-close) now import the compiler's canonical tables instead of keeping
  hand-maintained copies, so a keyword or built-in added to the compiler can never be silently
  missed by the editor. The compiler's void-element list is now a single set (the scanner's),
  re-exported to the parser and tooling.

### Added (editor completeness)

- Hover documentation for the `bind:` / `class:` / `style:` directives.
- Completion snippet bodies for the `Dynamic` and `Outlet` built-ins (previously offered
  by name only). A new completeness spec welds the language server's built-in docs and
  snippets to the compiler's canonical `BUILTIN_COMPONENTS` list, so a built-in can no
  longer ship without both.

### Fixed (pre-1.0 audit round 2)

- **azerothjs**: the `stream` keyword produced code that crashed at first fetch. The
  compiler lowers `stream x = (v) => fetch(v) with { source }` to a positional
  `createStream(source, fetcher, options)` call (parallel to `createResource`), but
  the runtime only accepted a single options object - and the proving type error was
  silently dropped by the language server's diagnostics policy. `createStream` now has
  the same positional overloads as `createResource`; the emitted call type-checks and
  runs. Locked with positional-form tests.
- **@azerothjs/http**: `@seriousme/openapi-schema-validator` (used by an http test) is
  now a declared devDependency; it previously resolved only through a stale lockfile
  entry from the pre-fold layout, so a clean install would have broken the test. The
  9 leftover ghost workspace entries from folded packages were purged from the lockfile.
- **language-server**: the `effect (deps)` hover no longer shows a `watch (...)` example
  that the parser rejects (the `watch` keyword form no longer exists).

### Removed (dead / legacy code)

- **@azerothjs/http**: a dead `HttpError` re-export from `app.ts` (the package entry
  `index.ts` already exports it) - a leftover alias violating the no-legacy rule.
- Dead `export` modifiers on module-private helpers across azerothjs, cli,
  compiler, and language-server (symbols retained, public surface trimmed).
- **@azerothjs/compiler**: the duplicate `BUILTIN_COMPONENTS` list in `project.ts` now
  imports the canonical one from `builtins.ts` (was a hand-maintained twin that could
  drift from the runtime's actual built-ins).
- **@azerothjs/eslint-plugin**: dropped a redundant `azerothjs` peer (it flows through
  the compiler/language-server deps) and declared its real `typescript` peer.

### Fixed (pre-1.0 blocker sweep)

A from-scratch adversarial review found ten confirmed release-blockers, each
reproduced against the shipped build and each now fixed with a pinned regression test:

- **compiler (parser)**: a regex literal or an apostrophe inside a markup hole no
  longer breaks compilation. The brace scanner (`skipBalanced`) was blind to regex
  literals and to embedded markup, so `<p>{ name.replace(/'/g, '') }</p>` or an
  apostrophe in nested markup text (`{ ok ? <span>Don't</span> : ... }`) desynced
  the scan and hard-failed the build with a bogus "Unclosed tag". The scanner now
  consumes regex literals (disambiguated from division by the preceding token) and
  markup regions as whole units.
- **azerothjs (reactivity)**: `createEffect`/`createMemo` now re-establish their
  CREATION owner and error handler around EVERY run, not just the first. Previously
  a re-run inherited whatever scope triggered it, so `useContext` bled across
  components, `getOwner()` returned null on re-runs, and `<ErrorBoundary>` missed
  throws from dynamically-mounted children.
- **azerothjs (SSR)**: attribute NAMES are validated during serialization - a prop
  key containing a quote, space, or `>` (an injection attempt to break out of the
  attribute context) is now rejected, mirroring the DOM path's `setAttribute`.
  Previously such a name was emitted raw, injecting a live handler (XSS).
- **azerothjs / @azerothjs/kit (router + SSR)**: a guard that returns `false` no
  longer leaks its protected page. `matchAndLoad` now returns a distinct blocked
  result (and separate not-found/redirect arms) instead of collapsing a veto into
  `null`; `createPageRenderer` maps it to a 403 that renders NOTHING, and a
  no-match renders the app's fallback at a real 404 - `PageResult` gained a `status`.
  Previously a vetoed SSR route was served as a rendered 200 (authorization bypass).
- **azerothjs (router)**: a synchronous `redirect()` from a guard on the initial URL
  no longer crashes `createRouter` with a temporal-dead-zone `ReferenceError` (the
  auth deep-link pattern) - the navigation machinery the boot-time guard reaches is
  now declared ahead of the guard effect.
- **@azerothjs/http (kernel)**: `json`/`text`/`html` responses no longer drop all
  but one `Set-Cookie`. Cookies are carried apart from the header record (which
  cannot hold duplicates) so a session + a CSRF cookie both reach the client.
- **@azerothjs/http (static)**: `staticFiles` no longer follows a symlink out of the
  served root (a real-path containment check is enforced) and no longer serves
  dotfiles (`/.env`, `/.git/config`) - hidden files are 404 by default, with
  `.well-known` exempt and a `dotfiles` opt-in.
- **@azerothjs/schema**: `.optional().refine()` (and `.nullable()`) no longer throws
  a `TypeError` on an absent field. The optional marker now propagates through
  `refine`/`nullable`, and a refinement is skipped when the value is absent - an
  omitted optional field was previously a 500 on otherwise-valid input.
- **@azerothjs/kit (SSR)**: the shell splice uses function replacers, so rendered
  content or loader data containing `$&`, `` $` ``, or `$'` can no longer splice the
  document's own head/tail into the output.
- **compiler (projection)**: `generateVirtualCode` no longer throws on incomplete
  source. A mid-typing parse failure (the normal editing state) now degrades to a
  verbatim projection instead of throwing - which previously took down ALL
  TypeScript IntelliSense project-wide through the tsserver plugin.

Two silent-corruption traps in declaration scanning are now loud diagnostics
(warnings from the build, errors in the editor) instead of miscompiling:

- **compiler**: `azeroth/unterminated-declaration` - a missing `;` that lets one
  declaration absorb the next (`state a = 1` newline `state b = 2` parsed as a
  single declaration, silently dropping `b`) is now flagged at the swallowed
  keyword.
- **compiler**: `azeroth/non-ascii-name` - a non-ASCII character in a declaration
  name (`state café`), which the ASCII-only scanner would truncate silently, is now
  flagged.

### Added

- **kit** (NEW package): `@azerothjs/kit` - the assembled car. Per-route rendering
  over the pieces that already exist: the router's own route table gains one
  optional field (`render: 'server' | 'static' | 'client'`) and the kit does the
  rest - no new routing system, no new data layer, no config format.
  `createPageRenderer(App, routes)` (the SSR bundle's one line) renders a url
  through the router's guards and loaders via `matchAndLoad` - a redirecting guard
  surfaces as a REAL 302, parallel loader data rides the hydration handoff - and
  splices into vite's built shell so hashed asset tags survive. `mountPages(app,
  { routes, clientDir, renderer })` registers every page in its mode plus asset
  fallback on an `@azerothjs/http` app. `bootClient(App)` is the whole client
  entry (hydrate over markup, render into an empty shell, handoff read back).
  The `azeroth-kit-prerender` bin (also programmatic via `@azerothjs/kit/prerender`)
  writes every `render: 'static'` page through the real renderer at build time,
  preserving the pristine shell as `shell.html`; a static page that redirects or
  carries path parameters is a loud build error. Parameterized pages under an
  inherited `static` mode downgrade to per-request SSR. 12 behavioral tests drive
  the real HTTP kernel, real renderToString, and real hydrate - no mocks.

- **cli**: `azeroth build` detects a kit app (`src/entry.server.ts` +
  `@azerothjs/kit` installed) and plans the full production build - client build,
  SSR bundle (`vite build --ssr`), then the prerender pass; an SSR entry without
  the kit installed gets an honest note, never a silent skip.

- **create-azeroth**: the fullstack template now runs ON the kit - the
  before/after proof of the assembly. `src/routes.ts` is the one table (home
  `render: 'static'`, guest book `render: 'server'`); `entry.server.ts` is two
  lines (`createPageRenderer` + the re-exported routes); `main.azeroth` is one
  call (`bootClient(App)`); the server mounts everything with `mountPages`. The
  hand-wired `entry-server.ts` render/splice, `scripts/prerender.mjs`, the
  hydrate-or-render branching, and the per-path static routes are all DELETED -
  replaced by the kit calls. The SSR bundle is self-contained (`ssr.noExternal`),
  so the Docker image copies two build artifacts and needs no client
  node_modules; `SSR_ENTRY` joins the environment surface. The server package now
  declares `@azerothjs/schema` (previously resolved only through hoisting). The
  application half's scripts delegate to the CLI (`azeroth dev` / `check` /
  `build`) exactly like the standalone templates - the kit build steps live in
  ONE place, the CLI's printable plan, instead of being duplicated as a raw
  command line in the workspace script.

### Fixed

- **compiler / language-server / editors**: the `mount` keyword is now first-class
  across the WHOLE toolchain, not just the parser. It gains hover documentation
  and a completion snippet in the language server (both editors receive them over
  LSP), and the wrapper-keyword table moved to `keyword-spec.ts` (`WRAPPER_FN`) as
  the single source the parser AND the tooling completeness guards key off - a
  future wrapper keyword that ships without docs or a snippet now FAILS the suite
  (the hole that let `mount` slip through). Stale `watch` remnants are gone: the
  VS Code grammar's dead `watch (` rule is replaced by a real
  `effect (deps)` anchor (the renamed form was previously uncoloured), the
  JetBrains lexer no longer paints `watch` as a keyword, and hovering
  `effect (deps)` now serves the explicit-dependency documentation instead of the
  auto-tracked effect's. Both editor artifacts rebuilt against the train
  (`azerothjs-vscode-1.0.0-beta.2.vsix`, `azerothjs-jetbrains-1.0.0-beta.2.zip`),
  with the vsix stager taught to strip the bundled typescript-plugin's workspace
  dependencies (its dist is self-contained; the declared-dependency fix from the
  tooling fold broke vsce's npm-list probe).

- **azerothjs (SSR)**: `renderToString`/`renderToStaticMarkup` now establish a
  disposable ownership root around the render, exactly as client-side `render()`/
  `hydrate()` do - a root component that calls `provideContext()` (every router
  app: `<RouterProvider>`) previously CRASHED server rendering with
  "provideContext() called outside any ownership scope".

- **azerothjs (router)**: the guarded-match pipeline rides effects, and effects
  never run in string mode - so `<Routes>` serialized the FALLBACK for every url
  during SSR. The router now accepts the raw match synchronously at construction
  in string mode. Guards gate NAVIGATION; by the time a server renders, the
  request was already routed and authorized (`matchAndLoad` runs the chain's
  guards server-side and turns redirects/vetoes into real 302s/skips BEFORE
  rendering) - the string render is a pure serializer of that decision.

- **language-server**: the formatting placement, stated. The README now documents
  the deliberate 1.0 posture: one formatting engine (the language-service provider -
  document, range, and on-type), TypeScript regions formatted by the real TS
  formatter mapped through the projection, and markup preserved VERBATIM by
  construction (unmappable edits are dropped - the formatter structurally cannot
  mangle markup). Markup pretty-printing joins this engine when it comes - never
  a second implementation that could disagree with the editors.

- **project**: the trust pages. `GOVERNANCE.md` states plainly how the project is
  run - single maintainer, and exactly WHAT BINDS decisions (the normative grammar,
  the ratified syntax-stability policy, SemVer over the lockstep train, the test
  suite as executable specification) - including the single-maintainer question
  answered with structural mitigations rather than promises. `SUPPORT.md` gains
  the honest support-window statement (latest release line supported, one-command
  upgrade via `azeroth upgrade`, no LTS designation before the 2.0 horizon).
  `SECURITY.md` stays in sync with the train (the folded package name fixed, the
  upgrade path referenced).

- **cli**: two new verbs. `azeroth test` runs each half's vitest suite (server
  first), planned and printable like every other command. `azeroth upgrade [target]`
  moves every `azerothjs`/`@azerothjs/*`/`create-azeroth` pin across the root and
  its workspaces to one version (a dist-tag like `beta` resolves to a concrete
  version first), preserving each pin's range prefix and the file's formatting
  byte-for-byte, then runs `npm install` and the doctor; `--print` shows the change
  table without touching anything. The READMEs now document the scaffold canon -
  `npm create azeroth@latest` - with the warning that bare `npx azeroth` outside a
  project resolves an unrelated squatted npm package.

- **create-azeroth**: the fullstack template is now the CANON TOUR. Two client
  routes through the router in `.azeroth` (`<RouterProvider>`/`<Routes>`/`<Link
  activeClass end>`), ONE shared contract file both halves import
  (`server/src/contract.ts`, client-safe by construction), the API consumed through
  the fully inferred typed client, a guest-book form whose `form` keyword uses the
  SAME schema the server boundary enforces (one declaration, three enforcement
  points - the 422 field map lands in the form), the `mount { }` keyword, and an
  SSR'd + HYDRATED home route (prerendered at build via `vite build --ssr` + a
  splice script; `main.azeroth` adopts the markup; client-routed pages get the SPA
  shell so direct loads never mismatch). Dockerfile and CI carry over unchanged;
  the frontend/backend templates are demoted to minimal starters pointing at the
  canon. The scaffold guard now checks API paths across every application source.

- **compiler**: the TextMate grammar ships with the package -
  `@azerothjs/compiler/azeroth.tmLanguage.json` - one canonical copy any
  TextMate-compatible consumer (Shiki, docs generators) loads directly; welded by
  test to the VS Code extension bundle so the two can never diverge. The README
  shows the three-line Shiki registration; the native github-linguist submission
  is prepared as a post-release action.

- **compiler**: declaration emit shares one host across files. The `.d.ts` emitter
  (the vite `emitDeclarations` mirror, the WebStorm `.azeroth-types` bridge) now
  parses lib files AND every node_modules dependency once per process and shares a
  module-resolution cache, instead of rebuilding the dependency universe per file.
  Measured on a 120-component corpus with chained imports: 43.3 -> 20.0 ms/file cold,
  37.9 -> 17.1 ms/file warm (2.2x), byte-identical output. Project-local files are
  still read fresh every emit, so watch sessions see edits.
- **compiler**: the vanished-component diagnostic. The parser is total, so a
  `component` header that fails its shape check (missing name, unbalanced type
  parameters, missing body brace) used to silently become plain TypeScript - the
  component just did not exist. `diagnoseModule` now emits
  `azeroth/malformed-component` naming exactly what is wrong, surfaced as a dev
  warning by the Vite plugin. Only clear declaration intent triggers: ordinary
  identifiers named `component` (member access, annotations, assignments, strings,
  comments) stay silent.
- **compiler / language**: the `mount { ... }` wrapper keyword - the post-connection
  lifecycle block, lowering to `onMount(() => { ... })`. It completes the lifecycle
  triad with `cleanup { }` and `dispose { }` (mount was the one moment still written
  as a function call). Shape-gated like every keyword: `mount(fn)` and a local named
  `mount` stay plain code, and a new `azeroth/keyword-shadow` diagnostic warns when a
  body-local binding shadows a capture-guarded keyword. Editor tooling (hover docs,
  completion snippet, VS Code + JetBrains highlighting) ships in the same change.
- **compiler / docs**: `GRAMMAR.md` - the normative `.azeroth` grammar (lexical
  rules, every disambiguation, the contextual-keyword table, explicit non-goals) -
  and `STABILITY.md` - the ratified 1.x syntax-stability policy: the keyword-set
  freeze, the five-point rubric any future keyword must pass, and semver-for-syntax
  (PATCH: never; MINOR: rubric-passing additions only; MAJOR: everything else, with
  codemods).

- **router**: the navigation-UX layer. (1) GUARDS - `guard` on a route runs
  root-to-leaf BEFORE anything renders or loads: return `false` to veto (the previous
  location is restored, the guarded route never matches, its loaders never start), a
  target or `redirect(...)` to go elsewhere (replacing the vetoed entry), or `true`
  to pass; async guards hold the navigation (`pending()` covers the window), first
  veto wins, and `matchAndLoad` runs the same guards server-side, surfacing redirects
  as `{ redirect, replace }` for a real 302. (2) `redirect(to, { replace? })` - the
  sentinel loaders THROW to turn a navigation into another one, client and server.
  (3) `router.block(fn)` - leave blockers for the unsaved-form case: `false` (sync or
  awaited) keeps the user in place; browser back/forward blocking is best-effort and
  synchronous-only (documented - the History API cannot truly veto a pop).
  (4) HISTORY STAMPS - every router-written entry carries a key + index, so
  `location()` now tells the whole story: `navigationKind` ('push'/'replace'/'pop'),
  `delta` (-1 back, +1 forward - direction is finally knowable), and a stable `key`
  per entry; the Routes `transition` callback receives the same fields.
  (5) MANAGED SCROLLING (on by default): push/replace scrolls to top or the `#hash`
  target, pop RESTORES the position recorded for that entry; a per-navigation
  `scroll` option overrides, `scrollBehavior` is the fine-grained escape hatch,
  `scroll: false` opts out. (6) ROUTE-CHANGE FOCUS (on by default): after a
  navigation swap, focus moves to the new content (a `data-route-focus` element
  wins) so keyboard and screen-reader users land where the navigation took them;
  `focus: false` opts out. (7) `Link` grows a reactive `to` (function form - href,
  active state, and click target all track it) and prefix-aware active matching:
  `/users` is active at `/users/42` (segment-boundary safe), `end: true` demands
  exactness, and `to="/"` is exact by default.
- **router**: the v2 core. (1) PER-LEVEL PARALLEL LOADERS - every matched route in the
  chain may declare a loader and ALL levels start simultaneously (a layout loads beside
  its leaf, never in a waterfall); a level that genuinely needs its parent's result
  awaits the new `parent` promise (nearest loading ancestor), sequencing opt-in per
  level. `router.loaders` is one resource per level; `router.pending()` is the reactive
  navigation-in-flight signal. (2) LAZY ROUTES - `lazy: () => import('./Page.azeroth')`
  code-splits a route; the chunk races the level's loaders, `<Routes>` holds the
  current screen until it lands (no empty flash), a failed chunk throws into the tree
  for `<ErrorBoundary>`, and `createRouter` boot-validates that every route declares
  exactly one of `component`/`lazy`. (3) `<RouterProvider router>` - every composable
  and router component now resolves the router from context; `useRoute()` instead of
  `useRoute(router)` (the explicit argument stays as an override), and `useLoader()`
  inside a route component resolves ITS level (falling back to the nearest ancestor
  that loads). (4) `defineRoute(path, config)` TYPED HANDLES - pattern-inferred params
  (`.to({ id })` compile-checked), loader-typed `useLoader(handle)`, and a `search`
  schema whose validated+coerced value `useSearch(handle)` returns typed (an invalid
  query degrades to `{}` with one console warning, never a crash). (5) SSR handoff v2 -
  `matchAndLoad` pre-resolves lazy chunks and runs ALL levels' loaders in parallel;
  the wire payload is versioned and per-level, and a stale or older-shaped payload is
  rejected loudly in favor of a normal fetch.

### Changed

- **tooling** (BREAKING for direct importers only): `@azerothjs/language-service`
  folded INTO `@azerothjs/language-server` as the `./language-service` subpath - the
  safe half of the ruled tooling consolidation. It was the one tooling package nothing
  user-facing referenced by name (verified: templates and editors reference
  `@azerothjs/typescript-plugin` in tsconfigs, `@azerothjs/eslint-plugin` in eslint
  configs, and the `azeroth`/`azeroth-tsc` binaries - those four keep their names
  precisely because they ARE user-facing contracts). The typescript-plugin now
  declares its real dependency instead of relying on hoisting. Train: 14 packages.

- **http / api** (BREAKING): `@azerothjs/api` folded INTO `@azerothjs/http` as the
  `./api` subpath - the ruled backend consolidation. `import { defineContract, route,
  mountApi } from '@azerothjs/http/api'`; the browser half at
  `@azerothjs/http/api/client` (unchanged surface, new specifier). One package fewer
  in the train; the standalone `@azerothjs/api` will be deprecated on npm at the next
  publish. The purity welds extend to the new subpaths: `./api` is kernel-pure
  (contracts mount on edge runtimes) and `./api/client` provably never reaches
  server code.

- **router** (BREAKING, per the ratified router-v2 design): `Router.loader` (the single
  leaf resource) is replaced by per-level `Router.loaders` - `useLoader(router)` keeps
  the old "deepest loading level" meaning; `LoaderHandoff` is now
  `{ version, path, data: unknown[] }` (array by level); `Route.loader` receives
  `{ params, query, signal, parent }`; `router.navigationKind()` is DELETED - read
  `location().navigationKind`; `matchAndLoad` returns `MatchAndLoadResult` (handoff,
  `{ redirect }`, or null); router-written history entries WRAP user state
  (`history.state.state` carries what you passed to `navigate`); scroll and focus
  defaults change observable behavior (opt-outs: `scroll: false`, `focus: false`,
  per-navigation `scroll`).

- **http**: trusted-proxy URL truth. `serve(app, { trustProxy: true })` (granularly
  `{ proto: true }` / `{ host: true }`, also on `serveH2c` and `toWebRequest`) believes
  `X-Forwarded-Proto`/`X-Forwarded-Host` from a declared terminating proxy, so
  `context.url` carries the client's real scheme and host behind nginx/ALB/Cloudflare
  instead of the internal hop's `http://`. Off by default - the headers are
  caller-forgeable without a proxy (the same explicit trust boundary `clientIp` draws).
  The first entry of a comma-joined chain wins; a forwarded host is validated as
  host[:port] (no path or credential smuggling into the URL) and a forwarded proto
  only counts as `http`/`https`.
- **http**: `streamMultipart(request)` - the pull-based multipart iterator for uploads
  beyond memory. Parts arrive in posted order as they come off the socket; each payload
  is a `ReadableStream` piped straight to its sink (disk, object storage), with
  `bytes()`/`text()` per-part helpers (capped) for small parts. Same validation posture
  as the buffered reader: wrong content type is a 415, framing violations are typed
  400s, part-count and header caps hold, and parsing is chunk-edge safe (a boundary
  split across transport chunks parses byte-identically). Single-pass discipline:
  advancing the iterator discards the current part's unread remainder, and every exit -
  terminal delimiter, error, or an early `break` - releases the request body reader.
- **http**: static files answer single-range `Range` requests - a 206 streams exactly
  the requested span (video seeking, download resume), an unsatisfiable range is a 416
  with the total size, and multi-range or malformed headers are ignored with the full
  200 (RFC 9110 permits this; multipart/byteranges buys real clients nothing).
  `If-Range` holds by ETag or `Last-Modified` date, so a resumed download never splices
  two versions of a file; `Accept-Ranges` and `Last-Modified` now ride every response.
  `compressResponse` exempts 206s - a byte range refers to the UNENCODED representation.
- **api**: contract-level file routes. `input: multipart({ fields, limit, maxParts,
  maxFileSize })` declares a multipart/form-data route in the contract; the handler
  receives `{ fields, files }` fully typed - fields validated against the schema (the
  same 422 field map as JSON routes), files buffered within the caps. A non-multipart
  POST is a 415; the OpenAPI document declares the `multipart/form-data` request body
  with the fields schema. The typed client refuses multipart routes loudly (a browser
  posts `FormData` directly); beyond-memory uploads use `streamMultipart` in the handler.
- **api**: the typed reply channel. A route declares its non-default responses per
  status (`responses: { 201: User, 409: Problem }`) and a handler speaks them through
  `reply(status, body?, headers?)` - the body is validated against that status's
  schema exactly like `output` (a violation is the same hidden 500
  `contract-violation`), `reply(204)` sends an empty response, and an undeclared
  status with a body is a compile error. Every declared status becomes its own entry
  in the OpenAPI document with its real schema (a prose-only `docs.errors` entry can
  no longer downgrade it to the generic envelope). A raw `Response` return remains
  the only validation bypass - the non-JSON escape hatch (files, redirects, streams),
  now by documented design. The client keeps its success-body behavior.
- **compiler / azerothjs**: the compiled-output version handshake. Every compiled
  module now asserts the runtime-contract version it was built against
  (`assertRuntimeContract(N)`, once, at load) against the runtime's
  `RUNTIME_CONTRACT_VERSION`. A prebuilt artifact (a published `.azeroth` library's
  dist, a stale bundle) meeting a runtime from a different contract era fails at
  startup with a clear "rebuild with the matching compiler" error instead of
  undefined behavior - this is what lets the compiled-output contract evolve after
  1.0. The compiler's and runtime's versions are welded by a drift test.
- **schema / form / api**: Standard Schema v1 everywhere. Every `@azerothjs/schema`
  schema now carries the `~standard` property, so a house schema plugs into ANY
  Standard-Schema-aware consumer (form resolvers, tRPC, other frameworks) exactly like a
  Zod schema. In the other direction, `FormConfig.schema` and per-field `validate`
  entries accept any SYNCHRONOUS Standard Schema validator (Zod/Valibot/ArkType) beside
  the native one - a team keeps its existing schemas - and the typed client now
  pre-validates a foreign-schema input locally before the request leaves (mapping its
  issue paths to the same flat field map). An async foreign schema in the sync form
  pipeline is a loud configuration error, not a silent skip; foreign schemas still
  degrade to the permissive OpenAPI shape (only native schemas self-describe fully).
- **reactivity**: `onMount(fn)` - the sanctioned post-connection hook. Runs once, one
  microtask after the synchronous render (every insertion path is synchronous, so the
  DOM is connected by then), under the registering owner: effects it creates are owned,
  a returned cleanup runs on unmount, a scope disposed before the microtask never fires
  its callback, and SSR skips it entirely. Refs still fire at construction (documented) -
  capture the element there, do connected-time work in onMount.
- **reactivity**: the ownership tree is now first-class. `createRoot` builds an `Owner`
  node (disposers, parent link, context storage, captured error routing);
  `getOwner()`/`runWithOwner(owner, fn)` let async continuations create effects that
  are OWNED - disposed with their scope instead of leaking - with errors still routed
  to the boundary the owner was created in. `createContext`/`provideContext`/
  `useContext` add owner-tree dependency injection: provided values flow down the tree,
  nearer provides shadow outer ones, sibling scopes are isolated, and values are freed
  on dispose. This is the primitive that lets component libraries thread theming or a
  router without module-level singletons.

### Changed

- **reactivity**: every write is now GLITCH-FREE. A top-level setter runs inside an
  implicit flush: the change wave marks memos and queues affected effects first, then
  each affected effect runs exactly once on fully-settled state - still synchronously,
  before the setter returns. Previously a diamond (one signal feeding two memos read by
  one effect) fired the effect once per branch, the first time on mixed-generation
  state (one memo fresh, one stale). Diamond-shaped updates got ~40% faster (one effect
  run per write instead of two); the single-binding write path pays ~11% for the
  guarantee. `batch()` remains the tool for coalescing MULTIPLE writes into one run,
  and now returns its body's value.

### Changed (BREAKING - beta)

- **http**: the package split into a pure fetch-standard kernel and a Node half.
  `serve`/`serveH2c`/`handleShutdownSignals`/`toWebRequest`/`writeResponse`/
  `staticFiles`/`compressResponse` (and their types) moved to the new
  `@azerothjs/http/node` subpath; the `.` entry now carries ZERO `node:*` imports in
  its module graph (one sanctioned exception: the AsyncLocalStorage request-root seam,
  implemented by Bun, Deno, and workerd) - enforced by a static purity test. New
  `toFetchHandler(app)` bridges an App to any WinterCG fetch runtime (Cloudflare
  Workers, Deno Deploy, Bun.serve, Vercel Edge):
  `export default { fetch: toFetchHandler(app) }`. `WebHandler` now lives on the
  kernel side.

- **THE CONSOLIDATION**: `azerothjs` is now ONE REAL PACKAGE. The six frontend packages -
  `@azerothjs/reactivity`, `@azerothjs/component`, `@azerothjs/renderer`,
  `@azerothjs/server` (SSR), `@azerothjs/router`, `@azerothjs/form` - are DISCONTINUED
  and live inside `azerothjs` (they were exact-pin lockstep and compiled output always
  imported `azerothjs`, so the split was never real). Migration: `import { ... } from
  'azerothjs'` everywhere the scoped names were used - every public symbol is unchanged.
  The publish train shrinks to 16 packages; `@azerothjs/schema`, the backend stack, the
  compiler, and the tooling packages are untouched.

- **store**: the `@azerothjs/store` package is DISCONTINUED - `createStore` now lives in
  `@azerothjs/reactivity`, whose store-scope machinery it always built on (134 LOC split
  across two packages was a boundary, not a module). `import { createStore } from
  'azerothjs'` is unchanged; a direct `@azerothjs/store` import becomes
  `@azerothjs/reactivity`.

- **api**: ONE mount form. `implementContract` and the legacy
  `mountApi(implementation, { guards })` overload are REMOVED (with the
  `Implementation`/`HandlersOf`/`HandlerFor`/`ApiGuard`/`MountOptions` types) - the
  unified `mountApi(app, contract, { guards, handlers })` is the only way, and the only
  one whose guard additions type into handlers. Factories share the guards map via
  `HandlersWithGuards`.
- **http**: `App.plugin(fn)` folded into `register` - one plugin verb accepting both a
  named `AzerothPlugin` and a bare function transform. `createLogger` renamed
  `createMinimalLogger` (it collided with `@azerothjs/logger`'s `createLogger` with an
  incompatible `Logger` type). `EdgeMiddleware` renamed `HandlerWrapper` (it decorates a
  handler; it never was the context-middleware algebra). `use()`'s aliasing and
  short-circuit typing caveats are now documented on the method - prefer `with()` where
  exactness matters.
- **http/api**: the QUERY method surface (`app.query`, the `query()` route factory,
  `queryResult`, `acceptQuery`) is flagged `@experimental` - RFC 10008 is not yet
  deployed internet reality; the API is stable within 1.x but marked until the RFC is.

- **azerothjs / reactivity**: internal machinery left the public surface. Compiled
  `.azeroth` output now imports its runtime from the new `azerothjs/internal` subpath -
  the single compiled-output contract, welded to the compiler by a drift test - and the
  public entry no longer exports `tmpl`/`bindHole`/`bindContent`/`bindEvent`/`bindSlot`/
  `bindProps`/`setProp` (rebuild apps with the matching compiler). `@azerothjs/reactivity`
  moved its framework plumbing (`serializeChild`, `wrapContentsAnchored`, the hydration
  adoption protocol, `setStoreScopeResolver`, the `subscriberCount` test probe) to
  `@azerothjs/reactivity/internal`; the public entry keeps the user primitives plus
  `ssr`/`isSSRNode`/`escapeText`/`escapeAttr`. Internal subpaths are exempt from semver.

- **reactivity**: `setSSRMarkers`/`getSSRMarkers` are REMOVED. Hydration markers are no
  longer a mutable global - they ride the render window itself:
  `runInMode('string', fn, { markers: true })` (what `renderToString` does) vs
  `{ markers: false }` (`renderToStaticMarkup`). Marker state is now render-scoped and
  exception-safe by construction - a throwing render cannot leak marker state into the
  next request - and backing the render context with per-async-context storage later
  (streaming SSR) becomes a one-accessor change.

- **server**: `island()` no longer wraps the island in a `<span style="display:contents">` -
  the anchor attributes now ride on the island component's OWN root element, so an island
  is valid anywhere its root is (a `<tr>` island sits directly in a `<tbody>`) and
  direct-child selectors keep working. An island component must render a single element
  root (now enforced with a descriptive error). `hydrateIslands()` adopts the new form;
  pages server-rendered by an older version must be re-rendered.
- **reactivity**: `catchError` returns `T | undefined` instead of a silently-undefined `T` -
  the caught case is now visible to the type checker.

### Fixed

- **api**: the client substitutes path parameters at identifier boundaries - `:id` no
  longer corrupts a sibling parameter named `:ida`.
- **ws**: two `attachWebSockets` endpoints coexist on one server - a path-mismatched
  endpoint no longer destroys a sibling endpoint's handshake; an upgrade nobody claims
  still gets exactly one clean 404.
- **http**: SSE connections drop a client that falls `maxBufferedBytes` (default 1 MiB)
  behind instead of buffering unbounded - EventSource reconnects and resumes via
  `Last-Event-ID`; the cap is configurable per stream.
- **create-azeroth**: the fullstack template's demo now calls the `/api/healthz` route the
  server actually defines, and its Dockerfile installs from the root workspace context so
  `docker build` succeeds (a workspace member has no lockfile of its own). Both are now
  guarded by scaffold tests.
- **eslint-plugin**: the plugin/processor `meta.version` is read from the package manifest
  instead of a hard-coded string that had gone stale.
- Release engineering: version bumps are structured per file kind (anchored manifest
  edits with parse validation, anchored gradle edit, exact-string docs) with a post-bump
  guard that fails on any drifted version example - the corruption class that once
  rewrote a CONTRIBUTING example into nonsense.

## [1.0.0-beta.2] - 2026-07-24

The terminal-experience release: `azeroth dev` becomes a designed frame instead of a
pipe multiplexer, and the logger's developer face renders meaning instead of strings.

### Changed (BREAKING - beta, no back-compat shim by design)

- **api**: the unified typed mount. `mountApi(app, contract, { guards, handlers })` now
  types guard additions INTO each handler's context and CHECKS the guards-map keys
  against the contract tree. A guard built with the new `guard()` helper carries its
  additions (`guard((context) => ({ accountId }))`), and every handler it protects reads
  `context.accountId` with NO cast; a mis-typed guard key (`'accont.*'`) is a compile
  error, not a silently-unguarded route. The legacy
  `mountApi(app, implementContract(contract, handlers), { guards })` form is retained for
  separate construction (its handlers type without additions - guarded routes there use a
  knowing cast). `HandlerArgs` was already renamed `HandlerContext`; new exports:
  `guard`, `Guard`, `GuardKey`, `GuardMap`, `HandlersWithGuards`, `TypedMountOptions`.
- **api**: **bring your own validator**. `route({ input, query, output })` accepts any
  [Standard Schema](https://standardschema.dev) validator (Zod, Valibot, ArkType via the
  `~standard` property) in addition to native `@azerothjs/schema`. A foreign schema
  validates the boundary (422 with the same field-path errors); its OpenAPI entry
  degrades to the honest permissive shape (native schemas keep full self-description).
- **http/api**: every handler now takes ONE argument, the `context`, and returns the
  response - `(context) => Response`, replacing http's `(request, ctx)` and the
  contract handler's `({ params, input, query, request, context })` five-name
  destructure. The context carries `request` (the raw web-standard Request), `params`,
  `url`, and - on contract routes - the validated `input`/`query`; whatever middleware
  or a mount guard adds lands FLAT on the same object. This unifies the two handler
  shapes into one, matching the single-context model the current framework generation
  proved developers want, while keeping what nobody else has: responses enforced
  against their declared schema, and the typed client + OpenAPI derived from the same
  contract. Migration is mechanical: `(request, ctx)` → `(context)` with `request` →
  `context.request`; `({ input, context })` → `(context)` reading `context.input` and
  `(context as typeof context & Guarded)` for guard additions. `Middleware` and
  `ApiGuard` take the context too (`(context) => additions | Response | void`). The
  `HandlerArgs` type is renamed `HandlerContext`.

### Added

- **api**: OpenAPI 3.1 export - the contract's third exporter after the server mount
  and the typed client. `toOpenApi(contract, { info })` derives the complete document
  from the declaration (paths, params, bodies, response shapes, operation ids and tags
  from the contract tree, the framework's 422/415/500 envelope responses);
  `openapiPlugin` serves it - plus a docs page at `/docs` with two viewers:
  **Scalar via CDN shell (default)** for the best-in-class UI, and
  **`viewer: 'azeroth'`** - the house explorer, a fully self-contained page (inline
  styles/script, zero external requests, works offline) in the AzerothJS design
  language with REST-colored methods, verdict-colored statuses, schema trees, and a
  same-origin try-it panel (`docs: false` for spec-only);
  `uncontracted(app, contract)` reports coverage for
  partial adoption. Deterministic output (byte-identical builds - specs diff cleanly
  in CI), shared schema instances dedupe into named components, and every mapping rule
  is tested with honest degradations - a `.refine()` becomes a
  description note, never an invented constraint. Routes gain an optional display-only
  `docs` field (summary/tags/deprecated/errors/security) for what a machine cannot know.
- **schema**: schemas are now fully self-describing - `meta` carries the constraints
  the validator enforces (the same options object, one source of truth), true kinds
  and payloads for `literal`/`enumOf`/`record`/`union`, and each `.refine()`'s declared
  code. `boolean`/`array` options gained named types (`BooleanOptions`, `ArrayOptions`);
  `SchemaMeta` is exported for compile-from-declaration consumers.
- **http**: `jsonEncoder` reads the richer self-description - `record` gains a real
  fast path, `literal` compiles to a constant, `enum` encodes as a string; `union`
  stays on the byte-exact fallback.
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

[Unreleased]: https://github.com/AzerothJS/AzerothJS/compare/v1.0.0-beta.2...HEAD
[1.0.0-beta.2]: https://github.com/AzerothJS/AzerothJS/compare/v0.9.0-beta.4...v1.0.0-beta.2
[0.9.0-beta.4]: https://github.com/AzerothJS/AzerothJS/compare/v0.9.0-beta.3...v0.9.0-beta.4
[0.9.0-beta.3]: https://github.com/AzerothJS/AzerothJS/compare/v0.9.0-beta.2...v0.9.0-beta.3
[0.9.0-beta.2]: https://github.com/AzerothJS/AzerothJS/compare/v0.9.0-beta.1...v0.9.0-beta.2
[0.9.0-beta.1]: https://github.com/AzerothJS/AzerothJS/compare/v0.8.0-beta.2...v0.9.0-beta.1
[0.8.0-beta.2]: https://github.com/AzerothJS/AzerothJS/compare/v0.8.0-beta.1...v0.8.0-beta.2
[0.8.0-beta.1]: https://github.com/AzerothJS/AzerothJS/compare/v0.7.0-beta.1...v0.8.0-beta.1
[0.7.0-beta.1]: https://github.com/AzerothJS/AzerothJS/compare/v0.6.0-beta.1...v0.7.0-beta.1
[0.6.0-beta.1]: https://github.com/AzerothJS/AzerothJS/releases/tag/v0.6.0-beta.1
