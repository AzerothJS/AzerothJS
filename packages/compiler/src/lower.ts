/**
 * MODULE: compiler/lower - lowering
 *
 * Markup AST + ReactiveAnalysis -> {@link RenderPlan}. Walks the component's markup output, builds the
 * static template tree (each node gets an id; dynamic insertion points become `hole`s or `slot`s), and
 * emits one Binding per dynamic point - wiring in the dependency sets analysis computed (looked up by
 * source span):
 *   - host elements -> `element` nodes with static attrs and dynamic attr/event/spread/ref bindings;
 *   - expression holes -> `text` bindings at `hole` nodes;
 *   - components and built-in control-flow -> `component` bindings at `slot` nodes (the co-range
 *     position);
 *   - fragments -> `fragment` nodes.
 *
 * Node ids are unique WITHIN a plan (codegen walks each plan's template independently), so a
 * component's markup children form a self-contained nested plan with its own id space and bindings.
 *
 * A render-function child (`<For>{(i) => ...}</For>`) whose body is a single host element lowers into a
 * CLONABLE sub-plan (tryLowerRenderClone); other render bodies pass through as the arrow expression.
 * Markup nested inside a hole expression (`{cond ? <a/> : <b/>}`, `{list.map(i => <li/>)}`) stays
 * inside that binding's expression and is compiled by codegen (lowerMarkup + emitNode) rather than
 * becoming template structure.
 *
 * NOTE on the analyze<->lower type cycle: analyze imports the VALUE `lowerMarkup` from here (the one
 * shared lowerer = single source of truth for "what dynamic expressions does this markup contain");
 * here we import only TYPES from analyze (erased at runtime). So `madge --circular` reports a cycle in
 * the TYPE graph that does not exist at runtime - intentional, see analyze.ts `projectMarkup`.
 *
 * @see {@link lowerComponent} - lower a full component's output
 * @see {@link lowerMarkup} - lower expression-embedded markup
 * @internal Compiler lowering stage; not part of the package's public API.
 */

import { isWhitespace, findMarkupStart } from './scanner.ts';
import { parseMarkup } from './markup-parser.ts';
import { isEventName, isFunctionLiteral } from './markup-util.ts';
import { BUILTIN_SET as BUILTINS } from './builtins.ts';
import type { MarkupElement, MarkupFragment, MarkupChild, MarkupAttribute, Span } from './types.ts';
import type { ComponentDecl } from './ast.ts';
// Type-only (erased at runtime, so the runtime module graph stays acyclic). The
// reverse edge - analyze importing the VALUE `lowerMarkup` from here - is
// deliberate: analyze and codegen share this one lowerer as the single source of
// truth for "what dynamic expressions does this markup contain", which avoids a
// second, drift-prone markup walker. That is why `madge --circular` reports an
// analyze<->lower cycle in the TYPE graph; it does not exist at runtime. See
// analyze.ts `projectMarkup`.
import type { ReactiveAnalysis, ReactiveScope } from './analyze.ts';
import type {
    RenderPlan,
    TemplateNode,
    StaticAttr,
    Binding,
    PropEntry,
    ComponentChildren,
    ReactiveExpr
} from './ir.ts';

/** Attributes h() applies as DOM properties rather than HTML attributes. */
const DOM_PROPERTIES = new Set(['value', 'checked', 'selected', 'innerHTML', 'textContent']);

/** Per-plan mutable lowering state: an id allocator and the binding sink. */
interface Ctx
{
    next: number;
    bindings: Binding[];
}

/**
 * lowerComponent
 *
 * PURPOSE:
 * Lowers a component's markup OUTPUT (its last markup body item) into a {@link RenderPlan},
 * or null when the component declares no markup output.
 *
 * WHY IT EXISTS:
 * It is the bridge from a parsed + analyzed component to the target-independent IR that codegen emits.
 * Keeping it separate from codegen splits "what to build and update" (lowering) from "how to emit it"
 * (the DOM/SSR/hydrate backends), so one IR drives all three.
 *
 * COMPILER / RUNTIME ROLE:
 * Compiler, lower stage; runs per component between analyzeComponent and codegen's emit
 * (generateComponent).
 *
 * INPUT CONTRACT:
 * - source: the original `.azeroth` text.
 * - component: the {@link ComponentDecl} from parseModule.
 * - analysis: the {@link ReactiveAnalysis} from analyzeComponent for THIS source + component.
 *
 * OUTPUT CONTRACT:
 * - A RenderPlan (static template + bindings), or null when there is no markup output to lower.
 *
 * WHY THIS DESIGN:
 * Dependency sets are indexed by each analyzed expression's source start, so every lowered binding
 * looks up its deps by span - decoupling lowering from re-running analysis and keeping the two stages
 * in lock-step through one shared key (the span).
 *
 * WHEN TO USE:
 * Codegen's per-component path.
 *
 * WHEN NOT TO USE:
 * For markup embedded inside an expression - use {@link lowerMarkup}, which skips analysis.
 *
 * EDGE CASES:
 * - Returns null for a component with no markup output.
 * - If several markup items exist, the LAST one is the output.
 *
 * PERFORMANCE NOTES:
 * A single walk of the markup; deps are looked up O(1) by span.
 *
 * DEVELOPER WARNING:
 * The `analysis` MUST match `source` + `component` - deps are keyed by span, so a stale analysis
 * silently mis-wires reactivity rather than erroring.
 *
 * @param source - The original `.azeroth` source
 * @param component - The component declaration (from `parseModule`)
 * @param analysis - The reactive analysis (from `analyzeComponent`)
 * @returns The lowered {@link RenderPlan}, or null when the component has no markup output
 * @see {@link lowerMarkup}
 * @see {@link RenderPlan}
 *
 * @example
 * ```ts
 * const m = parseModule('component C { state n = 0; <p>{n}</p> }');
 * const c = m.items[0] as ComponentDecl;
 * const plan = lowerComponent(src, c, analyzeComponent(src, c));
 * plan!.bindings[0].kind; // 'text'
 * ```
 *
 * @internal
 */
export function lowerComponent(source: string, component: ComponentDecl, analysis: ReactiveAnalysis): RenderPlan | null
{
    // Last markup body item is the output.
    let output: MarkupElement | MarkupFragment | null = null;
    for (const item of component.body)
    {
        if (item.kind === 'markup')
        {
            output = item.node;
        }
    }
    if (output === null)
    {
        return null;
    }

    // Dependency sets indexed by the analyzed expression's source start.
    const scopeByStart = new Map<number, ReactiveScope>();
    for (const scope of analysis.scopes)
    {
        if (scope.origin === 'text' || scope.origin === 'attribute')
        {
            scopeByStart.set(scope.span.start, scope);
        }
    }

    const ctx: Ctx = { next: 0, bindings: [] };
    const template = createLowerer(source, scopeByStart).lowerNode(output, ctx);
    return { template, bindings: ctx.bindings };
}

/**
 * lowerMarkup
 *
 * PURPOSE:
 * Lowers an arbitrary markup node - markup embedded inside an expression (`fallback={<p/>}`,
 * `{cond ? <a/> : <b/>}`, `{items.map(i => <li/>)}`) - into a {@link RenderPlan} with NO component
 * analysis.
 *
 * WHY IT EXISTS:
 * Expression-embedded markup lives inside arbitrary JS (a ternary, a `.map`, a prop value), so it can
 * NEVER be a clone template. Routing it through the SAME lowerer + emitNode is what lets the compiler
 * keep ONE markup emitter instead of a second markup->h() path (the single-source-of-truth goal).
 *
 * COMPILER / RUNTIME ROLE:
 * Compiler, lower stage; called by codegen's projectMarkup (to emit) and analyze's projectMarkup (to
 * collect reads).
 *
 * INPUT CONTRACT:
 * - source: the original `.azeroth` text.
 * - node: the embedded {@link MarkupElement} or {@link MarkupFragment}.
 *
 * OUTPUT CONTRACT:
 * - A RenderPlan whose bindings carry EMPTY dependency sets (no component scope was consulted).
 *
 * WHY THIS DESIGN:
 * No component scope is available for embedded markup, so deps are empty and codegen's wrapDynamic
 * heuristic decides reactivity at emit time. Reusing createLowerer with an empty scope map avoids a
 * second markup walker that would drift from this one.
 *
 * WHEN TO USE:
 * Lowering markup found inside an expression.
 *
 * WHEN NOT TO USE:
 * A component's top-level output - use {@link lowerComponent}, which wires real dependency sets.
 *
 * EDGE CASES:
 * - Empty deps means each binding's reactivity is decided by wrapDynamic, not by dep analysis.
 *
 * PERFORMANCE NOTES:
 * One walk; no analysis pass.
 *
 * DEVELOPER WARNING:
 * Because deps are empty, {@link isReactive} is NOT meaningful for these bindings - reactivity rests
 * entirely on codegen's heuristic. Don't read IR reactivity off a lowerMarkup plan.
 *
 * @param source - The original `.azeroth` source
 * @param node - The embedded markup element or fragment
 * @returns A {@link RenderPlan} with empty-dep bindings
 * @see {@link lowerComponent}
 *
 * @internal
 */
export function lowerMarkup(source: string, node: MarkupElement | MarkupFragment): RenderPlan
{
    const ctx: Ctx = { next: 0, bindings: [] };
    const template = createLowerer(source, new Map()).lowerNode(node, ctx);
    return { template, bindings: ctx.bindings };
}

/** Builds the lowering closures bound to a `source` and a dependency-scope map. */
function createLowerer(source: string, scopeByStart: Map<number, ReactiveScope>): { lowerNode: (node: MarkupElement | MarkupFragment, ctx: Ctx) => TemplateNode }
{
    const exprFor = (span: Span, lookupKey: number): ReactiveExpr =>
    {
        const scope = scopeByStart.get(lookupKey);
        return { span, deps: scope?.deps ?? [], pure: scope?.pure ?? true };
    };

    const lowerNode = (node: MarkupElement | MarkupFragment, ctx: Ctx): TemplateNode =>
    {
        if (node.kind === 'fragment')
        {
            return { kind: 'fragment', id: ctx.next++, children: node.children.map(child => lowerChild(child, ctx)) };
        }
        if (node.isComponent)
        {
            return lowerComponentElement(node, ctx);
        }

        const id = ctx.next++;
        const attrs: StaticAttr[] = [];
        // When any `class:name={cond}` directive is present, all class sources (static `class="..."`,
        // dynamic `class={expr}`, and the toggles) merge into one reactive ClassBinding; otherwise `class`
        // lowers as an ordinary attribute (behaviour unchanged for elements with no class directive).
        const hasClassDirective = node.attributes.some(a => !a.spread && typeof a.name === 'string' && a.name.startsWith('class:'));
        let classBase: string | null = null;
        let classDynamic: Span | null = null;
        const classToggles: { name: string; expr: Span }[] = [];
        // `style:prop={value}` merges the same way as class: static `style="..."` + dynamic `style={}` + props.
        const hasStyleDirective = node.attributes.some(a => !a.spread && typeof a.name === 'string' && a.name.startsWith('style:'));
        let styleBase: string | null = null;
        let styleDynamic: Span | null = null;
        const styleProps: { name: string; expr: Span }[] = [];
        for (const attr of node.attributes)
        {
            if (attr.spread)
            {
                ctx.bindings.push({ kind: 'spread', target: id, expr: exprFor(attrInnerSpan(source, attr), attr.start) });
                continue;
            }
            const name = attr.name as string;
            if (hasClassDirective && name === 'class')
            {
                if (attr.value.kind === 'static')
                {
                    classBase = attr.value.value;
                }
                else if (attr.value.kind === 'expression')
                {
                    classDynamic = attrInnerSpan(source, attr);
                }
                continue;
            }
            if (name.startsWith('class:'))
            {
                const cls = name.slice(6);
                // `class:name={cond}` toggles by condition; bare `class:name` is unconditional (folds into base).
                if (attr.value.kind === 'expression')
                {
                    classToggles.push({ name: cls, expr: attrInnerSpan(source, attr) });
                }
                else
                {
                    classBase = classBase ? `${ classBase } ${ cls }` : cls;
                }
                continue;
            }
            if (hasStyleDirective && name === 'style')
            {
                if (attr.value.kind === 'static')
                {
                    styleBase = attr.value.value;
                }
                else if (attr.value.kind === 'expression')
                {
                    styleDynamic = attrInnerSpan(source, attr);
                }
                continue;
            }
            if (name.startsWith('style:'))
            {
                if (attr.value.kind === 'expression')
                {
                    styleProps.push({ name: name.slice(6), expr: attrInnerSpan(source, attr) });
                }
                continue;
            }
            if (attr.value.kind === 'static')
            {
                attrs.push({ name, value: attr.value.value });
            }
            else if (attr.value.kind === 'none')
            {
                attrs.push({ name, value: true });
            }
            else if (name === 'ref')
            {
                ctx.bindings.push({ kind: 'ref', target: id, ref: attrInnerSpan(source, attr) });
            }
            else if (isEventName(name))
            {
                ctx.bindings.push({ kind: 'event', target: id, event: name.slice(2).toLowerCase(), handler: attrInnerSpan(source, attr) });
            }
            else if (name.startsWith('bind:'))
            {
                // `bind:value={state}` / `bind:checked={state}`: two-way binding to a form control. `checked`
                // writes back on `change`; everything else on `input`.
                const prop = name.slice(5);
                ctx.bindings.push({ kind: 'bind', target: id, prop, event: prop === 'checked' ? 'change' : 'input', expr: attrInnerSpan(source, attr) });
            }
            else
            {
                ctx.bindings.push({ kind: 'attribute', target: id, name, property: DOM_PROPERTIES.has(name), expr: exprFor(attrInnerSpan(source, attr), attr.start) });
            }
        }
        if (hasClassDirective)
        {
            ctx.bindings.push({ kind: 'class', target: id, base: classBase, dynamic: classDynamic, toggles: classToggles });
        }
        if (hasStyleDirective)
        {
            ctx.bindings.push({ kind: 'style', target: id, base: styleBase, dynamic: styleDynamic, props: styleProps });
        }

        return { kind: 'element', id, tag: node.tag, attrs, children: node.children.map(child => lowerChild(child, ctx)) };
    };

    const lowerChild = (child: MarkupChild, ctx: Ctx): TemplateNode =>
    {
        if (child.kind === 'text')
        {
            return { kind: 'text', id: ctx.next++, value: child.value };
        }
        if (child.kind === 'expression')
        {
            const id = ctx.next++;
            const span: Span = { start: child.start + 1, end: child.end - 1 };
            ctx.bindings.push({ kind: 'text', target: id, expr: exprFor(span, child.start) });
            return { kind: 'hole', id };
        }
        return lowerNode(child, ctx);
    };

    const lowerComponentElement = (node: MarkupElement, ctx: Ctx): TemplateNode =>
    {
        const id = ctx.next++;
        const props: PropEntry[] = [];
        for (const attr of node.attributes)
        {
            if (attr.spread)
            {
                props.push({ kind: 'spread', expr: exprFor(attrInnerSpan(source, attr), attr.start) });
                continue;
            }
            const name = attr.name as string;
            if (attr.value.kind === 'static')
            {
                props.push({ kind: 'static', name, value: attr.value.value });
            }
            else if (attr.value.kind === 'none')
            {
                props.push({ kind: 'static', name, value: true });
            }
            else if (isEventName(name))
            {
                props.push({ kind: 'event', event: name.slice(2).toLowerCase(), handler: attrInnerSpan(source, attr) });
            }
            else if (name.startsWith('bind:'))
            {
                // `bind:value={state}` / `bind:checked={state}` on a component: two-way binding sugar. It
                // passes the value prop AND a write-back callback the component invokes with the new value,
                // reusing the native event name (`checked` writes back through `onChange`, everything else
                // through `onInput`) so a component handler matches its DOM counterpart. The bound component
                // must accept the matching value prop and callback (the same shape an author would pass by
                // hand); a non-writable target (a `derived`) is rejected by the reactive rewrite.
                const prop = name.slice(5);
                props.push({ kind: 'bind', prop, event: prop === 'checked' ? 'change' : 'input', expr: attrInnerSpan(source, attr) });
            }
            else
            {
                props.push({ kind: 'prop', name, expr: exprFor(attrInnerSpan(source, attr), attr.start) });
            }
        }

        ctx.bindings.push({
            kind: 'component',
            target: id,
            tag: node.tag,
            builtin: BUILTINS.has(node.tag),
            props,
            children: lowerComponentChildren(node.children)
        });
        // A component/control-flow position is a `slot` (co-range marker), NOT a
        // text `hole` (reactive-hole marker) - the two serialize and adopt
        // differently.
        return { kind: 'slot', id };
    };

    // A render-fn child whose body is a single host-only markup element can be
    // lowered into a CLONABLE sub-plan (template + bindings, with the param
    // captured), so codegen can clone the row instead of building it with h()
    // per node. Returns null for anything else (block body, fragment, or a
    // component root) -> the caller falls back to the pass-through expression.
    const tryLowerRenderClone = (innerSpan: Span): ComponentChildren | null =>
    {
        const code = source.slice(innerSpan.start, innerSpan.end);
        const arrow = /^\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*</.exec(code);
        if (arrow === null)
        {
            return null;
        }
        const markupStart = findMarkupStart(source, innerSpan.start);
        if (markupStart === -1 || markupStart >= innerSpan.end)
        {
            return null;
        }
        let parsed: { node: MarkupElement | MarkupFragment; end: number };
        try
        {
            parsed = parseMarkup(source, markupStart);
        }
        catch
        {
            return null;
        }
        // A clone template must be a single host element (not a component or
        // fragment), and the markup must be the whole arrow body.
        if (parsed.node.kind !== 'element' || parsed.node.isComponent)
        {
            return null;
        }
        if (source.slice(parsed.end, innerSpan.end).trim() !== '')
        {
            return null;
        }
        const paramText = arrow[1];
        if (paramText === undefined)
        {
            return null;
        }
        const paramStart = innerSpan.start + code.indexOf(paramText);
        const param: Span = { start: paramStart, end: paramStart + paramText.length };
        const subCtx: Ctx = { next: 0, bindings: [] };
        const template = lowerNode(parsed.node, subCtx);
        // A render-fn row reads the param's per-row signals (`r.label()`), which
        // the component-source dep analysis cannot see, so their dep sets are
        // empty. Reactivity is decided by codegen's shape heuristic instead
        // (wrapDynamic): a call-shaped expression stays reactive, while a bare
        // reference (`row.id`) is bound ONCE - safe because a row render runs
        // exactly once per key, so anything that changes during the row's life
        // must be read through a getter call, which the heuristic wraps.
        return { kind: 'render', param, body: { template, bindings: subCtx.bindings } };
    };

    const lowerComponentChildren = (children: MarkupChild[]): ComponentChildren | null =>
    {
        if (children.length === 0)
        {
            return null;
        }
        const soloChild = children[0];
        if (children.length === 1 && soloChild !== undefined && soloChild.kind === 'expression')
        {
            const child = soloChild;
            const span: Span = { start: child.start + 1, end: child.end - 1 };
            const expr = exprFor(span, child.start);
            const code = source.slice(span.start, span.end).trim();
            if (isFunctionLiteral(code))
            {
                return tryLowerRenderClone(span) ?? { kind: 'render', param: null, body: expr };
            }
            return { kind: 'dynamic', expr };
        }
        // Markup children: a self-contained nested plan with its own id space.
        const ctx: Ctx = { next: 0, bindings: [] };
        const template: TemplateNode = { kind: 'fragment', id: ctx.next++, children: children.map(child => lowerChild(child, ctx)) };
        return { kind: 'markup', plan: { template, bindings: ctx.bindings } };
    };

    return { lowerNode };
}

/** The inner expression span of an attribute's `{ ... }` value (or spread arg). */
function attrInnerSpan(source: string, attr: MarkupAttribute): Span
{
    const open = source.indexOf('{', attr.start);
    let start = open + 1;
    let end = attr.end - 1;
    const trim = (): void =>
    {
        while (start < end && isWhitespace(source[start]))
        {
            start++;
        }
        while (end > start && isWhitespace(source[end - 1]))
        {
            end--;
        }
    };
    trim();
    if (attr.spread && source.startsWith('...', start))
    {
        start += 3;
        trim();
    }
    return { start, end };
}
