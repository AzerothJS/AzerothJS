/**
 * MODULE: compiler/codegen - DOM codegen (the unified IR backend)
 *
 * Compiles a `.azeroth` module to JavaScript. Each `component` becomes a factory function; opaque
 * regions are copied verbatim; the runtime names used are auto-imported. e.g.
 * `<h1>Count: {count()}</h1>` becomes `h('h1', {}, 'Count: ', () => (count()))`.
 *
 * Inside a component:
 *   - state/derived/effect desugar to createSignal/createMemo/createEffect, and every emitted
 *     expression runs through the R2 rewrite (rewrite.ts): reactive reads/writes become
 *     getter/setter calls.
 *   - The markup output is emitted from ONE IR (the RenderPlan produced by lower.ts) through a single
 *     emitter, with NO legacy fallback:
 *       * an element-rooted output emits a MODE-DISPATCHED body (emitUnifiedBody): the IR->h() tree
 *         (emitNode) for SSR string + hydrate, and a hoisted tmpl() clone wired by
 *         firstChild/nextSibling paths for fresh DOM render;
 *       * a fragment-/slot-rooted output emits the IR->h() tree directly;
 *       * markup embedded inside an expression (fallback={<p/>}, {cond ? <a/> : <b/>}) is lowered
 *         (lowerMarkup) and emitted through the same emitNode in `raw` mode (reads left for the single
 *         outer rewrite).
 *     The IR's dependency sets (plus a fallback reactivity heuristic for reads the analysis can't see)
 *     pick per binding between a reactive getter and a set-once value. ONE emitter: clone in the DOM,
 *     serialize for SSR, adopt on hydrate.
 *
 * @see {@link generateModule} - the module emit entry point
 * @internal The compiler's codegen stage; not re-exported from the package's public index.
 */

import { findMarkupStart } from './scanner.ts';
import { parseMarkup, CompileError, VOID_ELEMENTS } from './markup-parser.ts';
import { isSetupHandler, setupHandlerMessage } from './handler.ts';
import { quoteString, wrapDynamic, FACTORY_ATTRS, objectKey, alreadyImports } from './markup-util.ts';
import { buildLineStarts, locationFor, encodeMappings, type SourceMapV3, type RawSegment } from './sourcemap.ts';
import type { MarkupElement, MarkupFragment, Span } from './types.ts';
import { parseModule } from './parser.ts';
import { diagnoseModule } from './diagnostics.ts';
import { analyzeComponent } from './analyze.ts';
import { lowerComponent, lowerMarkup } from './lower.ts';
import { optimize } from './optimize.ts';
import { parseDeclarationSlice, factoryPlan } from './ts-slice.ts';
import { RUNTIME_FN, RUNTIME_FN_FIELD_ARRAY, isFactoryItem } from './keyword-spec.ts';
import { rewriteReactive, setterName } from './rewrite.ts';
import { lowerStatements, lowerExpression, watchDepGetters } from './lower-reactive.ts';
import type { ReactiveSources } from './dep.ts';
import type { ComponentDecl } from './ast.ts';
import { isReactive, type RenderPlan, type TemplateNode, type Binding, type TextBinding, type BindBinding, type ClassBinding, type StyleBinding, type ReactiveExpr, type ComponentBinding, type ComponentChildren } from './ir.ts';

const RUNTIME_MODULE = 'azerothjs';

/** Empty reactive-source set, for compiling markup in module scope (no component state in scope). */
const NO_SOURCES: ReactiveSources = { names: new Set(), hasProps: false };

/** Result of compiling a `.azeroth` module with the new pipeline. */
export interface CompileResult
{
    code: string;
    map: SourceMapV3 | null;
}

/** Options for {@link generateModule}. */
export interface GenerateOptions
{
    /**
     * Emit for SSR/hydration as well as the client (the default). Set `false` for a
     * CLIENT-ONLY build: each component body emits just the template-clone path, dropping
     * the `isStringMode()/isHydrating()` guard and the entire h()-tree branch - roughly
     * half the compiled output - for apps that never server-render.
     */
    ssr?: boolean;
}

/** Tracks runtime names used and templates hoisted while emitting a module. */
interface Emit
{
    used: Set<string>;
    templates: Map<string, string>;

    /** Client-only build: skip the SSR/hydration branch in every component body. */
    clientOnly: boolean;
    /**
     * True while emitting markup embedded inside an expression (`emitMarkupExpr`).
     * In this mode the emit helpers leave reads RAW - a single outer
     * `rewriteReactive` (in the enclosing `rewriteExpr`) rewrites the whole
     * projected expression once. The non-idempotent rewrite must not run twice.
     */
    raw: boolean;
}

/** Interns a template HTML string, returning its hoisted const name. */
function allocateTemplate(emit: Emit, html: string): string
{
    const existing = emit.templates.get(html);
    if (existing !== undefined)
    {
        return existing;
    }
    const name = `_tmpl$${ emit.templates.size + 1 }`;
    emit.templates.set(html, name);
    return name;
}

/**
 * Returns an event handler's source text, after REJECTING forms that would run at setup
 * instead of on the event - an assignment, `++`/`--`, or a zero-arg call of a plain
 * reference. Such an expression is not a function, so wiring it as a listener is a compile
 * error; the author must wrap it (`{ () => handler }`). Shares one classifier with
 * diagnoseModule via {@link isSetupHandler}, so the build-time diagnostic and this emit-time
 * guard always agree.
 *
 * @internal
 */
function handlerSource(source: string, handler: Span): string
{
    const code = source.slice(handler.start, handler.end);
    if (isSetupHandler(code))
    {
        throw new CompileError(setupHandlerMessage(code.trim()), handler.start);
    }
    return code;
}

/**
 * generateModule
 *
 * PURPOSE:
 * Compiles a whole `.azeroth` module (written with `component` syntax) to JavaScript plus a source map.
 *
 * WHY IT EXISTS:
 * It is the compiler's emit entry point - it turns a parsed module (a sequence of components and
 * opaque non-component regions) into a runnable JS module, wiring the runtime import and the hoisted
 * template consts. The Vite plugin calls it once per `.azeroth` file.
 *
 * COMPILER / RUNTIME ROLE:
 * Compiler, codegen; the top of the emit stage. Drives parseModule -> per-component
 * analyze/lower/optimize -> emit, then assembles imports + hoisted tmpl() consts.
 *
 * INPUT CONTRACT:
 * - source: the `.azeroth` module text.
 * - filename: used only for the source map's `sources` (default 'module.azeroth').
 *
 * OUTPUT CONTRACT:
 * - { code, map }: emitted JS and its SourceMapV3. `map` is null when the module contained NO
 *   component (nothing component-shaped to map; the text is returned essentially as-is).
 *
 * WHY THIS DESIGN:
 * Module items are walked in order: opaque regions are pushed verbatim (so ordinary TS/JS - imports,
 * helpers, types - passes through untouched) and each component is emitted via generateComponent.
 * Used runtime names and hoisted templates are collected DURING emission, then a single import line
 * plus the `const _tmpl$N = tmpl(...)` consts are prepended. A piece table maps emitted ranges back
 * to source for the map.
 *
 * WHEN TO USE:
 * Compiling a `.azeroth` file (the plugin path), or programmatically to inspect emitted output.
 *
 * WHEN NOT TO USE:
 * For markup embedded inside an expression (handled internally by projectMarkup); for diagnostics
 * without emission (use diagnoseModule).
 *
 * EDGE CASES:
 * - A module with no component returns its concatenated output with map=null.
 * - Templates are interned, so identical markup hoists to one shared `_tmpl$N`; tmpl is imported only
 *   when at least one template exists.
 *
 * PERFORMANCE NOTES:
 * One parse, then per-component analyze/lower/optimize; template interning dedupes repeated markup.
 *
 * DEVELOPER WARNING:
 * Emitted code imports from 'azerothjs' - the output is NOT standalone; it needs the runtime.
 * This is a compiler-internal entry (not re-exported from the package index), so treat its output
 * shape as an implementation detail.
 *
 * @param source - The `.azeroth` module source
 * @param filename - Used in the source map (default 'module.azeroth')
 * @returns The compiled JS and its source map (map is null when nothing component-shaped was emitted)
 * @see {@link parseModule}
 * @see {@link CompileResult}
 *
 * @example
 * ```ts
 * const { code } = generateModule('component Hi { <h1>hi</h1> }');
 * // code contains: function Hi(props) { ... return _tmpl$1(); }
 * ```
 *
 * @internal
 */
export function generateModule(source: string, filename = 'module.azeroth', options: GenerateOptions = {}): CompileResult
{
    // Semantic-validation gate: ANY error-severity diagnostic fails the compile here, before
    // a single line is emitted. generateModule is the one enforcement point, so the Vite
    // plugin and standalone callers reject identical inputs (no silent emit on either path).
    // (diagnoseModule parses internally; malformed-markup parse errors surface here too.)
    const errors = diagnoseModule(source).filter(d => d.severity === 'error');
    if (errors.length > 0)
    {
        const first = errors[0];
        if (first === undefined)
        {
            throw new CompileError('markup parse failed', 0);
        }
        throw new CompileError(`${ first.code }: ${ first.message }`, first.start);
    }

    const module = parseModule(source);
    const emit: Emit = { used: new Set(), templates: new Map(), clientOnly: options.ssr === false, raw: false };

    interface Piece { outStart: number; sourceStart: number; verbatim: boolean; }
    const pieces: Piece[] = [];
    let out = '';
    const push = (text: string, sourceStart: number, verbatim: boolean): void =>
    {
        pieces.push({ outStart: out.length, sourceStart, verbatim });
        out += text;
    };

    let hadComponent = false;
    for (const item of module.items)
    {
        if (item.kind === 'opaque')
        {
            // Compile any markup in module-scope code too - e.g. a top-level helper `const renderRow
            // = () => <li/>` (possibly shared by several components). No component reactive scope
            // applies here, so reads stay verbatim (NO_SOURCES). Regions with no markup are unchanged
            // and stay verbatim for clean source maps.
            const raw = source.slice(item.start, item.end);
            const projected = projectMarkup(raw, emit, NO_SOURCES);
            // A module-level "composable" (a plain function using the keywords) lowers here too.
            // Guard on a keyword token so keyword-free module code (imports, types, helpers) stays
            // byte-identical for clean source maps.
            if (/\b(?:state|derived|effect)\b/.test(projected))
            {
                const { code, used } = lowerStatements(projected, NO_SOURCES, item.start);
                for (const name of used)
                {
                    emit.used.add(name);
                }
                push(code, item.start, false);
            }
            else
            {
                push(projected, item.start, projected === raw);
            }
        }
        else
        {
            hadComponent = true;
            push(generateComponent(source, item, emit), item.start, false);
        }
    }

    // Nothing to wire if there were no components AND no module-scope markup was compiled.
    if (!hadComponent && emit.used.size === 0 && emit.templates.size === 0)
    {
        return { code: out, map: null };
    }

    // The hoisted template consts call tmpl(), so import it when any exist.
    if (emit.templates.size > 0)
    {
        emit.used.add('tmpl');
    }
    const importLine = buildImport(source, emit);
    const hoisted = emit.templates.size > 0
        ? [...emit.templates].map(([html, name]) => `const ${ name } = tmpl(${ quoteString(html) });`).join('\n') + '\n'
        : '';
    const prefix = importLine + hoisted;
    const code = prefix + out;

    return { code, map: buildSourceMap(code, prefix.length, pieces, source, filename) };
}

/**
 * IR validation (runs after optimize, before any emit). Asserts the Render Plan's structural
 * invariants so a malformed IR can never reach codegen and silently produce wrong output:
 *   - template node ids are unique;
 *   - every binding targets an existing node;
 *   - the target's kind matches the binding (text->hole, component->slot, the rest->element).
 * A violation is a COMPILER bug (not user input), so it throws rather than degrading. Reads/
 * writes (no undefined setter, no derived mutation) are already enforced by the reactive
 * rewrite; this pass guards the template/binding graph.
 *
 * @internal
 */
function validatePlan(plan: RenderPlan): void
{
    const kindById = new Map<number, TemplateNode['kind']>();
    const walk = (node: TemplateNode): void =>
    {
        if (kindById.has(node.id))
        {
            throw new CompileError(`IR validation: duplicate template node id ${ node.id }`, 0);
        }
        kindById.set(node.id, node.kind);
        if (node.kind === 'element' || node.kind === 'fragment')
        {
            for (const child of node.children)
            {
                walk(child);
            }
        }
    };
    walk(plan.template);

    const expected: Record<Binding['kind'], TemplateNode['kind']> =
    {
        text: 'hole',
        attribute: 'element',
        event: 'element',
        bind: 'element',
        class: 'element',
        style: 'element',
        spread: 'element',
        ref: 'element',
        component: 'slot'
    };
    for (const binding of plan.bindings)
    {
        const actual = kindById.get(binding.target);
        if (actual === undefined)
        {
            throw new CompileError(`IR validation: ${ binding.kind } binding targets unknown node id ${ binding.target }`, 0);
        }
        if (actual !== expected[binding.kind])
        {
            throw new CompileError(`IR validation: ${ binding.kind } binding targets a '${ actual }' node (expected '${ expected[binding.kind] }')`, 0);
        }
    }
}

/** Emits a single component as a factory function. */
function generateComponent(source: string, component: ComponentDecl, emit: Emit): string
{
    const analysis = analyzeComponent(source, component);
    const lowered = lowerComponent(source, component, analysis);
    const plan = lowered === null ? null : optimize(source, lowered);
    if (plan !== null)
    {
        validatePlan(plan);
    }
    const sources: ReactiveSources =
    {
        names: new Set(analysis.sources.map(s => s.name)),
        hasProps: analysis.hasProps,
        // Only `state` has a generated setter; `derived` is read-only. The rewrite uses this
        // to reject (rather than mis-emit a setter for) any write to a derived value.
        writable: new Set(analysis.sources.filter(s => s.kind === 'state').map(s => s.name)),
        // Destructured signature props (`component Name({ a }: P)`): the rewrite turns a bare `a` into `props.a`.
        propAliases: analysis.propAliases,
        // `form` declarations: a field read `f.name` becomes `f.values().name`, a write `f.name = v` becomes
        // `f.setValue('name', v)` (so `bind:value={f.name}` works); FormApi access (`f.errors()`) is untouched.
        forms: analysis.forms,
        // Array-form `<For>` row variables: `row.name` becomes `row.form.values().name` (through `.form`).
        rowForms: analysis.rowForms
    };

    const lines: string[] = [];
    for (const item of component.body)
    {
        if (item.kind === 'state')
        {
            const parsed = parseDeclarationSlice(source, item);
            const init = parsed?.initializer ? rewriteReactive(parsed.initializer.getText(parsed.sourceFile), sources) : 'undefined';
            const typeArg = parsed?.type ? `<${ parsed.type.getText(parsed.sourceFile) }>` : '';
            const opts = item.optionsStart !== null && item.optionsEnd !== null ? `, ${ rewriteReactive(source.slice(item.optionsStart, item.optionsEnd), sources) }` : '';
            emit.used.add(RUNTIME_FN.state);
            lines.push(`const [${ item.name }, ${ setterName(item.name) }] = ${ RUNTIME_FN.state }${ typeArg }(${ init }${ opts });`);
        }
        else if (item.kind === 'derived' || item.kind === 'deferred')
        {
            const parsed = parseDeclarationSlice(source, item);
            const init = parsed?.initializer ? rewriteReactive(parsed.initializer.getText(parsed.sourceFile), sources) : 'undefined';
            const opts = item.optionsStart !== null && item.optionsEnd !== null ? `, ${ rewriteReactive(source.slice(item.optionsStart, item.optionsEnd), sources) }` : '';
            const fn = RUNTIME_FN[item.kind];
            emit.used.add(fn);
            lines.push(`const ${ item.name } = ${ fn }(() => (${ init })${ opts });`);
        }
        else if (item.kind === 'form')
        {
            // `form NAME = { ...initial } [with { validate, onSubmit }]` -> a `createForm` declaration:
            // the `= { ... }` value is the form's `initial`, and the `with { ... }` object is spread in to
            // supply `validate`/`onSubmit`. Both go through the reactive rewrite so a `state` read inside
            // them becomes a getter call. Read explicitly for now (NAME.values()/NAME.setValue); the
            // field-access sugar that makes `bind:value={NAME.field}` work is layered on in the rewrite.
            const parsed = parseDeclarationSlice(source, item);
            const initial = parsed?.initializer ? rewriteReactive(parsed.initializer.getText(parsed.sourceFile), sources) : '{}';
            const withObj = item.optionsStart !== null && item.optionsEnd !== null
                ? rewriteReactive(source.slice(item.optionsStart, item.optionsEnd), sources)
                : null;
            if (item.isArray)
            {
                // `form NAME[] = { ...blankRow } [with { ... }]` -> a `createFieldArray` declaration: the
                // `= { ... }` value is the BLANK row (wrapped in a `blank` thunk), and the `with { ... }`
                // object supplies validate/validateArray/etc. Read explicitly (NAME.rows()/NAME.append()).
                emit.used.add(RUNTIME_FN_FIELD_ARRAY);
                const config = withObj !== null
                    ? `{ blank: () => (${ initial }), ...(${ withObj }) }`
                    : `{ blank: () => (${ initial }) }`;
                lines.push(`const ${ item.name } = ${ RUNTIME_FN_FIELD_ARRAY }(${ config });`);
            }
            else
            {
                emit.used.add(RUNTIME_FN.form);
                const config = withObj !== null ? `{ initial: (${ initial }), ...(${ withObj }) }` : `{ initial: (${ initial }) }`;
                lines.push(`const ${ item.name } = ${ RUNTIME_FN.form }(${ config });`);
            }
        }
        else if (isFactoryItem(item))
        {
            // Factory keywords are declaration sugar: `const NAME = createX(...)`, read explicitly
            // (NAME.data()/NAME.items()/NAME(key)). The value and any with-clause expressions still go
            // through the reactive rewrite so a state read inside them becomes a call. factoryPlan owns the
            // shared argument-shape decision (source split / value wrap / trailing options); here we render
            // it as runtime JS, applying the reactive rewrite to the value and the with-clause pieces.
            const parsed = parseDeclarationSlice(source, item);
            const value = parsed?.initializer ? rewriteReactive(parsed.initializer.getText(parsed.sourceFile), sources) : 'undefined';
            const optsText = item.optionsStart !== null && item.optionsEnd !== null ? source.slice(item.optionsStart, item.optionsEnd) : null;
            const plan = factoryPlan(item.kind, optsText, parsed?.initializer);

            const sourceArg = plan.source !== null ? `() => (${ rewriteReactive(plan.source, sources) }), ` : '';
            const valueArg = plan.wrapValue ? `() => (${ value })` : value;
            const trailing = plan.rest !== null ? `, ${ rewriteReactive(plan.rest, sources) }`
                : plan.opts !== null ? `, ${ rewriteReactive(plan.opts, sources) }` : '';
            emit.used.add(plan.fn);
            lines.push(`const ${ item.name } = ${ plan.fn }(${ sourceArg }${ valueArg }${ trailing });`);
        }
        else if (item.kind === 'effect')
        {
            const bodyCode = rewriteBody(source, item.bodyStart, item.bodyEnd, sources, emit);
            emit.used.add(RUNTIME_FN.effect);
            // `with { ... }` passes options (e.g. `name`) to createEffect; effect is always auto-tracked.
            const optionsArg = item.optionsStart !== null && item.optionsEnd !== null ? `, ${ rewriteReactive(source.slice(item.optionsStart, item.optionsEnd), sources) }` : '';
            lines.push(`${ RUNTIME_FN.effect }(() => {${ bodyCode }}${ optionsArg });`);
        }
        else if (item.kind === 'watch')
        {
            const bodyCode = rewriteBody(source, item.bodyStart, item.bodyEnd, sources, emit);
            emit.used.add(RUNTIME_FN.watch);
            const deps = watchDepGetters(source.slice(item.depsStart, item.depsEnd), sources, true).join(', ');
            const params = item.paramsStart !== null && item.paramsEnd !== null ? source.slice(item.paramsStart, item.paramsEnd) : '';
            const optionsArg = item.optionsStart !== null && item.optionsEnd !== null ? `, ${ rewriteReactive(source.slice(item.optionsStart, item.optionsEnd), sources) }` : '';
            lines.push(`${ RUNTIME_FN.watch }([${ deps }], (${ params }) => {${ bodyCode }}${ optionsArg });`);
        }
        else if (item.kind === 'wrapper')
        {
            const bodyCode = rewriteBody(source, item.bodyStart, item.bodyEnd, sources, emit);
            emit.used.add(item.fn);
            lines.push(`${ item.fn }(() => {${ bodyCode }});`);
        }
        else if (item.kind === 'opaque-statements')
        {
            lines.push(rewriteBody(source, item.start, item.end, sources, emit));
        }
    }

    lines.push(emitOutput(source, plan, sources, emit));

    const body = lines.map(line => `    ${ line }`).join('\n');
    // Carry through any type parameters from a `component Name<T>(...)` signature so the body's `T`
    // references resolve; oxc strips them for the runtime output.
    const typeParams = component.typeParams ? source.slice(component.typeParams.start, component.typeParams.end) : '';
    return `function ${ component.name }${ typeParams }(props)\n{\n${ body }\n}`;
}

/** Emits the component's rendered output via the unified IR-driven emitter. */
function emitOutput(source: string, plan: RenderPlan | null, sources: ReactiveSources, emit: Emit): string
{
    if (plan === null)
    {
        return 'return null;';
    }

    const elementRoot = plan.template.kind === 'element' && !hasFragment(plan.template);

    // Every element-rooted output emits the unified MODE-DISPATCHED body by default -
    // host-only AND control-flow/component slots. The one artifact clones in dom,
    // serializes in string, adopts in hydrate, so it is correct in every mode
    // (target-independent).
    if (elementRoot)
    {
        return emitUnifiedBody(source, plan, sources, emit);
    }

    // Fragment-root / slot-root / element-with-nested-fragment outputs
    // can't clone (no single element root), but are still IR-driven - the mode-aware
    // IR->h() emitter builds in dom, serializes in string, and adopts in hydrate, all
    // through h(): one emitter for top-level output.
    // Parenthesized so a leading newline in the emitted expression cannot trigger ASI
    // (`return` + line break silently becomes `return;`).
    return `return (${ emitNode(source, plan.template, plan, sources, emit) });`;
}

/**
 * True when an element's children are exactly one hole (`<td>{ expr }</td>`).
 * Such a hole needs NO comment anchors: the element itself bounds the content,
 * so the template stays anchor-free and the binding drives the element's
 * textContent directly (bindContent) - one text node instead of two comments
 * plus a marker scan per hole.
 */
function onlyChildHoleOf(node: TemplateNode): TemplateNode | null
{
    if (node.kind !== 'element' || node.children.length !== 1)
    {
        return null;
    }
    const child = node.children[0];
    return child !== undefined && child.kind === 'hole' ? child : null;
}

/** Collects the ids of holes that are their element's only child. */
function collectOnlyChildHoles(node: TemplateNode, into: Set<number>): void
{
    const hole = onlyChildHoleOf(node);
    if (hole !== null)
    {
        into.add(hole.id);
        return;
    }
    if (node.kind === 'element' || node.kind === 'fragment')
    {
        for (const child of node.children)
        {
            collectOnlyChildHoles(child, into);
        }
    }
}

/** Emits the template-clone path for a host-only output. */
function emitTemplatePath(source: string, plan: RenderPlan, sources: ReactiveSources, emit: Emit): string
{
    const onlyChildHoles = new Set<number>();
    collectOnlyChildHoles(plan.template, onlyChildHoles);

    const html = serialize(plan.template);
    const templateName = allocateTemplate(emit, html);

    const paths = new Map<number, number[]>();
    computePaths(plan.template, [], paths);

    // Group element bindings by target node. A node with only attribute/event
    // bindings is wired DIRECTLY (setProp + addEventListener) - the tiny-runtime
    // path with no props object or dispatch loop. A node carrying a spread or ref
    // keeps the general bindProps, whose merge/ref semantics are the runtime's job.
    // Component bindings (control-flow / component slots) are collected separately
    // and driven into their co-range via bindSlot.
    const elementBindings = new Map<number, Binding[]>();
    const componentBindings: ComponentBinding[] = [];
    for (const binding of plan.bindings)
    {
        if (binding.kind === 'text')
        {
            continue;
        }
        if (binding.kind === 'component')
        {
            componentBindings.push(binding);
            continue;
        }
        const group = elementBindings.get(binding.target) ?? [];
        group.push(binding);
        elementBindings.set(binding.target, group);
    }

    const textBindings = plan.bindings.filter((b): b is TextBinding => b.kind === 'text');
    const boundIds = new Set<number>([
        ...elementBindings.keys(),
        ...textBindings.map(b => b.target),
        ...componentBindings.map(b => b.target)
    ]);

    const decls = [...boundIds].map(id => `const ${ nodeVar(id) } = ${ pathExpr(paths.get(id) ?? []) };`);

    const binds: string[] = [];
    for (const [target, group] of elementBindings)
    {
        if (group.some(b => b.kind === 'spread' || b.kind === 'ref'))
        {
            emit.used.add('bindProps');
            binds.push(`bindProps(${ nodeVar(target) }, { ${ group.map(b => propEntry(source, b, sources, emit)).join(', ') } });`);
            continue;
        }
        for (const binding of group)
        {
            if (binding.kind === 'attribute')
            {
                emit.used.add('setProp');
                const value = rewriteExpr(source, binding.expr, sources, emit);
                // Reactive when the analysis sees a dependency (or an explicit reactive flag), OR the
                // fallback heuristic treats the value as dynamic (a store/imported-signal read the
                // analysis can't see). Otherwise set once.
                if (isReactive(binding.expr) || wrapDynamic(value, false) !== value)
                {
                    emit.used.add('createEffect');
                    binds.push(`createEffect(() => setProp(${ nodeVar(target) }, ${ quoteString(binding.name) }, ${ value }));`);
                }
                else
                {
                    binds.push(`setProp(${ nodeVar(target) }, ${ quoteString(binding.name) }, ${ value });`);
                }
            }
            else if (binding.kind === 'event')
            {
                // bindEvent delegates bubbling event types to one document-level
                // listener (matching the bindProps path); non-bubbling types fall
                // back to a per-element listener inside the helper.
                emit.used.add('bindEvent');
                binds.push(`bindEvent(${ nodeVar(target) }, ${ quoteString(binding.event) }, ${ rewriteReactive(handlerSource(source, binding.handler), sources, binding.handler.start) });`);
            }
            else if (binding.kind === 'bind')
            {
                // Two-way: reactively write the DOM property from the state, and write the state back on the
                // control's input/change event.
                emit.used.add('setProp');
                emit.used.add('createEffect');
                emit.used.add('bindEvent');
                binds.push(`createEffect(() => setProp(${ nodeVar(target) }, ${ quoteString(binding.prop) }, ${ bindValue(source, binding, sources) }));`);
                binds.push(`bindEvent(${ nodeVar(target) }, ${ quoteString(binding.event) }, ${ bindHandler(source, binding, sources) });`);
            }
            else if (binding.kind === 'class')
            {
                // All class sources (static/dynamic/`class:` toggles) merged into one reactive className.
                emit.used.add('setProp');
                emit.used.add('createEffect');
                binds.push(`createEffect(() => setProp(${ nodeVar(target) }, 'class', ${ classCombined(source, binding, sources) }));`);
            }
            else if (binding.kind === 'style')
            {
                emit.used.add('setProp');
                emit.used.add('createEffect');
                binds.push(`createEffect(() => setProp(${ nodeVar(target) }, 'style', ${ styleCombined(source, binding, sources) }));`);
            }
        }
    }
    for (const binding of textBindings)
    {
        // An only-child hole drives its element's content directly (no anchors
        // in the clone); any other hole goes through the anchor-pair scheme.
        if (onlyChildHoles.has(binding.target))
        {
            emit.used.add('bindContent');
            binds.push(`bindContent(${ nodeVar(binding.target) }, ${ exprValue(source, binding.expr, sources, emit) });`);
        }
        else
        {
            emit.used.add('bindHole');
            binds.push(`bindHole(${ nodeVar(binding.target) }, ${ exprValue(source, binding.expr, sources, emit) });`);
        }
    }
    for (const binding of componentBindings)
    {
        emit.used.add('bindSlot');
        binds.push(`bindSlot(${ nodeVar(binding.target) }, ${ emitComponentCall(source, binding, sources, emit) });`);
    }

    return [`const _r = ${ templateName }();`, ...decls, ...binds, 'return _r;'].join('\n    ');
}

/**
 * Emits a component (or render-row) body as a MODE-DISPATCHED unified output:
 * `if (isStringMode() || isHydrating()) return <IR->h() tree>;`
 * then the dom-mode `tmpl()` clone. The IR->h() tree is mode-aware - the runtime
 * `h()` serializes it in string mode (SSR) and returns adoption descriptors in
 * hydrate mode, so SSR and hydration share ONE emitter and their markers align by
 * construction. Only a fresh dom render takes the clone path. The module-level
 * `tmpl()` const is inert until cloned, so the non-dom branch never reaches it.
 */
function emitUnifiedBody(source: string, plan: RenderPlan, sources: ReactiveSources, emit: Emit): string
{
    // Client-only build: no mode dispatch, no h()-tree branch - just the clone.
    if (emit.clientOnly)
    {
        return emitTemplatePath(source, plan, sources, emit);
    }
    emit.used.add('isStringMode');
    emit.used.add('isHydrating');
    const adoptOrSerialize = emitNode(source, plan.template, plan, sources, emit);
    const clone = emitTemplatePath(source, plan, sources, emit);
    return `if (isStringMode() || isHydrating())\n    {\n        return (${ adoptOrSerialize });\n    }\n    ${ clone }`;
}

/**
 * Emits a control-flow / component invocation from its IR binding:
 * `Tag({ get prop() {...}, get children() {...} })`, following the getter-object
 * prop contract. Built-ins are
 * auto-imported; user components rely on the source's own import.
 */
function emitComponentCall(source: string, binding: ComponentBinding, sources: ReactiveSources, emit: Emit): string
{
    if (binding.builtin)
    {
        emit.used.add(binding.tag);
    }

    const parts: string[] = [];
    for (const prop of binding.props)
    {
        if (prop.kind === 'spread')
        {
            parts.push(`...${ rewriteExpr(source, prop.expr, sources, emit) }`);
        }
        else if (prop.kind === 'static')
        {
            parts.push(`${ objectKey(prop.name) }: ${ prop.value === true ? 'true' : quoteString(prop.value) }`);
        }
        else if (prop.kind === 'event')
        {
            const handler = maybeRewrite(emit, handlerSource(source, prop.handler), sources, prop.handler.start);
            // Parens guard against ASI when the user-authored handler starts on its own line.
            parts.push(`get on${ capitalize(prop.event) }() { return (${ handler }); }`);
        }
        else if (prop.kind === 'bind')
        {
            // `bind:value={state}` -> a reactive value getter PLUS the write-back callback the component
            // calls with the new value (`onInput`/`onChange`, the native event name). The callback receives
            // the value directly (not a DOM event), and the `state = $value` assignment is run through the
            // reactive rewrite so it becomes the state's setter - a non-writable target is rejected there.
            const bound = source.slice(prop.expr.start, prop.expr.end);
            const value = rewriteReactive(bound, sources, prop.expr.start);
            const handler = `($event) => ${ rewriteReactive(`${ bound } = $event`, sources, prop.expr.start) }`;
            parts.push(`get ${ objectKey(prop.prop) }() { return (${ value }); }`);
            parts.push(`get on${ capitalize(prop.event) }() { return (${ handler }); }`);
        }
        else
        {
            const value = rewriteExpr(source, prop.expr, sources, emit);
            // Factory props (`fallback`) are lazy thunks; value props are reactive getters.
            parts.push(FACTORY_ATTRS.has(prop.name) ? `${ objectKey(prop.name) }: () => (${ value })` : `get ${ objectKey(prop.name) }() { return (${ value }); }`);
        }
    }

    if (binding.children !== null)
    {
        // Parens are load-bearing: a children expression starting on the line after the
        // opening brace would otherwise emit `return` + newline, which ASI silently turns
        // into `return;` - children becomes undefined and <For> crashes at runtime.
        parts.push(`get children() { return (${ emitChildrenValue(source, binding.children, sources, emit) }); }`);
    }

    return parts.length === 0 ? `${ binding.tag }()` : `${ binding.tag }({ ${ parts.join(', ') } })`;
}

/**
 * Emits a component's `children` value from the lowered {@link ComponentChildren}:
 * a render function (clonable row -> a `tmpl()` clone factory; pass-through ->
 * the arrow verbatim), a dynamic `{expr}` thunk, or a markup children list built
 * with h() from the IR.
 */
function emitChildrenValue(source: string, children: ComponentChildren, sources: ReactiveSources, emit: Emit): string
{
    if (children.kind === 'dynamic')
    {
        return `() => (${ rewriteExpr(source, children.expr, sources, emit) })`;
    }
    if (children.kind === 'render')
    {
        // A clonable sub-plan (A1) -> a row factory that clones + wires the row;
        // its bindings are reactive: true, so per-row signals update.
        if ('template' in children.body)
        {
            // The captured param span already includes its parens when present
            // (`(i)` or a bare `i`), so emit it verbatim - don't re-wrap.
            const param = children.param ? source.slice(children.param.start, children.param.end) : '()';
            // Inside embedded markup (raw mode) a tmpl() clone can't live in an
            // expression, so emit the row via h() (the outer rewrite handles its
            // reads). Otherwise emit the mode-dispatched clone row.
            if (emit.raw)
            {
                return `${ param } => (${ emitNode(source, children.body.template, children.body, sources, emit) })`;
            }
            return `${ param } => { ${ emitUnifiedBody(source, children.body, sources, emit) } }`;
        }
        // Pass-through: the body span is the whole arrow (`(i) => ...`); emit verbatim.
        return rewriteExpr(source, children.body, sources, emit);
    }
    // Markup children: a thunk returning the node(s), built with h() from the IR.
    return `() => ${ emitMarkupChildren(source, children.plan, sources, emit) }`;
}

/**
 * Emits a markup children plan (a `fragment` of children) as an h()-built value:
 * a single child directly, or an array of children. Each child is emitted with
 * {@link emitNode} (elements -> h(), holes -> reactive thunks, slots ->
 * component calls), so nested control flow composes.
 */
function emitMarkupChildren(source: string, plan: RenderPlan, sources: ReactiveSources, emit: Emit): string
{
    const root = plan.template;
    const children = root.kind === 'fragment' ? root.children : [root];
    const items = children.map(child => emitNode(source, child, plan, sources, emit));
    const solo = items[0];
    return items.length === 1 && solo !== undefined ? solo : `[${ items.join(', ') }]`;
}

/**
 * Emits a single template node as an h()-built VALUE expression (from the IR):
 * static text -> a quoted string, a `hole` -> its reactive/static binding value,
 * a `slot` -> its component call, an `element` -> `h('tag', { props }, ...kids)`,
 * a `fragment` -> an array. Used for component markup children, where building
 * with h() (rather than cloning) keeps the emitter simple; the clone wins are on
 * the top-level skeleton and render-fn rows.
 */
function emitNode(source: string, node: TemplateNode, plan: RenderPlan, sources: ReactiveSources, emit: Emit): string
{
    if (node.kind === 'text')
    {
        return quoteString(node.value);
    }
    if (node.kind === 'hole')
    {
        const binding = plan.bindings.find((b): b is TextBinding => b.kind === 'text' && b.target === node.id);
        return binding ? exprValue(source, binding.expr, sources, emit) : 'null';
    }
    if (node.kind === 'slot')
    {
        const binding = plan.bindings.find((b): b is ComponentBinding => b.kind === 'component' && b.target === node.id);
        return binding ? emitComponentCall(source, binding, sources, emit) : 'null';
    }
    if (node.kind === 'fragment')
    {
        return `[${ node.children.map(child => emitNode(source, child, plan, sources, emit)).join(', ') }]`;
    }

    // Element -> h('tag', { static attrs + dynamic bindings }, ...children).
    emit.used.add('h');
    const group = plan.bindings.filter(b => b.target === node.id && b.kind !== 'text' && b.kind !== 'component');
    const props =
    [
        ...node.attrs.map(a => `${ objectKey(a.name) }: ${ a.value === true ? 'true' : quoteString(a.value) }`),
        ...group.map(b => propEntry(source, b, sources, emit))
    ];
    const childItems = node.children.map(child => emitNode(source, child, plan, sources, emit));
    const args = [quoteString(node.tag), `{ ${ props.join(', ') } }`, ...childItems];
    return `h(${ args.join(', ') })`;
}

/** `click` -> `Click`, for reconstructing a component's `onEvent` prop name. */
function capitalize(text: string): string
{
    return text.length === 0 ? text : (text[0] ?? '').toUpperCase() + text.slice(1);
}

/**
 * Rewrites `code`'s reactive reads to getter/setter calls - UNLESS we are emitting
 * embedded markup (`emit.raw`), where the enclosing `rewriteExpr` does the single
 * rewrite (the rewrite is not idempotent, so it must run exactly once).
 */
function maybeRewrite(emit: Emit, code: string, sources: ReactiveSources, offset = 0): string
{
    if (emit.raw)
    {
        return code;
    }
    const { code: out, used } = lowerExpression(code, sources, offset);
    for (const name of used)
    {
        emit.used.add(name);
    }
    return out;
}

/** The rewritten source of a binding expression (nested markup projected, R2-rewritten). */
function rewriteExpr(source: string, expr: ReactiveExpr, sources: ReactiveSources, emit: Emit): string
{
    return maybeRewrite(emit, projectMarkup(source.slice(expr.span.start, expr.span.end), emit, sources), sources, expr.span.start);
}

/**
 * Rewrites a run of body statements (opaque statements, an effect body): first compiles any markup
 * EMBEDDED in them - e.g. a `const renderRow = () => <li/>` helper - through the unified emitter, then
 * applies the reactive read/write rewrite once over the whole result. This is the statement-level
 * analogue of {@link rewriteExpr}, so markup is compiled wherever it appears in a component, not only
 * in the top-level output.
 */
function rewriteBody(source: string, start: number, end: number, sources: ReactiveSources, emit: Emit): string
{
    const projected = projectMarkup(source.slice(start, end), emit, sources);
    if (emit.raw)
    {
        return projected;
    }
    const { code, used } = lowerStatements(projected, sources, start);
    for (const name of used)
    {
        emit.used.add(name);
    }
    return code;
}

/** A reactive binding emits a getter; a static (depless) one emits a value. */
function exprValue(source: string, expr: ReactiveExpr, sources: ReactiveSources, emit: Emit): string
{
    const rewritten = rewriteExpr(source, expr, sources, emit);
    // isReactive covers reads the dep analysis can SEE (component sources) plus the
    // explicit reactive flag. For the rest, fall back to a conservative reactivity heuristic so a
    // computed expression the analysis CAN'T see (a store read like `counter.count()`,
    // an imported signal) is still wrapped reactive - matching how h() handles a
    // dynamic value. A bare getter / fn-literal / collection stays verbatim (bindHole and h()
    // handle a function value reactively).
    return isReactive(expr) ? `() => (${ rewritten })` : wrapDynamic(rewritten, false);
}

/** The bound state read for a `bind:` directive (`state()` after the reactive rewrite). */
function bindValue(source: string, binding: BindBinding, sources: ReactiveSources): string
{
    return rewriteReactive(source.slice(binding.expr.start, binding.expr.end), sources, binding.expr.start);
}

/**
 * The write-back handler for a `bind:` directive: `($event) => state = $event.target.<prop>`. The
 * assignment is run through the reactive rewrite, so it becomes the state's setter call - and a
 * non-writable target (a `derived`) is rejected there with a precise error.
 */
function bindHandler(source: string, binding: BindBinding, sources: ReactiveSources): string
{
    const target = source.slice(binding.expr.start, binding.expr.end);
    return `($event) => ${ rewriteReactive(`${ target } = $event.target.${ binding.prop }`, sources, binding.expr.start) }`;
}

/**
 * Builds the merged class string for a {@link ClassBinding}:
 * `[<base>, <dynamic>, (<cond>) ? '<name>' : '', ...].filter(Boolean).join(' ')`. The base is a static
 * literal; the dynamic and each toggle condition are run through the reactive rewrite.
 */
function classCombined(source: string, binding: ClassBinding, sources: ReactiveSources): string
{
    const parts: string[] = [];
    if (binding.base !== null)
    {
        parts.push(quoteString(binding.base));
    }
    if (binding.dynamic !== null)
    {
        parts.push(rewriteReactive(source.slice(binding.dynamic.start, binding.dynamic.end), sources, binding.dynamic.start));
    }
    for (const toggle of binding.toggles)
    {
        const cond = rewriteReactive(source.slice(toggle.expr.start, toggle.expr.end), sources, toggle.expr.start);
        parts.push(`(${ cond }) ? ${ quoteString(toggle.name) } : ''`);
    }
    // A single toggle is already a plain string expression - the array/filter/
    // join machinery would only re-derive it (and allocate on every run).
    const only = parts[0];
    if (only !== undefined && parts.length === 1 && binding.toggles.length === 1)
    {
        return only;
    }
    return `[${ parts.join(', ') }].filter(Boolean).join(' ')`;
}

/**
 * Builds the merged inline style for a {@link StyleBinding}:
 * `[<base>, <dynamic>, 'prop: ' + (<value>), ...].filter(Boolean).join('; ')`. The base is a static
 * literal; the dynamic and each `style:prop` value are run through the reactive rewrite.
 */
function styleCombined(source: string, binding: StyleBinding, sources: ReactiveSources): string
{
    const parts: string[] = [];
    if (binding.base !== null)
    {
        parts.push(quoteString(binding.base));
    }
    if (binding.dynamic !== null)
    {
        parts.push(rewriteReactive(source.slice(binding.dynamic.start, binding.dynamic.end), sources, binding.dynamic.start));
    }
    for (const entry of binding.props)
    {
        const value = rewriteReactive(source.slice(entry.expr.start, entry.expr.end), sources, entry.expr.start);
        parts.push(`${ quoteString(`${ entry.name }: `) } + (${ value })`);
    }
    return `[${ parts.join(', ') }].filter(Boolean).join('; ')`;
}

/** Emits one element-binding (attr/event/bind/class/style/spread/ref) as a bindProps object entry. */
function propEntry(source: string, binding: Binding, sources: ReactiveSources, emit: Emit): string
{
    if (binding.kind === 'attribute')
    {
        return `${ objectKey(binding.name) }: ${ exprValue(source, binding.expr, sources, emit) }`;
    }
    if (binding.kind === 'event')
    {
        return `on${ binding.event }: ${ maybeRewrite(emit, handlerSource(source, binding.handler), sources, binding.handler.start) }`;
    }
    if (binding.kind === 'bind')
    {
        // The bound value as a reactive getter prop (h() unwraps `() =>`), plus the write-back listener.
        return `${ objectKey(binding.prop) }: () => (${ bindValue(source, binding, sources) }), on${ binding.event }: ${ bindHandler(source, binding, sources) }`;
    }
    if (binding.kind === 'class')
    {
        // The merged class as a reactive getter (h() unwraps `() =>`).
        return `class: () => (${ classCombined(source, binding, sources) })`;
    }
    if (binding.kind === 'style')
    {
        // The merged inline style as a reactive getter (h() unwraps `() =>`).
        return `style: () => (${ styleCombined(source, binding, sources) })`;
    }
    if (binding.kind === 'spread')
    {
        return `...${ maybeRewrite(emit, projectMarkup(source.slice(binding.expr.span.start, binding.expr.span.end), emit, sources), sources) }`;
    }
    if (binding.kind === 'ref')
    {
        return `ref: ${ maybeRewrite(emit, source.slice(binding.ref.start, binding.ref.end), sources) }`;
    }
    return '';
}

/** The variable name for a bound template node. */
function nodeVar(id: number): string
{
    return `_n${ id }`;
}

/** A firstChild/nextSibling path expression from the cloned root `_r`. */
function pathExpr(path: number[]): string
{
    if (path.length === 0)
    {
        return '_r';
    }
    return '_r' + path.map(index => '.firstChild' + '.nextSibling'.repeat(index)).join('');
}

/**
 * Records every template node's DOM-offset path (for firstChild/nextSibling
 * walking). A hole serializes to TWO comment anchors (`<!--[--><!--]-->`), so it
 * advances the sibling offset by 2 and its own path points at the OPEN anchor
 * (bindHole finds the close anchor as its nextSibling).
 */
function computePaths(node: TemplateNode, path: number[], into: Map<number, number[]>): void
{
    into.set(node.id, path);
    // An only-child hole has no anchors in the clone - its binding targets the
    // PARENT element itself (bindContent drives the element's content).
    const onlyHole = onlyChildHoleOf(node);
    if (onlyHole !== null)
    {
        into.set(onlyHole.id, path);
        return;
    }
    if (node.kind === 'element' || node.kind === 'fragment')
    {
        let offset = 0;
        for (const child of node.children)
        {
            computePaths(child, [...path, offset], into);
            offset += domNodeCount(child);
        }
    }
}

/**
 * The number of DOM nodes a template node serializes to: a hole is two comment
 * anchors (`<!--[--><!--]-->`); an element or text node is one; a fragment is
 * the sum of its children (fragments never reach the clone path today, but the
 * count stays correct if that changes).
 */
function domNodeCount(node: TemplateNode): number
{
    if (node.kind === 'hole')
    {
        // <!--[--><!--]--> - two comment anchors.
        return 2;
    }
    if (node.kind === 'fragment')
    {
        return node.children.reduce((sum, child) => sum + domNodeCount(child), 0);
    }
    // element, text, or slot (a single <!--azc--> placeholder comment).
    return 1;
}

/**
 * Serializes the static template tree to HTML, with a `<!--[--><!--]-->` anchor
 * pair at each hole. The pair is the same reactive-hole marker scheme SSR emits
 * (`<!--[-->value<!--]-->`) and hydration adopts, so clone output is structurally
 * hydratable; in a fresh clone the range starts empty and bindHole drives content
 * between the anchors.
 */
function serialize(node: TemplateNode): string
{
    if (node.kind === 'text')
    {
        return escapeText(node.value);
    }
    if (node.kind === 'hole')
    {
        return '<!--[--><!--]-->';
    }
    if (node.kind === 'slot')
    {
        // A control-flow / component slot is a single placeholder comment in the
        // clone. bindSlot inserts the component's output (which carries its OWN
        // co-range markers) before this marker, then removes it.
        return '<!--azc-->';
    }
    if (node.kind === 'fragment')
    {
        return node.children.map(serialize).join('');
    }

    let html = `<${ node.tag }`;
    for (const attr of node.attrs)
    {
        html += attr.value === true ? ` ${ attr.name }` : ` ${ attr.name }="${ escapeAttr(attr.value) }"`;
    }
    html += '>';
    if (VOID_ELEMENTS.has(node.tag))
    {
        return html;
    }
    // An only-child hole serializes to NOTHING: the element bounds the content,
    // so bindContent needs no anchor pair (see onlyChildHoleOf).
    if (onlyChildHoleOf(node) === null)
    {
        for (const child of node.children)
        {
            html += serialize(child);
        }
    }
    return `${ html }</${ node.tag }>`;
}

/** True when the template tree contains a fragment (which the tmpl path can't clone). */
function hasFragment(node: TemplateNode): boolean
{
    if (node.kind === 'fragment')
    {
        return true;
    }
    if (node.kind === 'element')
    {
        return node.children.some(hasFragment);
    }
    return false;
}

/**
 * Replaces markup embedded inside an expression with its compiled value, via the
 * ONE unified emitter: each markup region is lowered to a RenderPlan and emitted
 * by {@link emitNode}. No separate markup->h() emitter.
 */
function projectMarkup(code: string, emit: Emit, sources: ReactiveSources): string
{
    let out = '';
    let j = 0;
    for (;;)
    {
        const start = findMarkupStart(code, j);
        if (start === -1)
        {
            return out + code.slice(j);
        }
        out += code.slice(j, start);
        try
        {
            const { node, end } = parseMarkup(code, start);
            out += emitMarkupExpr(code, node, sources, emit);
            j = end;
        }
        catch
        {
            return out + code.slice(start);
        }
    }
}

/**
 * Compiles a markup node embedded in an expression: lower it to a RenderPlan and
 * emit it through {@link emitNode}. Runs in `raw` mode so the markup's reads stay
 * unrewritten - the enclosing {@link rewriteExpr} applies the single outer rewrite
 * over the whole projected expression (the rewrite is not idempotent).
 */
function emitMarkupExpr(source: string, node: MarkupElement | MarkupFragment, sources: ReactiveSources, emit: Emit): string
{
    const plan = lowerMarkup(source, node);
    const previous = emit.raw;
    emit.raw = true;
    try
    {
        return emitNode(source, plan.template, plan, sources, emit);
    }
    finally
    {
        emit.raw = previous;
    }
}

/** Builds the auto-injected runtime import, skipping names the source imports. */
function buildImport(source: string, emit: Emit): string
{
    const names = [...emit.used].filter(name => !alreadyImports(source, name));
    return names.length > 0 ? `import { ${ names.join(', ') } } from '${ RUNTIME_MODULE }';\n` : '';
}

/** Escapes text-node content for template HTML. */
function escapeText(text: string): string
{
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escapes an attribute value for template HTML. */
function escapeAttr(value: string): string
{
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Finds the piece containing an output offset (binary search). */
function findPiece<T extends { outStart: number }>(pieces: T[], outOffset: number): T
{
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo < hi)
    {
        const mid = (lo + hi + 1) >> 1;
        const piece = pieces[mid];
        if (piece !== undefined && piece.outStart <= outOffset)
        {
            lo = mid;
        }
        else
        {
            hi = mid - 1;
        }
    }
    const found = pieces[lo];
    if (found === undefined)
    {
        // The emit loop always produces at least one piece before mapping runs.
        throw new Error('findPiece: the piece table is empty.');
    }
    return found;
}

/** Builds a line-level source map (one segment per generated line). */
function buildSourceMap(code: string, prefixLen: number, pieces: { outStart: number; sourceStart: number; verbatim: boolean }[], source: string, filename: string): SourceMapV3
{
    const sourceLineStarts = buildLineStarts(source);
    const codeLineStarts = buildLineStarts(code);
    const lines: RawSegment[][] = [];

    for (const codeOffset of codeLineStarts)
    {
        if (codeOffset < prefixLen)
        {
            lines.push([{ genColumn: 0, sourceLine: 0, sourceColumn: 0 }]);
            continue;
        }
        const outOffset = codeOffset - prefixLen;
        const piece = findPiece(pieces, outOffset);
        const sourceOffset = piece.verbatim ? piece.sourceStart + (outOffset - piece.outStart) : piece.sourceStart;
        const loc = locationFor(sourceOffset, sourceLineStarts);
        lines.push([{ genColumn: 0, sourceLine: loc.line, sourceColumn: loc.column }]);
    }

    return {
        version: 3,
        sources: [filename],
        sourcesContent: [source],
        names: [],
        mappings: encodeMappings(lines)
    };
}
