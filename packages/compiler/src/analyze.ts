/**
 * MODULE: compiler/analyze - reactive analysis driver
 *
 * Walks a component's body and produces, for each reactive scope (a `derived` initializer, an
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

import { findMarkupStart } from './scanner.ts';
import { parseMarkup } from './markup-parser.ts';
import { lowerMarkup } from './lower.ts';
import { parseDeclarationSlice, parseStatementsSlice, parseExpressionSlice, parsePropsPattern, parseComponentParam, formFieldKeys } from './ts-slice.ts';
import { collectReads, type ReactiveSources, type Dep } from './resolve.ts';

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
    /** Destructured-prop aliases from a `component Name({ a, b }: P)` signature (local name -> read expr). */
    propAliases?: ReadonlyMap<string, string>;
    /** `form` declarations: form name -> its field-key set (drives the `NAME.field` read/write rewrite). */
    forms: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * analyzeComponent
 *
 * PURPOSE:
 * Analyzes a component's reactivity: its declared sources (state/derived), whether it takes props,
 * and, for every reactive scope, the dependency set it reads.
 *
 * WHY IT EXISTS:
 * The compiler must know WHICH reactive sources each expression reads to decide, per binding, between
 * a targeted effect and a set-once value. Computing that once, up front, is what lets lowering wire
 * dependency sets by span and codegen emit surgical updates instead of re-running everything.
 *
 * COMPILER / RUNTIME ROLE:
 * Compiler, analysis stage; runs per component before lowerComponent. Uses the TypeScript API (the
 * compiler's `typescript` peer dep) for slice parsing and scope-aware read collection.
 *
 * INPUT CONTRACT:
 * - source: the original `.azeroth` text.
 * - component: the {@link ComponentDecl} from parseModule.
 *
 * OUTPUT CONTRACT:
 * - A {@link ReactiveAnalysis}: `sources` (each state/derived with its name span), `hasProps`, and
 *   `scopes` (one per derived/effect/text/attribute, each with its deps and conservative `pure` flag).
 *
 * WHY THIS DESIGN:
 * Each expression is parsed as a real TypeScript slice so scope and shadowing are sound (a lambda
 * param named like a state correctly shadows it). Markup inside a hole is projected to a `[e1, e2, ...]`
 * read-only array via the shared lowerMarkup, so one slice parse covers the whole expression and the
 * read collector sees every embedded dynamic sub-expression with its scope intact.
 *
 * WHEN TO USE:
 * Codegen's per-component path, paired with the matching lowerComponent call.
 *
 * WHEN NOT TO USE:
 * For diagnostics-only flows that don't need dep sets (those build their own slices via diagnostics).
 *
 * EDGE CASES:
 * - `pure` is CONSERVATIVE: any call/new/await/assignment/++/-- marks a scope impure.
 * - Shadowing is respected, so a read of a name shadowed by a local/param is NOT a source dep.
 *
 * PERFORMANCE NOTES:
 * One slice parse per reactive construct; markup projection adds a lower pass but no extra TS parse.
 *
 * DEVELOPER WARNING:
 * Spans in the result key lowering's dep lookup - they index into THIS `source`. Pair the analysis
 * with the same source you pass to lowerComponent, or deps mis-map.
 *
 * @param source - The original `.azeroth` source
 * @param component - The component declaration (from `parseModule`)
 * @returns The component's {@link ReactiveAnalysis}
 * @see {@link lowerComponent}
 * @see {@link ReactiveAnalysis}
 *
 * @example
 * ```ts
 * const m = parseModule('component C { state n = 0; derived d = n * 2; <p>{d}</p> }');
 * const a = analyzeComponent(src, m.items[0] as ComponentDecl);
 * a.scopes.find(s => s.origin === 'derived')!.deps; // [{ kind: 'source', name: 'n' }]
 * ```
 *
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
        : { typeSpan: null, patternSpan: null };
    const hasProps = component.propsParam !== null;
    const propAliases = param.patternSpan
        ? parsePropsPattern(source.slice(param.patternSpan.start, param.patternSpan.end))
        : undefined;

    const forms = new Map<string, ReadonlySet<string>>();
    for (const item of component.body)
    {
        if (item.kind === 'state' || item.kind === 'derived' || item.kind === 'deferred')
        {
            sources.push({ kind: item.kind, name: item.name, span: { start: item.nameStart, end: item.nameEnd } });
            names.add(item.name);
        }
        else if (item.kind === 'form')
        {
            forms.set(item.name, new Set(formFieldKeys(source, item)));
        }
    }

    const reactive: ReactiveSources = { names, hasProps, propAliases, forms };
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

    return { sources, hasProps, scopes, propAliases, forms };
}

/** Analyzes one expression's source (projecting any nested markup first). */
function analyzeExpression(code: string, reactive: ReactiveSources): { deps: Dep[]; pure: boolean }
{
    const { sourceFile } = parseExpressionSlice(projectMarkup(code), 0);
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
            const { deps, pure } = analyzeExpression(child.code, reactive);
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
                    const { deps, pure } = analyzeExpression(attr.value.code, reactive);
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
const projectMarkup = (code: string): string =>
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
            out += `[${ collectExprs(code, lowerMarkup(code, node)).join(', ') }]`;
            j = end;
        }
        catch
        {
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
function collectExprs(code: string, plan: RenderPlan): string[]
{
    const out: string[] = [];
    const add = (span: Span): void =>
    {
        out.push(projectMarkup(code.slice(span.start, span.end)));
    };
    for (const binding of plan.bindings)
    {
        if (binding.kind === 'text' || binding.kind === 'attribute' || binding.kind === 'spread')
        {
            add(binding.expr.span);
        }
        else if (binding.kind === 'event')
        {
            add(binding.handler);
        }
        else if (binding.kind === 'ref')
        {
            add(binding.ref);
        }
        else if (binding.kind === 'component')
        {
            for (const prop of binding.props)
            {
                if (prop.kind === 'prop' || prop.kind === 'spread')
                {
                    add(prop.expr.span);
                }
                else if (prop.kind === 'event')
                {
                    add(prop.handler);
                }
            }
            const children = binding.children;
            if (children === null)
            {
                continue;
            }
            if (children.kind === 'markup')
            {
                out.push(...collectExprs(code, children.plan));
            }
            else if (children.kind === 'dynamic')
            {
                add(children.expr.span);
            }
            else if ('template' in children.body)
            {
                out.push(...collectExprs(code, children.body));
            }
            else
            {
                add(children.body.span);
            }
        }
    }
    return out;
}

/**
 * Conservative purity: true when an expression performs no call, `new`,
 * `await`/`yield`, assignment, or `++`/`--`. May be refined into a real effect
 * analysis later.
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
