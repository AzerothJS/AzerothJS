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
