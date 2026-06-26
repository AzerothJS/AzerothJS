/**
 * MODULE: compiler/handler - event-handler shape classification
 *
 * NORMATIVE RULE: an `on*` handler value must be a FUNCTION (the listener run on the event);
 * an expression of non-function type is invalid in handler position. That rule belongs to the
 * type system. isSetupHandler is the CONSERVATIVE, type-free SUBSET of it the compiler can
 * enforce syntactically: it returns true only for expressions provably recognizable, without
 * types, as a side effect performed at setup rather than a function -
 *   - an assignment (`count = 1`),
 *   - an increment/decrement (`count++`, `--n`), or
 *   - a zero-argument call of a plain identifier or member path (`save()`, `actions.reset()`).
 * It returns false for everything else (a reference, a function literal, a call WITH arguments -
 * the handler-factory idiom `makeHandler(id)` - or a call whose callee is itself a call/index),
 * deferring those to the type system. So "false" means "no provable setup-time mistake," NOT
 * "guaranteed a function."
 *
 * Both the build-time diagnostics (diagnoseModule) and codegen consume this ONE classifier, so
 * the diagnostic's error message and codegen's emit-time guard can never disagree about which
 * handlers are rejected. See @azerothjs/compiler's README ("Event handlers") for the spec.
 */

import * as ts from 'typescript';
import { parseExpressionSlice } from './ts-slice.ts';

/**
 * True when `code` (an `on*` handler expression) evaluates AT SETUP rather than being a
 * function invoked on the event - so it cannot be a valid event listener.
 *
 * Recognises an assignment, a prefix/postfix `++`/`--`, or a zero-argument call of a plain
 * identifier or dotted path. A call with arguments (the handler-factory idiom) and any other
 * shape (a bare reference, a function literal, a member access, a conditional) return false.
 *
 * @param code - The raw handler expression source (e.g. `count++`).
 * @returns True if the expression runs at setup and is therefore not a function.
 * @internal
 */
export function isSetupHandler(code: string): boolean
{
    const statement = parseExpressionSlice(code, 0).sourceFile.statements[0];
    if (statement === undefined || !ts.isExpressionStatement(statement))
    {
        return false;
    }
    // Parentheses are transparent: strip every layer (the analyzer's own wrapper plus any
    // the author wrote) so `(count++)` is classified the same as `count++`.
    let expr: ts.Expression = statement.expression;
    while (ts.isParenthesizedExpression(expr))
    {
        expr = expr.expression;
    }
    if (ts.isCallExpression(expr))
    {
        return expr.arguments.length === 0 && isPlainCallee(expr.expression);
    }
    if (ts.isPostfixUnaryExpression(expr) || ts.isPrefixUnaryExpression(expr))
    {
        return expr.operator === ts.SyntaxKind.PlusPlusToken || expr.operator === ts.SyntaxKind.MinusMinusToken;
    }
    if (ts.isBinaryExpression(expr))
    {
        return expr.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && expr.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    }
    return false;
}

/**
 * The error message for a handler that runs at setup instead of being a function. ONE builder so the
 * build-time diagnostic (`diagnoseModule`) and the codegen emit-time guard always speak with the same
 * wording and suggest the same fix - mirroring how {@link isSetupHandler} is the one shared classifier.
 *
 * When the attribute name is known (the diagnostics path) the suggested fix is attribute-shaped
 * (`onClick={() => ...}`); without it (the codegen guard, which sees only the handler span) the fix is
 * the bare wrapped form (`{() => ...}`). Both say WHAT (must be a function), WHY (runs at setup, not on
 * the event), and HOW (wrap it).
 *
 * @param handler - The raw handler expression (already trimmed).
 * @param attrName - The event attribute name (`onClick`), when known.
 * @returns The full diagnostic message.
 * @internal
 */
export function setupHandlerMessage(handler: string, attrName?: string): string
{
    const subject = attrName === undefined ? 'Event handler' : `Event handler "${ attrName }"`;
    const fix = attrName === undefined ? `{() => ${ handler }}` : `${ attrName }={() => ${ handler }}`;
    return `${ subject } must be a function - \`${ handler }\` runs at setup, not on the event. Wrap it: ${ fix }.`;
}

/**
 * An identifier or a dotted member path of identifiers: `save`, `actions.reset`.
 *
 * @param expr - The callee expression.
 * @returns True for a plain identifier/dotted-path callee.
 * @internal
 */
function isPlainCallee(expr: ts.Expression): boolean
{
    if (ts.isIdentifier(expr))
    {
        return true;
    }
    if (ts.isPropertyAccessExpression(expr))
    {
        return isPlainCallee(expr.expression);
    }
    return false;
}
