/**
 * MODULE: compiler/ast - the unified AST for the component pipeline
 *
 * Covers the MODULE level and the component BODY items. Inner JS/TS (declaration initializers, effect
 * bodies, props type members, opaque statement runs) is left as SPANS; the semantic pass hands those
 * to TypeScript rather than re-parsing them here.
 *
 * Spans reuse the `Span` convention from ./types.ts: `start` inclusive, `end` exclusive, offsets into
 * the original source.
 *
 * @see {@link Module} - the parsed module root
 * @see {@link ComponentDecl} - a `component Name { ... }` declaration
 */

import type { Span, MarkupElement, MarkupFragment } from './types.ts';

/** The whole parsed module. */
export interface Module extends Span
{
    kind: 'module';
    items: ModuleItem[];
}

/** A top-level item: either opaque host code or a component declaration. */
export type ModuleItem = OpaqueRegion | ComponentDecl;

/**
 * A run of verbatim JS/TS outside any component (imports, types, helpers).
 * The new pipeline copies it through unchanged and lets TypeScript own it.
 */
export interface OpaqueRegion extends Span
{
    kind: 'opaque';
}

/** A `component Name { ... }` declaration with its parsed body items. */
export interface ComponentDecl extends Span
{
    kind: 'component';

    /** The declared component name. */
    name: string;

    /** Span of the name identifier. */
    nameStart: number;
    nameEnd: number;

    /**
     * Span of the type-parameter list INCLUDING the angle brackets (`<T, U extends X>`), or null.
     * Set by the function-style signature form `component Name<T>(...) { ... }`; enables generics.
     */
    typeParams: Span | null;

    /**
     * Span of the component's PARAMETER - the verbatim text between the `(` and `)` of
     * `component Name(<param>) { ... }`, trimmed - or null when there is no parameter (`component Name { }`
     * / `component Name() { }`). The parameter is ordinary TypeScript and is NOT interpreted here; the
     * semantic pass hands it to TypeScript (see `parseComponentParam`) to recover the type annotation and,
     * for a destructuring binding, the prop aliases. Every standard function-parameter form is therefore
     * accepted with no Azeroth-specific rules: `props: T`, `{ a, b = d }: T`, and inline object types.
     */
    propsParam: Span | null;

    /** Span of the body's interior, exclusive of the surrounding `{` and `}`. */
    bodyStart: number;
    bodyEnd: number;

    /** Parsed body items, in source order. */
    body: BodyItem[];
}

/** Anything that can appear at the top level of a component body. */
export type BodyItem =
    | StateDecl
    | DerivedDecl
    | DeferredDecl
    | ResourceDecl
    | StreamDecl
    | StoreDecl
    | SelectorDecl
    | FormDecl
    | EffectBlock
    | WatchBlock
    | WrapperBlock
    | MarkupOutput
    | OpaqueStatements;

/**
 * A `state <name> ... ;` declaration. Only the name is extracted here; the
 * optional type annotation and the initializer are recovered by the semantic pass
 * from the TypeScript projection (`let <name> ... ;`).
 */
export interface StateDecl extends Span
{
    kind: 'state';
    name: string;
    nameStart: number;
    nameEnd: number;
    /** End of the value/initializer (before any `with { ... }` clause); used to slice the declaration. */
    valueEnd: number;
    /** Span of the `with { ... }` options object (braces included), or null when absent. */
    optionsStart: number | null;
    optionsEnd: number | null;
}

/** A `derived <name> ... ;` declaration (read-only reactive memo). */
export interface DerivedDecl extends Span
{
    kind: 'derived';
    name: string;
    nameStart: number;
    nameEnd: number;
    /** End of the value/initializer (before any `with { ... }` clause); used to slice the declaration. */
    valueEnd: number;
    /** Span of the `with { ... }` options object (braces included), or null when absent. */
    optionsStart: number | null;
    optionsEnd: number | null;
}

/**
 * A `deferred <name> = expr [with { ... }] ;` declaration - a read-only reactive value (like `derived`)
 * whose recomputation is deferred to idle time. Compiles to `createDeferred(() => (expr), options?)`.
 * Same shape as {@link DerivedDecl}; the distinct `kind` selects the runtime primitive.
 */
export interface DeferredDecl extends Span
{
    kind: 'deferred';
    name: string;
    nameStart: number;
    nameEnd: number;
    valueEnd: number;
    optionsStart: number | null;
    optionsEnd: number | null;
}

/**
 * The fields shared by the four FACTORY declarations (`resource`/`stream`/`store`/`selector`).
 *
 * Unlike `state`/`derived`/`deferred` (which read PLAIN - the compiler rewrites a read of the name to a
 * getter call), a factory returns an OBJECT or a function (a Resource `{ data, loading, error, refetch }`,
 * a Stream, a Store, or a selector predicate), so it is read EXPLICITLY (`user.data()`, `cart.items()`,
 * `isActive(id)`). Factories are therefore declaration sugar only - no read rewrite - and lower to a plain
 * `const name = createResource/createStream/createStore/createSelector(...)`.
 *
 * Each keyword has its OWN interface (below) so per-keyword fields can be added later without disturbing
 * the others; this base only collects what they have in common today.
 */
interface FactoryDeclBase extends Span
{
    name: string;
    nameStart: number;
    nameEnd: number;
    /** End of the value (before any `with { ... }` clause); used to slice the declaration. */
    valueEnd: number;
    /** Span of the `with { ... }` options object (braces included), or null when absent. */
    optionsStart: number | null;
    optionsEnd: number | null;
}

/**
 * A `resource <name> = <fetcher> [with { source: <signal> }] ;` declaration. Lowers to
 * `createResource(fetcher)` (standalone) or `createResource(() => (source), fetcher)` (source-driven, so
 * it refetches when `source` changes). Read as `name.data()` / `name.loading()` / `name.error()` /
 * `name.refetch()`.
 */
export interface ResourceDecl extends FactoryDeclBase { kind: 'resource' }

/**
 * A `stream <name> = <fetcher> [with { source: <signal>, ...streamOptions }] ;` declaration. Lowers to
 * `createStream([() => (source),] fetcher[, options])`. Read as `name.data()` / `name.loading()` /
 * `name.error()` / `name.done()` / `name.refetch()` / `name.cancel()`.
 */
export interface StreamDecl extends FactoryDeclBase { kind: 'stream' }

/**
 * A `store <name> = <factory> ;` declaration. Lowers to `createStore(factory)` (the factory is wrapped in
 * an arrow if it is a bare object literal). Read through its own accessors (`name.field()`).
 */
export interface StoreDecl extends FactoryDeclBase { kind: 'store' }

/**
 * A `selector <name> = <source> [with { equals }] ;` declaration. Lowers to
 * `createSelector(() => (source)[, options])`. Read as `name(key)` (a `boolean` for "is key selected").
 */
export interface SelectorDecl extends FactoryDeclBase { kind: 'selector' }

/**
 * A `form <name> = { ...initial } [with { validate, onSubmit }] ;` declaration. Lowers to
 * `createForm({ initial: { ...initial }, ...with })`. The initial object's keys ARE the form's fields;
 * a field is read as `name.<field>` and written as `name.<field> = v` (and via `bind:value={name.field}`)
 * once the field-access rewrite is in place, with `name.errors`/`name.submitting`/`name.handleSubmit`/...
 * exposing the rest of the form API.
 */
export interface FormDecl extends FactoryDeclBase { kind: 'form' }

/**
 * An `effect [with { ... }] { ... }` block; `body*` span the block interior.
 *
 * `effect { ... }` always auto-tracks: it runs on mount and re-runs when any reactive source it reads
 * changes. An optional `with { ... }` clause passes options (e.g. `name`) to `createEffect`. To run an
 * effect only AFTER mount, watch a specific dependency set with `watch (deps) with { defer: true }`.
 */
export interface EffectBlock extends Span
{
    kind: 'effect';
    bodyStart: number;
    bodyEnd: number;

    /** Span of the `with { ... }` options object (braces included), or null when absent. */
    optionsStart: number | null;
    optionsEnd: number | null;
}

/**
 * A `watch (deps) [(values, prev)] [with { ... }] { body }` block - an explicit-dependency effect that
 * compiles to the `on([...deps...], (values, prev) => { body }, options?)` runtime primitive. It watches
 * exactly the listed deps (the body's other reads do not subscribe); `with { defer: true }` skips the
 * mount run. The optional `(values, prev)` binds the current and previous dependency-value tuples.
 */
export interface WatchBlock extends Span
{
    kind: 'watch';
    /** Interior of the `(deps)` dependency list. */
    depsStart: number;
    depsEnd: number;
    /** Interior of the optional `(values, prev)` callback-parameter list, or null. */
    paramsStart: number | null;
    paramsEnd: number | null;
    /** Span of the `with { ... }` options object (braces included), or null. */
    optionsStart: number | null;
    optionsEnd: number | null;
    bodyStart: number;
    bodyEnd: number;
}

/**
 * A `<keyword> { body }` block-wrapper that lowers to `<fn>(() => { body })` - the family covering
 * `batch`/`untrack`/`cleanup`/`dispose`. The body is reactively rewritten like any effect/opaque run.
 */
export interface WrapperBlock extends Span
{
    kind: 'wrapper';
    /** The runtime function the keyword maps to: `batch` | `untrack` | `onCleanup` | `onRootDispose`. */
    fn: string;
    bodyStart: number;
    bodyEnd: number;
}

/** A markup region at body top level - the component's rendered output. */
export interface MarkupOutput extends Span
{
    kind: 'markup';
    node: MarkupElement | MarkupFragment;
}

/** A run of plain JS/TS setup statements (handed to TypeScript downstream). */
export interface OpaqueStatements extends Span
{
    kind: 'opaque-statements';
}
