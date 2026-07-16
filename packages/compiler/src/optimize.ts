/**
 * MODULE: compiler/optimize - IR optimization passes
 *
 * Every optimization is a PASS over the Render Plan IR - never logic smuggled into codegen (ACP). A
 * pass is `(source, plan) -> plan`; `optimize` runs them in sequence, so future passes (dead-binding
 * elimination, expression simplification, ...) slot in here without touching lowering or codegen.
 *
 * CONSTANT FOLDING (the only pass today): a text hole whose expression is a compile-time literal
 * (`{1 + 2}`, `{"a" + "b"}`) is evaluated at compile time, baked into the template as static text, and
 * its binding dropped - zero runtime work. Folding is restricted to literals and arithmetic/concat
 * over them, so it is always safe (no identifiers, no calls, no side effects).
 *
 * @see {@link optimize} - run the pipeline
 * @internal Compiler optimization stage; not part of the package's public API.
 */

import * as ts from 'typescript';

import type { RenderPlan, TemplateNode, StaticAttr, Binding } from './ir.ts';

import { parseExpressionSlice } from './ts-slice.ts';

/**
 * optimize
 *
 * PURPOSE:
 * Runs the IR optimization pipeline over a render plan and returns the optimized plan.
 *
 * WHY IT EXISTS:
 * It keeps optimizations as discrete, testable IR->IR passes (per ACP) rather than ad-hoc logic
 * embedded in codegen, so passes compose and can be reasoned about in isolation.
 *
 * COMPILER / RUNTIME ROLE:
 * Compiler; runs after lowerComponent and before codegen emits (generateComponent calls it).
 *
 * INPUT CONTRACT:
 * - source: the original `.azeroth` text (needed to evaluate binding spans).
 * - plan: the lowered {@link RenderPlan}.
 *
 * OUTPUT CONTRACT:
 * - A RenderPlan - the same instance when nothing was foldable, or a new plan with folded bindings
 *   removed and their values baked into the template.
 *
 * WHY THIS DESIGN:
 * A plain sequence of passes (today just constant folding). New passes are appended here, so the
 * pipeline grows without lowering or codegen changing.
 *
 * WHEN TO USE:
 * Between lowering and emit for a component's top-level plan.
 *
 * WHEN NOT TO USE:
 * Expression-embedded markup plans (codegen emits those directly without this pipeline).
 *
 * EDGE CASES:
 * - Returns the input plan unchanged when no binding folds.
 *
 * PERFORMANCE NOTES:
 * One walk of the bindings per pass.
 *
 * DEVELOPER WARNING:
 * Passes MUST be pure IR->IR transforms. Constant folding only handles literal arithmetic/concat - it
 * never evaluates identifiers, calls, or anything with side effects.
 *
 * @param source - The original `.azeroth` source
 * @param plan - The lowered render plan
 * @returns The optimized render plan
 * @see {@link foldConstants}
 *
 * @internal
 */
export function optimize(source: string, plan: RenderPlan): RenderPlan
{
    return foldConstants(source, plan);
}

/**
 * Folds compile-time-constant bindings into the static template, dropping them: a text hole becomes
 * static text; a constant attribute becomes a static template attribute (`tabindex={0}` ->
 * `tabindex="0"`; a `true` boolean becomes a bare attribute, a `false` one is dropped). Each fold
 * eliminates a runtime `bindHole`/`setProp` call.
 *
 * @param source - The original `.azeroth` source (to read binding spans).
 * @param plan - The render plan to fold over.
 * @returns A plan with constant bindings baked into the template (the same plan if none folded).
 * @example
 * ```ts
 * // <p>{1 + 2}</p>          -> template <p>3</p>, no binding
 * // <a tabindex={5}>...</a>   -> template <a tabindex="5">...</a>, no binding
 * ```
 * @internal
 */
export function foldConstants(source: string, plan: RenderPlan): RenderPlan
{
    const foldedText = new Map<number, string>();
    const foldedAttrs = new Map<number, StaticAttr[]>();
    const dropped = new Set<Binding>();

    for (const binding of plan.bindings)
    {
        if (binding.kind === 'text')
        {
            const text = tryEvalConstant(source.slice(binding.expr.span.start, binding.expr.span.end));
            if (text !== null)
            {
                foldedText.set(binding.target, text);
                dropped.add(binding);
            }
        }
        else if (binding.kind === 'attribute')
        {
            const value = evalConstant(source.slice(binding.expr.span.start, binding.expr.span.end));
            if (value !== null)
            {
                dropped.add(binding);
                if (value !== false)
                {
                    // `false` -> absent attribute; `true` -> bare; else stringify.
                    const attrs = foldedAttrs.get(binding.target) ?? [];
                    attrs.push({ name: binding.name, value: value === true ? true : String(value) });
                    foldedAttrs.set(binding.target, attrs);
                }
            }
        }
    }

    if (dropped.size === 0)
    {
        return plan;
    }

    return {
        template: foldTemplate(plan.template, foldedText, foldedAttrs),
        bindings: plan.bindings.filter(b => !dropped.has(b))
    };
}

/** Replaces folded holes with static text and adds folded static attributes. */
function foldTemplate(node: TemplateNode, foldedText: Map<number, string>, foldedAttrs: Map<number, StaticAttr[]>): TemplateNode
{
    if (node.kind === 'hole' && foldedText.has(node.id))
    {
        return { kind: 'text', id: node.id, value: foldedText.get(node.id) as string };
    }
    if (node.kind === 'element')
    {
        const extra = foldedAttrs.get(node.id);
        return {
            ...node,
            attrs: extra ? [...node.attrs, ...extra] : node.attrs,
            children: node.children.map(child => foldTemplate(child, foldedText, foldedAttrs))
        };
    }
    if (node.kind === 'fragment')
    {
        return { ...node, children: node.children.map(child => foldTemplate(child, foldedText, foldedAttrs)) };
    }
    return node;
}

/**
 * Evaluates an expression at compile time when it is a literal constant (string
 * / number / boolean and arithmetic/concat over them); returns its text, or
 * null when it isn't a safe constant.
 *
 * @example
 * ```ts
 * tryEvalConstant('1 + 2');      // '3'
 * tryEvalConstant('"a" + "b"');  // 'ab'
 * tryEvalConstant('count()');    // null
 * ```
 */
export function tryEvalConstant(code: string): string | null
{
    const value = evalConstant(code);
    // Booleans render specially in text (false -> nothing), so only fold
    // string/number constants into text content.
    return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

/**
 * The constant value of an expression (string / number / boolean and
 * arithmetic/concat over them), or null when it is not a safe constant.
 */
export function evalConstant(code: string): string | number | boolean | null
{
    const statement = parseExpressionSlice(code, 0).sourceFile.statements[0];
    if (statement === undefined || !ts.isExpressionStatement(statement))
    {
        return null;
    }
    let expr: ts.Expression = statement.expression;
    if (ts.isParenthesizedExpression(expr))
    {
        expr = expr.expression;
    }
    const result = evalConst(expr);
    return result === null ? null : result.value;
}

/** The constant value of an expression, or null when it isn't constant. */
function evalConst(node: ts.Expression): { value: string | number | boolean } | null
{
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    {
        return { value: node.text };
    }
    if (ts.isNumericLiteral(node))
    {
        return { value: Number(node.text) };
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword)
    {
        return { value: true };
    }
    if (node.kind === ts.SyntaxKind.FalseKeyword)
    {
        return { value: false };
    }
    if (ts.isParenthesizedExpression(node))
    {
        return evalConst(node.expression);
    }
    if (ts.isPrefixUnaryExpression(node))
    {
        const operand = evalConst(node.operand);
        if (operand === null || typeof operand.value !== 'number')
        {
            return null;
        }
        if (node.operator === ts.SyntaxKind.MinusToken)
        {
            return { value: -operand.value };
        }
        if (node.operator === ts.SyntaxKind.PlusToken)
        {
            return { value: operand.value };
        }
        return null;
    }
    if (ts.isBinaryExpression(node))
    {
        const left = evalConst(node.left);
        const right = evalConst(node.right);
        if (left === null || right === null)
        {
            return null;
        }
        return evalBinary(node.operatorToken.kind, left.value, right.value);
    }
    return null;
}

/** Folds a binary operation over two constants. */
function evalBinary(op: ts.SyntaxKind, left: string | number | boolean, right: string | number | boolean): { value: string | number | boolean } | null
{
    if (op === ts.SyntaxKind.PlusToken)
    {
        if (typeof left === 'string' || typeof right === 'string')
        {
            return { value: String(left) + String(right) };
        }
        if (typeof left === 'number' && typeof right === 'number')
        {
            return { value: left + right };
        }
        return null;
    }
    if (typeof left !== 'number' || typeof right !== 'number')
    {
        return null;
    }
    switch (op)
    {
        case ts.SyntaxKind.MinusToken: return { value: left - right };
        case ts.SyntaxKind.AsteriskToken: return { value: left * right };
        case ts.SyntaxKind.SlashToken: return right === 0 ? null : { value: left / right };
        case ts.SyntaxKind.PercentToken: return right === 0 ? null : { value: left % right };
        default: return null;
    }
}
