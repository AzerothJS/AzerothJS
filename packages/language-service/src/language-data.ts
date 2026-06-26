// Static language knowledge that isn't derivable from a single `.azeroth`
// file: the HTML vocabulary markup targets (tags, global attributes, DOM
// events) and the framework's built-in components.
//
// The built-in component data here is transcribed directly from the runtime's
// own prop interfaces (@azerothjs/renderer, @azerothjs/component, the compiler's
// auto-import set) - it is not invented. Deep type detail (exact prop types,
// generics) still flows from TypeScript at hover/signature time; this table
// exists so completion can *offer* the components and their props with a useful
// one-line summary before the type bridge fills in the rest.

/** A completion-ready description of a built-in component. */
export interface BuiltinComponent
{
    name: string;
    /** Short signature-like detail shown beside the name. */
    detail: string;
    /** Markdown documentation. */
    doc: string;
    /** Known prop names with one-line docs, for attribute completion. */
    props: { name: string; doc: string; required: boolean }[];
}

/**
 * The components the compiler auto-imports from `@azerothjs/core` when markup
 * uses them. Mirrors @azerothjs/compiler's BUILTIN_COMPONENTS, with prop data
 * taken from the renderer/component prop interfaces.
 */
export const BUILTIN_COMPONENTS: BuiltinComponent[] =
[
    {
        name: 'Show',
        detail: '<Show when={...} fallback={...}>...</Show>',
        doc: 'Conditionally renders its children when `when` is truthy, otherwise the optional `fallback`. Swaps automatically when the reactive condition changes.',
        props: [
            { name: 'when', doc: 'Reactive condition (`() => boolean`). Children show while truthy.', required: true },
            { name: 'fallback', doc: 'Rendered when `when` is false: `() => element`. Optional.', required: false },
            { name: 'children', doc: 'Content shown while `when` is truthy: `() => element`.', required: true }
        ]
    },
    {
        name: 'For',
        detail: '<For each={...} key={...}>{(item, i) => ...}</For>',
        doc: 'Keyed list rendering. Re-uses DOM elements across updates by `key`, so only changed rows touch the DOM. The child is a render function `(item, index) => element`.',
        props: [
            { name: 'each', doc: 'Reactive getter returning the array of items: `() => T[]`.', required: true },
            { name: 'key', doc: 'Returns a stable unique key per item: `(item, index) => string | number`.', required: true },
            { name: 'children', doc: 'Per-item render function: `(item, index: () => number) => element`.', required: true }
        ]
    },
    {
        name: 'Switch',
        detail: '<Switch fallback={...}><Match/>...</Switch>',
        doc: 'Renders the first `<Match>` whose `when` is truthy (priority order). Optional `fallback` when none match.',
        props: [
            { name: 'children', doc: 'The `<Match>` cases, in priority order (first match wins).', required: true },
            { name: 'fallback', doc: 'Rendered when no `<Match>` matches: `() => element`. Optional.', required: false }
        ]
    },
    {
        name: 'Match',
        detail: '<Match when={...}>...</Match>',
        doc: 'A single case inside `<Switch>`. Rendered when its `when` condition is the first truthy one.',
        props: [
            { name: 'when', doc: 'Reactive condition for this case: `() => boolean`.', required: true },
            { name: 'children', doc: 'Content rendered when this case wins: `() => element`.', required: true }
        ]
    },
    {
        name: 'Portal',
        detail: '<Portal target={...}>...</Portal>',
        doc: 'Renders its children into a different DOM node (defaults to `document.body`). Useful for modals, tooltips, and overlays.',
        props: [
            { name: 'target', doc: 'Destination element. Defaults to `document.body`. Optional.', required: false },
            { name: 'children', doc: 'Content portaled into `target`: `() => element`.', required: true }
        ]
    },
    {
        name: 'Dynamic',
        detail: '<Dynamic component={...} props={...} />',
        doc: 'Renders a component chosen at runtime. When the `component` getter changes, the old one is removed and the new one mounted.',
        props: [
            { name: 'component', doc: 'Reactive getter returning the component to render, or `null`.', required: true },
            { name: 'props', doc: 'Reactive getter returning props for the component. Optional.', required: false }
        ]
    },
    {
        name: 'Suspense',
        detail: '<Suspense on={[...]} fallback={...}>...</Suspense>',
        doc: 'Shows `fallback` while any watched resource is loading, then reveals children once all have settled.',
        props: [
            { name: 'fallback', doc: 'Rendered while any watched resource is loading: `() => element`.', required: true },
            { name: 'on', doc: 'Array of resources to watch (captured once, not reactive to array mutation).', required: true },
            { name: 'children', doc: 'Subtree revealed once all watched resources settle: `() => element`.', required: true }
        ]
    },
    {
        name: 'Transition',
        detail: '<Transition when={...} name="...">...</Transition>',
        doc: 'Animated show/hide. With a `name`, auto-generates the 6-class enter/leave family; without one, falls back to an instant swap.',
        props: [
            { name: 'when', doc: 'Reactive boolean (`() => boolean`): true to show, false to hide.', required: true },
            { name: 'children', doc: 'Element built when entering: `() => element`.', required: true },
            { name: 'name', doc: 'Class-name prefix for the enter/leave transition classes. Optional.', required: false },
            { name: 'duration', doc: 'Fallback transition timeout in ms. Default 1000. Optional.', required: false }
        ]
    },
    {
        name: 'ErrorBoundary',
        detail: '<ErrorBoundary fallback={(err, reset) => ...}>...</ErrorBoundary>',
        doc: 'Catches errors thrown while rendering its subtree and shows `fallback(error, reset)` instead. Call `reset` to retry.',
        props: [
            { name: 'fallback', doc: 'Renders the error UI: `(error, reset) => element`. Call `reset` to retry.', required: true },
            { name: 'children', doc: 'Protected subtree, re-evaluated on each reset: `() => element`.', required: true }
        ]
    },
    {
        name: 'Outlet',
        detail: '<Outlet />',
        doc: 'Renders nested-route content inside a layout component. Provided automatically by `<Routes>`.',
        props: [
            { name: 'children', doc: 'Nested-route content, forwarded from the layout. Optional.', required: false }
        ]
    }
];

/** Fast lookup of built-in component data by name. */
export const BUILTIN_COMPONENT_MAP = new Map(BUILTIN_COMPONENTS.map(component => [component.name, component]));

// Host-element vocabulary (HTML tags, attributes, and attribute values, with
// MDN documentation) is provided by `vscode-html-languageservice` - the same
// engine VS Code's HTML support uses - via providers/html-service.ts, so it is
// complete and stays current without a hand-maintained list here. What remains
// below is genuinely AzerothJS-specific.

/**
 * DOM event handler attribute names. AzerothJS binds any `on<Event>` prop as a
 * listener (camelCase) and passes the handler through verbatim (see the
 * compiler's codegen) - this differs from HTML's lowercase `onclick`, so it is
 * supplied here rather than by the HTML service.
 */
export const DOM_EVENTS: string[] =
[
    'onClick', 'onDblClick', 'onMouseDown', 'onMouseUp', 'onMouseEnter', 'onMouseLeave',
    'onMouseMove', 'onMouseOver', 'onMouseOut', 'onContextMenu',
    'onInput', 'onChange', 'onSubmit', 'onReset', 'onFocus', 'onBlur', 'onFocusIn', 'onFocusOut',
    'onKeyDown', 'onKeyUp', 'onKeyPress',
    'onPointerDown', 'onPointerUp', 'onPointerMove', 'onPointerEnter', 'onPointerLeave',
    'onTouchStart', 'onTouchEnd', 'onTouchMove',
    'onScroll', 'onWheel', 'onDrag', 'onDragStart', 'onDragEnd', 'onDragOver', 'onDrop',
    'onCopy', 'onCut', 'onPaste',
    'onLoad', 'onError', 'onAnimationEnd', 'onTransitionEnd'
];

/**
 * Concise documentation for common element attributes that the standard HTML
 * dataset ships *without* a description (form/input attributes especially), so
 * `type`, `placeholder`, `value`, ... aren't left blank on hover/completion.
 * Global attributes (`class`, `id`, `title`, `style`, `aria-*`) and many tag
 * attributes already carry MDN docs straight from the HTML engine; this only
 * fills the gaps.
 */
export const ATTRIBUTE_DOCS: Record<string, string> =
{
    type: 'The kind of control to render (e.g. `text`, `checkbox`, `email`, `number`, `password`).',
    value: 'The control\'s current value. In AzerothJS, bind it reactively: `value={signal()}`.',
    placeholder: 'Hint text shown while the field is empty.',
    checked: 'Whether a checkbox/radio is selected. Bind reactively: `checked={done()}`.',
    disabled: 'When present, the control is non-interactive.',
    readonly: 'When present, the value can\'t be edited (but is still submitted).',
    required: 'Marks the field as required for form submission.',
    name: 'The control name, submitted with the form data.',
    min: 'Minimum allowed value (numeric/date inputs).',
    max: 'Maximum allowed value (numeric/date inputs).',
    step: 'Granularity of allowed values (numeric/date inputs).',
    pattern: 'A regular expression the value must match.',
    autocomplete: 'Hint for the browser\'s autofill behaviour.',
    selected: 'Marks an `<option>` as initially selected.',
    multiple: 'Allows selecting or entering multiple values.',
    rows: 'Visible number of text rows in a `<textarea>`.',
    cols: 'Visible width, in characters, of a `<textarea>`.',
    src: 'The URL of the resource (image, script, media, ...).',
    alt: 'Alternative text describing an image.',
    for: 'Associates a `<label>` with a control by its `id`.',
    action: 'The URL that processes the form submission.',
    method: 'The HTTP method used to submit the form (`get` / `post`).',
    colspan: 'Number of columns a table cell spans.',
    rowspan: 'Number of rows a table cell spans.'
};

/** Fallback documentation for a common element attribute, or undefined. */
export function attributeDocumentation(name: string): string | undefined
{
    return ATTRIBUTE_DOCS[name.toLowerCase()];
}

/**
 * Hover documentation for the AzerothJS authoring keywords. These compile away (a
 * `state` becomes a signal, an `effect` becomes a tracked effect, ...) so they leave
 * no symbol for TypeScript quick-info to describe - this table is the only source
 * of hover docs for them. Each entry is ready-to-render markdown: a title line, a
 * one-paragraph explanation of the runtime semantics, and a fenced `azeroth`
 * example.
 */
export const KEYWORD_DOCS: Record<string, string> =
{
    component:
        '**`component`** - AzerothJS component\n\n' +
        'Declares a component: a function that returns markup, with reactive `state`, `derived`, and `effect` in its body. ' +
        'It runs ONCE to build its DOM; afterwards fine-grained updates patch only what changed (there is no re-render).\n\n' +
        '```azeroth\nexport default component Counter\n{\n    state count = 0;\n    <button onClick={() => count = count + 1}>{count}</button>\n}\n```\n\n' +
        'Props are an ordinary TypeScript parameter - `component Card(props: CardProps)` or a destructured ' +
        '`component Card({ title, size = \'md\' }: CardProps)`. Reading `props.value` (or a destructured `title`) ' +
        'inside markup or an `effect` is reactive and updates when the parent passes a new value.',
    state:
        '**`state`** - reactive state (signal)\n\n' +
        'The atomic unit of reactive state. Use it like a plain variable: reading `count` inside a tracking scope ' +
        'subscribes; assigning `count = next` updates it and re-runs every effect / `derived` that read it. (The ' +
        'compiler rewrites these to signal get/set calls.)\n\n' +
        '```azeroth\nstate count = 0;\n// read: count   write: count = count + 1\n```',
    derived:
        '**`derived`** - computed value (memo)\n\n' +
        'A cached value computed from other reactive sources. It recomputes only when a source it read actually changes ' +
        '(and only while something reads it) - lazy and memoized.\n\n' +
        '```azeroth\nstate count = 0;\nderived doubled = count * 2;\n```',
    deferred:
        '**`deferred`** - debounced computed value\n\n' +
        'Like `derived`, but its updates are debounced: readers see the new value only after a quiet period with no ' +
        'further source changes. Use it to drive expensive work off rapidly-changing input.\n\n' +
        '```azeroth\nstate query = \'\';\ndeferred settled = query;\n```',
    effect:
        '**`effect`** - reactive side effect\n\n' +
        'Runs its body immediately, tracks every reactive source it reads, and re-runs whenever one changes. The bridge to ' +
        'the outside world (DOM, logging, network). Use `cleanup` (or return a function) to tear down before the next run.\n\n' +
        '```azeroth\neffect\n{\n    document.title = title;\n}\n```',
    watch:
        '**`watch`** - explicit-dependency effect\n\n' +
        'An effect with an EXPLICIT dependency list instead of automatic tracking. It runs when a listed dependency ' +
        'changes, with access to the previous and current values.\n\n' +
        '```azeroth\nwatch (count) (value, previous)\n{\n    console.log(previous, \'->\', value);\n}\n```',
    batch:
        '**`batch`** - batched writes\n\n' +
        'Groups signal writes so dependents re-run ONCE, after the block - instead of synchronously after each ' +
        'individual write.\n\n' +
        '```azeroth\nbatch\n{\n    firstName = \'Ada\';\n    lastName = \'Lovelace\';\n}\n```',
    untrack:
        '**`untrack`** - read without tracking\n\n' +
        'Reads reactive sources inside the block WITHOUT subscribing the surrounding effect to them - the escape hatch ' +
        'for "I need this value now, but must not re-run when it changes."\n\n' +
        '```azeroth\neffect\n{\n    save(form);\n    untrack { log(currentUser); }\n}\n```',
    cleanup:
        '**`cleanup`** - teardown hook\n\n' +
        'Registers a callback that runs before the enclosing effect re-runs (on a dependency change) and when it is ' +
        'disposed. For releasing subscriptions, timers, and listeners.\n\n' +
        '```azeroth\neffect\n{\n    const id = setInterval(tick, 1000);\n    cleanup { clearInterval(id); }\n}\n```',
    dispose:
        '**`dispose`** - root-disposal hook\n\n' +
        'Registers a callback that runs exactly once, when the surrounding root scope is disposed - the scope-level ' +
        'sibling of `cleanup`.\n\n' +
        '```azeroth\ndispose\n{\n    socket.close();\n}\n```',
    resource:
        '**`resource`** - async data\n\n' +
        'Declares an async resource (lowers to `createResource`). The value is the fetcher; `with { source }` makes ' +
        'it refetch when a signal changes (and skip while that signal is falsy). Read it explicitly: `name.data()`, ' +
        '`name.loading()`, `name.error()`, `name.refetch()`.\n\n' +
        '```azeroth\nresource user = (id) => fetchUser(id) with { source: selectedId };\n```',
    stream:
        '**`stream`** - streaming async data\n\n' +
        'Declares a streaming resource (lowers to `createStream`) for SSE / chunked / incremental responses. Like ' +
        '`resource` plus `name.done()` and `name.cancel()`; `with { parse }` selects the chunk mode.\n\n' +
        '```azeroth\nstream feed = (id) => openFeed(id) with { source: channelId, parse: \'sse\' };\n```',
    store:
        '**`store`** - per-render store\n\n' +
        'Declares a store (lowers to `createStore`) - a lazily-built object of reactive accessors scoped to the ' +
        'render. The value is the factory (a bare object literal is wrapped for you). Read through its accessors.\n\n' +
        '```azeroth\nstore cart = { items: [] as Item[], add(i: Item) { ... } };\n```',
    selector:
        '**`selector`** - keyed selection\n\n' +
        'Declares a selector (lowers to `createSelector`) - an O(1) "is this key the selected one?" test that only ' +
        'notifies the two rows whose state flips. The value is the source signal; read it as `name(key)`.\n\n' +
        '```azeroth\nselector isActive = activeId;\n// in a row: class:active={isActive(row.id)}\n```',
    form:
        '**`form`** - reactive form\n\n' +
        'Declares a form (lowers to `createForm`). The `= { ... }` value is the initial field set; an optional ' +
        '`with { validate, onSubmit }` clause adds validators and the submit handler. A FIELD reads as `name.field` ' +
        'and writes via `name.field = v` - so `bind:value={name.field}` works - while `name.errors()`, ' +
        '`name.submitting()`, and `name.handleSubmit` expose the rest of the form API.\n\n' +
        '```azeroth\nform login = { email: \'\', password: \'\' } with {\n' +
        '    validate: { email: combine(required(), email()) },\n' +
        '    onSubmit: async (values) => { await signIn(values); }\n};\n\n' +
        '<form onSubmit={login.handleSubmit}>\n' +
        '    <Input bind:value={login.email} error={login.errors().email} />\n</form>\n```',
    with:
        '**`with`** - reactive options clause\n\n' +
        'Attaches an options object to a `state`, `derived`, `deferred`, `effect`, `watch`, `resource`, `stream`, or ' +
        '`selector`. It is passed straight to the underlying primitive - e.g. a custom `equals` comparator, a debug ' +
        '`name`, or a resource/stream `source`.\n\n' +
        '```azeroth\nstate point = { x: 0 } with { equals: (a, b) => a.x === b.x };\n\neffect with { name: \'sync\' }\n{\n    save(data);\n}\n```'
};

/** Hover documentation (markdown) for an AzerothJS authoring keyword, or undefined. */
export function keywordDocumentation(name: string): string | undefined
{
    return KEYWORD_DOCS[name];
}

/** One option accepted inside a keyword's `with { ... }` clause. */
export interface KeywordOption
{
    /** The option key, as written inside `with { ... }`. */
    name: string;
    /** The option's type, shown as the completion detail line. */
    type: string;
    /** Markdown documentation, shown in completion and on hover. */
    doc: string;
}

// `state` and `derived` both produce a reactive getter, so both take SignalOptions.
const SIGNAL_OPTIONS: readonly KeywordOption[] =
[
    { name: 'equals', type: '(prev: T, next: T) => boolean', doc: 'Custom equality - the value counts as unchanged (no notification) when this returns `true`. Defaults to `Object.is`.' },
    { name: 'name', type: 'string', doc: 'Optional debug name, surfaced by error tooling.' }
];

/**
 * The `with { ... }` options each authoring keyword accepts. This is the SINGLE place to maintain
 * them: to add an option to (say) `effect`, add one entry to the `effect` array below and it flows
 * automatically to completion (the keys offered inside `with { }`) AND to hover docs on those keys.
 * A keyword absent here - or with an empty list - takes no options. Each list mirrors the options
 * type of the runtime primitive the keyword lowers to (createSignal/createMemo, createDeferred,
 * createEffect, on).
 */
export const KEYWORD_OPTIONS: Record<string, readonly KeywordOption[]> =
{
    state: SIGNAL_OPTIONS,
    derived: SIGNAL_OPTIONS,
    deferred:
    [
        { name: 'timeout', type: 'number', doc: 'Debounce window in milliseconds - the value updates only after this many ms with no further source change. Default `150`.' }
    ],
    effect:
    [
        { name: 'name', type: 'string', doc: 'Optional debug name, surfaced by error tooling.' }
    ],
    watch:
    [
        { name: 'defer', type: 'boolean', doc: 'When `true`, skip the initial run - the body runs only on the first dependency change (with genuine previous values).' }
    ],
    resource:
    [
        { name: 'source', type: '() => S | false | null | undefined', doc: 'A signal/getter that drives the fetch - the resource refetches when it changes, and skips fetching while it is falsy (the fetched value is passed to the fetcher). Omit `source` for a one-shot fetch.' }
    ],
    stream:
    [
        { name: 'source', type: '() => S | false | null | undefined', doc: 'A signal/getter that drives the stream - it restarts when this changes, and is idle while falsy.' },
        { name: 'parse', type: "'text' | 'sse' | 'ndjson' | ((chunk: string) => string)", doc: 'How to split the byte stream into chunks. Default `text` (raw decoded text).' },
        { name: 'initial', type: 'T', doc: 'The value `data()` holds before the first chunk arrives.' }
    ],
    selector:
    [
        { name: 'equals', type: '(prev: T, next: T) => boolean', doc: 'Custom equality for detecting a selection change. Defaults to `Object.is`.' }
    ]
};

/** The `with { ... }` options for an authoring keyword, or undefined when it takes none. */
export function keywordOptions(keyword: string): readonly KeywordOption[] | undefined
{
    return KEYWORD_OPTIONS[keyword];
}

/**
 * A `with { ... }` USAGE example per keyword, shown in its hover so the placement is clear: the
 * declaration keywords (`state`/`derived`/`deferred`) take `with` AFTER the value; the block keywords
 * (`effect`/`watch`) take it BEFORE the body. Same maintenance point as the options list - edit a line
 * here to change what a keyword's hover demonstrates.
 */
export const KEYWORD_WITH_EXAMPLE: Record<string, string> =
{
    state: 'state termsAccepted = false with { name: \'terms\' };',
    derived: 'derived total = price * quantity with { equals: (a, b) => a === b };',
    deferred: 'deferred results = query with { timeout: 300 };',
    effect: 'effect with { name: \'sync\' }\n{\n    save(data);\n}',
    watch: 'watch (count) with { defer: true }\n{\n    log(count);\n}',
    resource: 'resource user = (id) => fetchUser(id) with { source: selectedId };',
    stream: 'stream feed = (id) => openFeed(id) with { source: channelId, parse: \'sse\' };',
    selector: 'selector isActive = activeId with { equals: Object.is };'
};

/** The `with { ... }` usage example for a keyword, or undefined when it takes no options. */
export function keywordWithExample(keyword: string): string | undefined
{
    return KEYWORD_WITH_EXAMPLE[keyword];
}
