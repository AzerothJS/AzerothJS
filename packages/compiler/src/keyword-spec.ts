/**
 * MODULE: compiler/keyword-spec - single source of truth for reactive keyword -> runtime mapping
 *
 * Every reactive component-body keyword maps to exactly one runtime helper, and the three emitters that
 * lower these keywords each used to hardcode that mapping plus the kind categories they branch on:
 *   - codegen.ts        emits the runtime JS call (`createSignal(...)`);
 *   - project.ts        emits the type-equivalent TS for the projection;
 *   - lower-reactive.ts lowers the SAME keywords when nested in an inner scope.
 *
 * Keeping the mapping and the categories here means renaming a runtime helper, or adding/reclassifying a
 * construct, is a one-line change in ONE place - and the three emitters can never drift on which helper a
 * keyword calls. The per-target EMIT mechanics (string rewrite vs mapped builder vs marker edits) stay in
 * each emitter; only the shared metadata they consult lives here.
 *
 * WHAT EARNS KEYWORD STATUS (and what does NOT):
 * A construct is a keyword only if it is a REACTIVE declaration that forces the compiler to transform
 * surrounding code - rewriting its reads (state/derived/deferred) or its initializer + `with { }` clause
 * (resource/stream/store/selector), and binding its lifecycle to the component's reactive root
 * (effect included). That compile-time reactivity is the entire justification for being syntax rather
 * than a plain runtime call.
 *
 * Imperative, non-reactive features are deliberately NOT keywords - notably `ref` (a DOM escape hatch:
 * `current` is a plain read, no reactive initializer, no dependency tracking, nothing to dispose) and the
 * `class` / `style` / spread markup directives. Their only compiler need is attribute routing, which lives
 * in the markup-binding layer, not here. Keeping them out preserves the invariant "keyword == reactive
 * construct"; do not add a keyword for a construct that does not participate in reactivity.
 *
 * @internal Compiler metadata; not part of the package's public API.
 */

/**
 * A reactive keyword construct kind: the {@link BodyItem} kinds that lower to a runtime call. Mirrors the
 * `kind` discriminants in ./ast.ts (props/markup/opaque are NOT constructs and are excluded).
 */
export type ConstructKind =
    | 'state' | 'derived' | 'deferred'
    | 'resource' | 'stream' | 'store' | 'selector' | 'form'
    | 'effect' | 'watch' | 'wrapper';

/**
 * Keyword kind -> the runtime helper it lowers to. `wrapper` is excluded: a wrapper block
 * (`batch`/`untrack`/`cleanup`/`dispose`) carries its own target function on its `fn` field, since the
 * keyword-to-helper choice is made by the parser there, not fixed per kind.
 */
export const RUNTIME_FN: Record<Exclude<ConstructKind, 'wrapper'>, string> =
{
    state: 'createSignal',
    derived: 'createMemo',
    deferred: 'createDeferred',
    resource: 'createResource',
    stream: 'createStream',
    store: 'createStore',
    selector: 'createSelector',
    form: 'createForm',
    effect: 'createEffect',
    watch: 'on'
};

/** A factory keyword kind. */
export type FactoryKind = 'resource' | 'stream' | 'store' | 'selector' | 'form';

/**
 * Factory keywords: declaration sugar that lowers to `const NAME = createX(...)` and is read EXPLICITLY
 * (`NAME.data()` / `NAME(key)`), so - unlike a source keyword - the read is never rewritten to a getter call.
 */
export const FACTORY_KINDS: ReadonlySet<ConstructKind> = new Set<ConstructKind>(
    ['resource', 'stream', 'store', 'selector']
);

/**
 * Reactive SOURCE keywords: read PLAIN (the reactive rewrite turns a bare read into a getter call within
 * scope). `state` is additionally writable (it gets a setter); `derived`/`deferred` are read-only.
 */
export const SOURCE_KINDS: ReadonlySet<ConstructKind> = new Set<ConstructKind>(
    ['state', 'derived', 'deferred']
);

/**
 * Every construct the nested-scope lowerer recognises at a statement position. The factory kinds are
 * included so {@link findConstructs} still skips PAST them (they are top-level-only sugar; the nested
 * lowerer detects but does not transform them), preserving today's behaviour exactly.
 */
export const LOWERABLE: ReadonlySet<string> = new Set<string>(
    [...SOURCE_KINDS, ...FACTORY_KINDS, 'effect', 'watch', 'wrapper']
);
