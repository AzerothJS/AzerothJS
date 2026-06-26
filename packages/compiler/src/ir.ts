/**
 * MODULE: compiler/ir - the Render Plan IR
 *
 * A target-INDEPENDENT description of how a component's output is built and updated. This is the
 * single source of truth: one IR is lowered to the DOM target, to SSR, and to hydration - so the
 * framework never hand-syncs two emitters again.
 *
 * SHAPE:
 *   - `template` is the STATIC skeleton (elements, static text, fragments) with `hole` markers at
 *     every dynamic text insertion point and `slot` markers at every component/control-flow position.
 *     It is structural, NOT an HTML string, so each target serializes it its own way (DOM clones it,
 *     SSR stringifies it, hydrate walks it). Every node carries an `id`; codegen turns ids into DOM
 *     walk paths (firstChild/nextSibling).
 *   - `bindings` are the DYNAMIC operations, each targeting a template node `id`. A binding reads its
 *     expression's dependency set (ReactiveExpr.deps): non-empty -> a targeted effect; empty ->
 *     evaluated once (not reactive), and bakeable into the template when also `pure`. The explicit
 *     ReactiveExpr.reactive flag overrides this for render-fn rows (see {@link isReactive}).
 *
 * Control-flow (Show/For/...) and user components are `component` bindings (builtin:true for the
 * runtime built-ins) that target a `slot` template node - their co-range position in
 * the static skeleton. They remain runtime components; compiling them away is future work that slots
 * in as new binding kinds without disturbing this contract.
 *
 * Pure DATA - no `typescript` import - so this module can feed every layer (compiler output, SSR,
 * tooling) without dragging the compiler into their graphs.
 *
 * @see {@link RenderPlan} - the top-level build-and-update plan
 * @see {@link TemplateNode} - the static skeleton node union
 * @see {@link Binding} - the dynamic-operation union
 * @internal Compiler IR; not part of the package's public API.
 */

import type { Span } from './types.ts';
import type { Dep } from './dep.ts';

/**
 * An expression to evaluate, with the reactivity facts analysis computed. `deps`
 * empty means the value never changes after setup (no effect needed);
 * `pure` (conservative) means it has no side effects, so a depless+pure value
 * can be baked straight into the template.
 */
export interface ReactiveExpr
{
    /** Source span of the expression (codegen emits this slice, projecting nested markup). */
    span: Span;
    /** Reactive sources read; empty => not reactive. */
    deps: Dep[];
    /** Conservative purity (may be refined later). */
    pure: boolean;
    /**
     * Explicit reactivity resolved at lower time, OVERRIDING the deps-derived
     * default. Set `true` for bindings inside a render-fn sub-plan:
     * they read the param's per-row signals (`r.label()`), which are invisible to
     * component-source dep analysis, so their `deps` are empty yet they are
     * genuinely reactive. Undefined => fall back to `deps` (see {@link isReactive}).
     */
    reactive?: boolean;
}

// --- Template (static skeleton) ---

/** A node in the static template. */
export type TemplateNode = TemplateElement | TemplateText | TemplateFragment | TemplateHole | TemplateSlot;

/** A static attribute baked into the template. `value: true` is a boolean attribute. */
export interface StaticAttr
{
    name: string;
    value: string | true;
}

/** A static host element. */
export interface TemplateElement
{
    kind: 'element';
    id: number;
    tag: string;
    attrs: StaticAttr[];
    children: TemplateNode[];
}

/** Static text content. */
export interface TemplateText
{
    kind: 'text';
    id: number;
    value: string;
}

/** A wrapperless children list (`<>...</>` or a component's children). */
export interface TemplateFragment
{
    kind: 'fragment';
    id: number;
    children: TemplateNode[];
}

/**
 * A reactive text/child insertion point. A `text` binding targets this `id` to
 * supply the live content; the serializer leaves the reactive-hole markers here
 * (`<!--[--><!--]-->` for DOM/clone, `<!--[-->value<!--]-->` for SSR). Component
 * and control-flow positions use a {@link TemplateSlot} instead.
 */
export interface TemplateHole
{
    kind: 'hole';
    id: number;
}

/**
 * A control-flow / component slot (`<Show>`, `<For>`, `<Switch>`, `<Dynamic>`, a
 * user component) in the static skeleton. The `component` binding targeting this
 * `id` drives its content. Serializes to the CO-RANGE marker
 * (`<!--azc:type--><!--/azc-->`), distinct from a {@link TemplateHole}'s
 * reactive-hole markers, so the unified backends adopt each correctly.
 * Distinguishing a component slot from a text hole is what lets
 * a component containing a `<For>` lower as a clonable host skeleton with a slot,
 * instead of falling back to the h() pipeline wholesale.
 */
export interface TemplateSlot
{
    kind: 'slot';
    id: number;
}

// --- Bindings (dynamic operations on template nodes) ---

/** A dynamic operation attached to a template node by `target` id. */
export type Binding =
    | TextBinding
    | AttributeBinding
    | EventBinding
    | BindBinding
    | ClassBinding
    | StyleBinding
    | SpreadBinding
    | RefBinding
    | ComponentBinding;

/** Reactive child/text content at a `hole`. */
export interface TextBinding
{
    kind: 'text';
    target: number;
    expr: ReactiveExpr;
}

/** A reactive attribute or DOM property on an element. */
export interface AttributeBinding
{
    kind: 'attribute';
    target: number;
    name: string;
    /** Set as a DOM property (`el.value = ...`) rather than an attribute. */
    property: boolean;
    expr: ReactiveExpr;
}

/** An event handler on an element. Handlers are values, never reactive. */
export interface EventBinding
{
    kind: 'event';
    target: number;
    /** DOM event name (lower-cased, e.g. `click`). */
    event: string;
    /** Source span of the handler expression. */
    handler: Span;
}

/**
 * A two-way binding from a `bind:value` / `bind:checked` directive on a form control. It lowers to BOTH a
 * reactive write of the DOM `prop` (`el.value = state()`) and a listener on `event` that writes the typed
 * value back to the state (`state = e.target.value`, rewritten to its setter). The bound expression must
 * be a writable `state` - assigning a `derived` is rejected by the reactive rewrite.
 */
export interface BindBinding
{
    kind: 'bind';
    target: number;
    /** The DOM property bound in both directions (`value` | `checked`). */
    prop: string;
    /** The DOM event that writes back (`input` for value, `change` for checked). */
    event: string;
    /** Source span of the bound state expression (the `{state}` interior). */
    expr: Span;
}

/**
 * The combined class of an element that uses at least one `class:name={cond}` directive. It merges a
 * static `class="..."` (base), a dynamic `class={expr}` (dynamic), and each `class:name={cond}` toggle
 * into ONE reactive class string: `[base, dynamic, cond && 'name', ...].filter(Boolean).join(' ')`. Only
 * emitted when a `class:` directive is present; otherwise `class` lowers as an ordinary attribute.
 */
export interface ClassBinding
{
    kind: 'class';
    target: number;
    /** A static `class="..."` value to prepend, or null. */
    base: string | null;
    /** A dynamic `class={expr}` span to merge, or null. */
    dynamic: Span | null;
    /** Each `class:name={cond}` directive: the class name and its condition span. */
    toggles: { name: string; expr: Span }[];
}

/**
 * The combined inline style of an element that uses at least one `style:prop={value}` directive. It
 * merges a static `style="..."` (base), a dynamic `style={expr}` (dynamic), and each `style:prop={value}`
 * into ONE reactive style string: `[base, dynamic, 'prop: ' + value, ...].filter(Boolean).join('; ')`.
 * Only emitted when a `style:` directive is present; otherwise `style` lowers as an ordinary attribute.
 */
export interface StyleBinding
{
    kind: 'style';
    target: number;
    /** A static `style="..."` value to prepend, or null. */
    base: string | null;
    /** A dynamic `style={expr}` span to merge, or null. */
    dynamic: Span | null;
    /** Each `style:prop={value}` directive: the CSS property and its value span. */
    props: { name: string; expr: Span }[];
}

/** A `{...spread}` props application on an element. */
export interface SpreadBinding
{
    kind: 'spread';
    target: number;
    expr: ReactiveExpr;
}

/** A `ref` on an element. */
export interface RefBinding
{
    kind: 'ref';
    target: number;
    /** Source span of the ref expression. */
    ref: Span;
}

/** A component (or built-in control-flow) invocation filling a `hole`. */
export interface ComponentBinding
{
    kind: 'component';
    target: number;
    /** Tag as written (`Counter`, `Foo.Bar`, `Show`, `For`). */
    tag: string;
    /** True for runtime built-ins (`Show`/`For`/...) the compiler auto-imports. */
    builtin: boolean;
    props: PropEntry[];
    children: ComponentChildren | null;
}

/** One entry in a component's props. */
export type PropEntry =
    | { kind: 'static'; name: string; value: string | true }
    | { kind: 'prop'; name: string; expr: ReactiveExpr }
    | { kind: 'event'; event: string; handler: Span }
    | { kind: 'bind'; prop: string; event: string; expr: Span }
    | { kind: 'spread'; expr: ReactiveExpr };

/** How a component receives its children. */
export type ComponentChildren =
    /** Markup children -> a nested plan (which may itself carry bindings). */
    | { kind: 'markup'; plan: RenderPlan }
    /** A render-function child (`{(item) => ...}`); body is markup or an expression. */
    | { kind: 'render'; param: Span | null; body: RenderPlan | ReactiveExpr }
    /** A dynamic `{expr}` children value. */
    | { kind: 'dynamic'; expr: ReactiveExpr };

// --- The plan ---

/** A component's (or a nested branch's) build-and-update plan. */
export interface RenderPlan
{
    template: TemplateNode;
    bindings: Binding[];
}

/**
 * True when a binding's expression actually changes after setup (needs an
 * effect). The explicit {@link ReactiveExpr.reactive} flag wins when set (render-fn
 * sub-plan bindings force it `true`); otherwise it is derived from
 * the dependency set.
 *
 * @param expr - The binding expression to classify.
 * @returns True if codegen must wrap it in a reactive effect; false to evaluate once.
 * @internal
 */
export function isReactive(expr: ReactiveExpr): boolean
{
    return expr.reactive ?? expr.deps.length > 0;
}
