/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The reactive analysis driver. Walks a component's body and produces, for each reactive scope (a `derived` initializer, an
 * `effect` body, or a markup binding), the set of reactive sources it reads - the dependency sets the
 * IR (lower) turns into targeted update code.
 *
 * It wires together TS slice parsing (ts-slice) and the scope-aware reactive-read collector
 * (resolve.collectReads). Markup that appears inside a hole expression
 * (`{items.map(i => <li>{i}</li>)}`) is projected to a read-only array of its dynamic sub-expressions
 * (`[e1, e2, ...]`) via the shared IR lowerer (lowerMarkup) FIRST, so the whole expression parses as
 * one TypeScript slice and the lambda's scope is preserved - which keeps shadowing (a parameter named
 * like a state) sound. The projection is used only to read dependency NAMES; source positions are not
 * needed here, so the projection's loss of offset alignment does not matter.
 *
 * The VALUE import of lowerMarkup from lower.ts (lower imports only TYPES from here) is the one shared
 * markup lowerer - see lower.ts's header for why the resulting type-graph cycle is intentional.
 *
 * @see {@link analyzeComponent} - the analysis entry point
 * @internal Compiler analysis stage; not part of the package's public API.
 */

import * as ts from 'typescript';

import type { Span, MarkupElement, MarkupFragment, MarkupChild } from './types.ts';
import type { ComponentDecl } from './ast.ts';
import type { RenderPlan } from './ir.ts';
import type { Dep, ReactiveSources } from './dep.ts';

import { findMarkupStart } from './scanner.ts';
import { parseMarkup, CompileError, MAX_MARKUP_DEPTH, markupDepthError } from './markup-parser.ts';
import { lowerMarkup } from './lower.ts';
import { parseDeclarationSlice, parseStatementsSlice, parseExpressionSlice, parsePropsPattern, parseComponentParam, formFieldKeys } from './ts-slice.ts';
import { collectReads } from './resolve.ts';

/** A reactive source declared by the component. */
export interface ReactiveSourceInfo
{
    kind: 'state' | 'derived' | 'deferred';
    name: string;
    /** Span of the declared name. */
    span: Span;
}

/** A reactive scope and the sources it depends on. */
export interface ReactiveScope
{
    origin: 'derived' | 'effect' | 'text' | 'attribute';
    /** For `origin: 'derived'`, the name of the source it computes. */
    name?: string;
    /** Span of the analyzed construct/expression. */
    span: Span;
    /** Reactive sources read. */
    deps: Dep[];
    /** Conservative: no calls/`new`/`await`/assignments/`++`/`--` (may be refined later). */
    pure: boolean;
}

/** The reactive analysis of one component. */
export interface ReactiveAnalysis
{
    sources: ReactiveSourceInfo[];
    hasProps: boolean;
    scopes: ReactiveScope[];
    /** The props parameter's author-chosen identifier (`props`/`p`/`data`), or null for a destructured
     * pattern. Codegen emits the runtime signature with this name so `p.x` body reads resolve. */
    paramName?: string | null | undefined;
    /** True when the props parameter destructures a rest element (`{ a, ...rest }`) - unsupported. */
    hasRestProp?: boolean | undefined;
    /** Destructured-prop aliases from a `component Name({ a, b }: P)` signature (local name -> read expr). */
    propAliases?: ReadonlyMap<string, string> | undefined;
    /** `form` declarations: form name -> its field-key set (drives the `NAME.field` read/write rewrite). */
    forms: ReadonlyMap<string, ReadonlySet<string>>;
    /** Forms whose field-key set is NOT exhaustive (non-literal initializer, spread, computed key). */
    openForms?: ReadonlySet<string>;
    /** Array-form (`form name[]`) declarations: name -> blank-row key set. */
    arrayForms?: ReadonlyMap<string, ReadonlySet<string>>;
    /** Row variables iterating an OPEN array form: their field binds cannot be wired. */
    openRows?: ReadonlySet<string>;
    /** Array-form `<For>` row variables: row name -> blank-row keys (drives the `row.field` rewrite). */
    rowForms: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Analyzes a component's reactivity: its declared sources, whether it takes props, and, for
 * every reactive scope, the dependency set that scope reads.
 *
 * Knowing which sources an expression reads is what lets each binding choose between a
 * targeted effect and a set-once value. Computing it once, up front, is what lets lowering
 * wire dependency sets by span and codegen emit surgical updates rather than re-running
 * everything.
 *
 * Each expression is parsed as a real TypeScript slice, so scope and shadowing are sound: a
 * lambda parameter named like a state correctly shadows it, and a read of a shadowed name is
 * NOT a dependency. Markup inside a hole is projected to a read-only array of its dynamic
 * sub-expressions through the shared lowerer first, so one parse covers the whole expression
 * and the collector sees every embedded sub-expression with its scope intact.
 *
 * `pure` is CONSERVATIVE: any call, `new`, `await`, assignment or increment marks a scope
 * impure.
 *
 * The spans in the result index into THIS `source` and are what lowering's dependency lookup
 * keys on. Pair the analysis with the same source passed to lowerComponent, or the
 * dependencies mis-map.
 *
 * @param source - The original source.
 * @param component - The declaration from parseModule.
 * @returns The component's sources, `hasProps`, and one scope per derived, effect, text and
 *          attribute.
 * @example
 * const module = parseModule('component C { state n = 0; derived d = n * 2; <p>{d}</p> }');
 * const analysis = analyzeComponent(source, module.items[0] as ComponentDecl);
 *
 * analysis.scopes.find(s => s.origin === 'derived')!.deps;
 * // [{ kind: 'source', name: 'n' }]
 *
 * @see {@link lowerComponent}
 * @internal
 */
export function analyzeComponent(source: string, component: ComponentDecl): ReactiveAnalysis
{
    const sources: ReactiveSourceInfo[] = [];
    const names = new Set<string>();
    // Props come from the component's parameter `component Name(<param>)`. ANY parameter (named or
    // destructuring) means the component takes props; a destructuring signature `component Name({ a, b }: P)`
    // additionally introduces reactive aliases so a bare `a` read lowers to `props.a`.
    const param = component.propsParam
        ? parseComponentParam(source.slice(component.propsParam.start, component.propsParam.end), component.propsParam.start)
        : { typeSpan: null, patternSpan: null, identName: null, hasRest: false };
    const hasProps = component.propsParam !== null;
    const propAliases = param.patternSpan
        ? parsePropsPattern(source.slice(param.patternSpan.start, param.patternSpan.end))
        : undefined;

    const forms = new Map<string, ReadonlySet<string>>();
    const arrayForms = new Map<string, ReadonlySet<string>>();
    const openForms = new Set<string>();
    for (const item of component.body)
    {
        if (item.kind === 'state' || item.kind === 'derived' || item.kind === 'deferred')
        {
            sources.push({ kind: item.kind, name: item.name, span: { start: item.nameStart, end: item.nameEnd } });
            names.add(item.name);
        }
        else if (item.kind === 'form')
        {
            // A flat form registers its field keys for the `NAME.field` access sugar. An array-form has no
            // top-level field sugar (its NAME is read explicitly, like a factory), but its blank-row keys are
            // used to sugar the `<For>` row variable's field access (collected from the markup below).
            const fields = formFieldKeys(source, item);
            (item.isArray ? arrayForms : forms).set(item.name, new Set(fields.keys));
            if (fields.open)
            {
                openForms.add(item.name);
            }
        }
    }

    // Array-form row variables: scan the markup for `<For each={NAME.rows()}>{(row) => ...}` whose `each`
    // iterates an array-form, and bind the render arrow's first param as a ROW form (so `row.field` sugars).
    const rowForms = new Map<string, ReadonlySet<string>>();
    if (arrayForms.size > 0)
    {
        for (const item of component.body)
        {
            if (item.kind === 'markup')
            {
                collectRowForms(source, item.node, arrayForms, rowForms);
            }
            else if (item.kind === 'opaque-statements')
            {
                // A <For> held in a statement (`const frag = <For .../>`) compiles through the
                // same emitter; skipping it here left its rows unregistered - holes rendered
                // silently empty and binds were rejected with a rename that could fix nothing.
                collectEmbeddedRowForms(source, item.start, item.end, arrayForms, rowForms);
            }
            else if (item.kind === 'effect' || item.kind === 'watch' || item.kind === 'wrapper')
            {
                collectEmbeddedRowForms(source, item.bodyStart, item.bodyEnd, arrayForms, rowForms);
            }
        }
    }

    const reactive: ReactiveSources = { names, hasProps, propAliases, forms, rowForms };
    const scopes: ReactiveScope[] = [];

    for (const item of component.body)
    {
        if (item.kind === 'derived')
        {
            const parsed = parseDeclarationSlice(source, item);
            const deps = parsed ? collectReads(parsed.sourceFile, reactive) : [];
            const pure = parsed?.initializer ? isPure(parsed.initializer) : true;
            scopes.push({ origin: 'derived', name: item.name, span: { start: item.start, end: item.end }, deps, pure });
        }
        else if (item.kind === 'effect')
        {
            const { sourceFile } = parseStatementsSlice(source.slice(item.bodyStart, item.bodyEnd), item.bodyStart);
            scopes.push({
                origin: 'effect',
                span: { start: item.bodyStart, end: item.bodyEnd },
                deps: collectReads(sourceFile, reactive),
                pure: isPure(sourceFile)
            });
        }
        else if (item.kind === 'markup')
        {
            collectMarkupBindings(item.node, reactive, scopes);
        }
    }

    // A row variable inherits its array form's openness. The linkage is the SHARED key-set
    // instance collectRowForms copies out of arrayForms - identity, not equality, on purpose.
    const openRows = new Set<string>();
    for (const [row, keys] of rowForms)
    {
        for (const [name, formKeys] of arrayForms)
        {
            if (keys === formKeys && openForms.has(name))
            {
                openRows.add(row);
            }
        }
    }
    return { sources, hasProps, scopes, paramName: param.identName, hasRestProp: param.hasRest, propAliases, forms, openForms, arrayForms, openRows, rowForms };
}

/**
 * Scans a markup subtree for `<For each={NAME.rows()}>{(row) => ...}` (or `each={NAME}`) whose `each`
 * iterates one of `arrayForms`, and registers the render arrow's first param as a ROW form (row name ->
 * the array-form's blank-row keys). Recurses into element/fragment children; a `<For>` nested inside an
 * expression (e.g. another For's arrow body) is not reached - row sugar is for the direct children form.
 *
 * @internal
 */
function collectRowForms(
    source: string,
    node: MarkupElement | MarkupFragment,
    arrayForms: ReadonlyMap<string, ReadonlySet<string>>,
    rowForms: Map<string, ReadonlySet<string>>
): void
{
    if (node.kind === 'element' && node.tag === 'For')
    {
        const eachAttr = node.attributes.find(a => a.name === 'each');
        const keys = eachAttr !== undefined && eachAttr.value.kind === 'expression'
            ? arrayFormEachKeys(eachAttr.value.code, arrayForms)
            : undefined;
        if (keys !== undefined)
        {
            // The row variable: declared by `let={ row }`, or (manual API surfaces that
            // still carry a callback child) the arrow's first parameter.
            const letAttr = node.attributes.find(a => a.name === 'let' && a.value.kind === 'expression');
            if (letAttr !== undefined && letAttr.value.kind === 'expression')
            {
                rowForms.set(letAttr.value.code.trim(), keys);
            }
            for (const child of node.children)
            {
                if (child.kind === 'expression')
                {
                    const rowVar = firstArrowParam(child.code);
                    if (rowVar !== null)
                    {
                        rowForms.set(rowVar, keys);
                    }
                }
            }
        }
    }

    for (const child of node.children)
    {
        if (child.kind === 'element' || child.kind === 'fragment')
        {
            collectRowForms(source, child, arrayForms, rowForms);
        }
        else if (child.kind === 'expression')
        {
            // A <For> inside an expression hole compiles through the same emitter and its row
            // fields wire through the same name-keyed registry - leaving it unregistered made
            // the row sugar position-dependent: valid-looking binds emitted raw, dead code.
            collectEmbeddedRowForms(source, child.start + 1, child.end - 1, arrayForms, rowForms);
        }
    }
    for (const attr of node.kind === 'element' ? node.attributes : [])
    {
        if (!attr.spread && attr.name !== null && attr.value.kind === 'expression')
        {
            collectEmbeddedRowForms(source, source.indexOf('{', attr.start) + 1, attr.end - 1, arrayForms, rowForms);
        }
    }
}

/** Runs {@link collectRowForms} over every markup region embedded in a TS slice. */
function collectEmbeddedRowForms(
    source: string,
    start: number,
    end: number,
    arrayForms: ReadonlyMap<string, ReadonlySet<string>>,
    rowForms: Map<string, ReadonlySet<string>>
): void
{
    let pos = start;
    for (;;)
    {
        const at = findMarkupStart(source, pos);
        if (at === -1 || at >= end)
        {
            return;
        }
        try
        {
            const parsed = parseMarkup(source, at);
            collectRowForms(source, parsed.node, arrayForms, rowForms);
            pos = parsed.end;
        }
        catch
        {
            return;
        }
    }
}

/**
 * The array-form NAME when `code` is `NAME` or `NAME.rows()` and NAME is an array-form; else
 * null. The one reading of the `each=` shape, shared with the bind-target diagnostic so the
 * lexical row-form linkage there can never disagree with the registration here.
 */
export function arrayFormEachName(
    code: string,
    arrayForms: ReadonlyMap<string, ReadonlySet<string>>
): string | null
{
    let expr = parsedExpression(code);
    if (expr === undefined)
    {
        return null;
    }
    // Wrappers spell the same iteration; leaving them unlinked silently severed the row sugar
    // while the same wrappers on a bind TARGET are loudly rejected.
    const unwrap = (node: ts.Expression): ts.Expression =>
    {
        let current = node;
        while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current))
        {
            current = current.expression;
        }
        return current;
    };
    expr = unwrap(expr);
    // Array methods that RESELECT rows without replacing them: every element of the result is an
    // element of the receiver, so each row is still the same `{ key, form }` record and its
    // fields wire exactly as they do on the whole list. Sorting a list for display or filtering
    // out completed items is the ordinary reason to have an array form at all, and leaving those
    // spellings unlinked emitted a DEAD write onto the record while the projection kept typing
    // the field as present. `map`/`flatMap` are absent on purpose (they replace elements), and so
    // is `concat` (it can mix in rows from elsewhere).
    const RESELECTING = new Set(['filter', 'slice', 'toSorted', 'toReversed']);
    const receiverOf = (node: ts.Expression): ts.Expression | null =>
    {
        if (ts.isCallExpression(node))
        {
            const callee = unwrap(node.expression);
            if (ts.isPropertyAccessExpression(callee) && RESELECTING.has(callee.name.text))
            {
                return unwrap(callee.expression);
            }
            // `toSpliced(start, deleteCount)` only REMOVES, and is identity-preserving like the
            // rest; `toSpliced(start, deleteCount, ...items)` INSERTS whatever it is given, and
            // treating those inserted elements as rows wires form sugar onto objects that have no
            // form - which throws at first render rather than merely reading nothing.
            if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'toSpliced'
                && node.arguments.length <= 2)
            {
                return unwrap(callee.expression);
            }
        }
        // A guarded or defaulted list is the same list: `cond ? rows.rows() : []`,
        // `rows.rows() ?? []`, `rows.rows() || []`. Every element still belongs to the form, so
        // the rows wire; only the EMPTY alternative is admitted, because any other branch could
        // contribute foreign elements.
        const isEmptyArray = (candidate: ts.Expression): boolean =>
            ts.isArrayLiteralExpression(unwrap(candidate)) && unwrap(candidate).getChildCount() >= 0
            && (unwrap(candidate) as ts.ArrayLiteralExpression).elements.length === 0;
        if (ts.isConditionalExpression(node))
        {
            const whenTrue = unwrap(node.whenTrue);
            const whenFalse = unwrap(node.whenFalse);
            if (isEmptyArray(whenFalse))
            {
                return whenTrue;
            }
            if (isEmptyArray(whenTrue))
            {
                return whenFalse;
            }
        }
        if (ts.isBinaryExpression(node)
            && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
                || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
            && isEmptyArray(node.right))
        {
            return unwrap(node.left);
        }
        // `[...NAME.rows()]` - a copy of the same elements.
        if (ts.isArrayLiteralExpression(node) && node.elements.length === 1)
        {
            const only = node.elements[0];
            if (only !== undefined && ts.isSpreadElement(only))
            {
                return unwrap(only.expression);
            }
        }
        return null;
    };
    // Chained reselections (`rows.rows().filter(a).slice(0, 3)`) peel one at a time. The bound is
    // a guard against a pathological chain, not a real depth.
    for (let depth = 0; depth < 16; depth += 1)
    {
        const receiver = receiverOf(expr);
        if (receiver === null)
        {
            break;
        }
        expr = receiver;
    }
    let base: string | undefined;
    if (ts.isIdentifier(expr))
    {
        // NOT the bare handle: `each={rows}` passes the FieldArrayApi itself, which is neither an
        // array nor a getter, so <For> throws "expected an array, received object" at first
        // render. Linking it emitted working row sugar onto a list that never renders - the same
        // standard the inserting-toSpliced case is rejected by. `rows.rows()` is the spelling.
        base = arrayForms.has(expr.text) ? undefined : expr.text;
    }
    else if (ts.isCallExpression(expr))
    {
        const callee = unwrap(expr.expression);
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'rows')
        {
            const object = unwrap(callee.expression);
            if (ts.isIdentifier(object))
            {
                base = object.text;
            }
        }
    }
    else if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'rows')
    {
        // The DETACHED getter (`each={rows.rows}`, no call): For accepts `T[] | (() => T[])`,
        // so this renders identically to `rows.rows()` - leaving it unlinked severed the row
        // sugar on a spelling the runtime happily accepts.
        const object = unwrap(expr.expression);
        if (ts.isIdentifier(object))
        {
            base = object.text;
        }
    }
    return base !== undefined && arrayForms.has(base) ? base : null;
}

/** The blank-row keys when `code` is `NAME` or `NAME.rows()` and NAME is an array-form; else undefined. */
function arrayFormEachKeys(
    code: string,
    arrayForms: ReadonlyMap<string, ReadonlySet<string>>
): ReadonlySet<string> | undefined
{
    const name = arrayFormEachName(code, arrayForms);
    return name !== null ? arrayForms.get(name) : undefined;
}

/** The first parameter NAME of an arrow-function expression `(row, i) => ...`, or null. */
function firstArrowParam(code: string): string | null
{
    const expr = parsedExpression(projectMarkup(code));
    const firstParam = expr !== undefined && ts.isArrowFunction(expr) ? expr.parameters[0] : undefined;
    if (expr !== undefined && ts.isArrowFunction(expr) && firstParam !== undefined)
    {
        const first = firstParam.name;
        if (ts.isIdentifier(first))
        {
            return first.text;
        }
    }
    return null;
}

/** Parses `code` as one expression, unwrapping the parentheses parseExpressionSlice adds. */
function parsedExpression(code: string): ts.Expression | undefined
{
    const { sourceFile } = parseExpressionSlice(code, 0);
    const statement = sourceFile.statements[0];
    const expr = statement !== undefined && ts.isExpressionStatement(statement) ? statement.expression : undefined;
    return expr !== undefined && ts.isParenthesizedExpression(expr) ? expr.expression : expr;
}

/** Analyzes one expression's source (projecting any nested markup first). */
function analyzeExpression(code: string, reactive: ReactiveSources, anchor = 0): { deps: Dep[]; pure: boolean }
{
    const { sourceFile } = parseExpressionSlice(projectMarkup(code, 0, anchor), 0);
    return { deps: collectReads(sourceFile, reactive), pure: isPure(sourceFile) };
}

/** Walks a markup node, recording one scope per dynamic binding. */
function collectMarkupBindings(node: MarkupElement | MarkupFragment, reactive: ReactiveSources, scopes: ReactiveScope[]): void
{
    const visitChild = (child: MarkupChild): void =>
    {
        if (child.kind === 'text')
        {
            return;
        }
        if (child.kind === 'expression')
        {
            const { deps, pure } = analyzeExpression(child.code, reactive, child.start);
            scopes.push({ origin: 'text', span: { start: child.start, end: child.end }, deps, pure });
            return;
        }
        visitNode(child);
    };

    const visitNode = (n: MarkupElement | MarkupFragment): void =>
    {
        if (n.kind === 'element')
        {
            for (const attr of n.attributes)
            {
                if (attr.value.kind === 'expression')
                {
                    const { deps, pure } = analyzeExpression(attr.value.code, reactive, attr.start);
                    scopes.push({ origin: 'attribute', span: { start: attr.start, end: attr.end }, deps, pure });
                }
            }
        }
        for (const child of n.children)
        {
            visitChild(child);
        }
    };

    visitNode(node);
}

/**
 * Replaces markup regions inside an expression with a parseable, READ-ONLY
 * projection so the expression parses as TypeScript and the dependency collector
 * sees every reactive read. Each markup region is lowered (the ONE shared lowerer,
 * {@link lowerMarkup}) and its dynamic expressions are collected into an array
 * literal `[e1, e2, ...]`; static structure (tags, literal attrs) carries no reads
 * and is dropped. Reads stay RAW (the collector needs `count`, not `count()`).
 * Recursive so markup nested inside those expressions is projected too. Identity
 * for expressions with no markup. (No `h()`/`generate()` - shares the IR lowerer.)
 *
 * @internal
 */
const projectMarkup = (code: string, holeDepth = 0, anchor = 0): string =>
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
        // The parser's cap is per parseMarkup call and every hole re-enters it at depth 0, so nesting
        // THROUGH holes is bounded here or nowhere - unbounded it overflows this recursion's stack.
        if (holeDepth >= MAX_MARKUP_DEPTH)
        {
            throw markupDepthError(anchor);
        }
        try
        {
            const { node, end } = parseMarkup(code, start);
            out += `[${ collectExprs(code, lowerMarkup(code, node), holeDepth + 1, anchor).join(', ') }]`;
            j = end;
        }
        catch (err)
        {
            if (err instanceof CompileError && err.depthExceeded)
            {
                throw err;
            }
            // Not parseable markup here; keep the rest verbatim.
            return out + code.slice(start);
        }
    }
};

/**
 * Collects every read-bearing expression from a lowered plan as raw source slices
 * (recursively projecting any markup they themselves contain), so the dependency
 * collector can parse them. Walks bindings and nested component props/children.
 *
 * @internal
 */
function collectExprs(code: string, plan: RenderPlan, holeDepth = 0, anchor = 0): string[]
{
    const out: string[] = [];
    const add = (span: Span): void =>
    {
        out.push(projectMarkup(code.slice(span.start, span.end), holeDepth, anchor));
    };
    for (const binding of plan.bindings)
    {
        // Exhaustive over the Binding union ON PURPOSE: this walker is a second enumeration
        // of "which IR kinds carry reads", and an if-chain let it silently fall behind the
        // IR once already. A new kind now fails to COMPILE until this walker decides.
        switch (binding.kind)
        {
            case 'text':
            case 'attribute':
            case 'spread':
                add(binding.expr.span);
                break;
            case 'event':
                add(binding.handler);
                break;
            case 'ref':
                add(binding.ref);
                break;
            case 'bind':
                add(binding.expr);
                break;
            case 'class':
                if (binding.dynamic !== null)
                {
                    add(binding.dynamic);
                }
                for (const toggle of binding.toggles)
                {
                    add(toggle.expr);
                }
                break;
            case 'style':
                if (binding.dynamic !== null)
                {
                    add(binding.dynamic);
                }
                for (const entry of binding.props)
                {
                    add(entry.expr);
                }
                break;
            // A literal content property carries no reads by construction.
            case 'property':
                break;
            case 'component':
            {
                for (const prop of binding.props)
                {
                    switch (prop.kind)
                    {
                        case 'prop':
                        case 'spread':
                            add(prop.expr.span);
                            break;
                        case 'event':
                            add(prop.handler);
                            break;
                        case 'bind':
                            add(prop.expr);
                            break;
                        // A static prop is a literal; nothing to read.
                        case 'static':
                            break;
                    }
                }
                const children = binding.children;
                if (children === null)
                {
                    continue;
                }
                if (children.kind === 'markup')
                {
                    out.push(...collectExprs(code, children.plan, holeDepth, anchor));
                }
                else if (children.kind === 'dynamic')
                {
                    add(children.expr.span);
                }
                else if ('template' in children.body)
                {
                    out.push(...collectExprs(code, children.body, holeDepth, anchor));
                }
                else
                {
                    add(children.body.span);
                }
                break;
            }
        }
    }
    return out;
}

/**
 * Conservative purity: true when an expression performs no call, `new`, `await`/`yield`,
 * assignment, `++`/`--`, or PROPERTY ACCESS on a value this analysis cannot see into.
 *
 * The flag's only consumer is the constant-derived / inert-effect pair, where it means "provably
 * reads nothing reactive". A property read fails that test for the same reason a call does: the
 * object may be an external reactive source. It is not a hypothetical - `createStore` returns a
 * proxy read by plain property access (`store.rows`), so treating `store.rows` as pure warns on
 * the framework's own state container and tells the author to replace it with a plain value,
 * which silently breaks reactivity.
 *
 * A property read on a value BUILT here (`[1, 2].length`, `{ a: 1 }.a`) stays pure: the object is
 * visible in the expression, so there is nothing unseen to be reactive.
 *
 * @internal
 */
function isPure(node: ts.Node): boolean
{
    let pure = true;
    const visit = (n: ts.Node): void =>
    {
        if (!pure)
        {
            return;
        }
        if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isAwaitExpression(n) || ts.isYieldExpression(n))
        {
            pure = false;
            return;
        }
        if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && !isSelfContained(n.expression))
        {
            pure = false;
            return;
        }
        if (ts.isBinaryExpression(n) &&
            n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            n.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
        {
            pure = false;
            return;
        }
        if ((ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) &&
            (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken))
        {
            pure = false;
            return;
        }
        ts.forEachChild(n, visit);
    };
    visit(node);
    return pure;
}

/**
 * @internal Whether an expression's value is constructed IN this expression, so a property read
 * off it cannot reach an unseen reactive source. A literal qualifies; a name does not, because the
 * name may be bound to a store.
 */
function isSelfContained(node: ts.Expression): boolean
{
    if (ts.isParenthesizedExpression(node))
    {
        return isSelfContained(node.expression);
    }
    return ts.isStringLiteral(node)
        || ts.isNumericLiteral(node)
        || ts.isArrayLiteralExpression(node)
        || ts.isObjectLiteralExpression(node)
        || ts.isTemplateExpression(node)
        || ts.isNoSubstitutionTemplateLiteral(node);
}
