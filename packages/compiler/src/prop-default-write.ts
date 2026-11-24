/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as ts from 'typescript';

/**
 * Whether a resolved parameter alias is itself the target of a write. Follow the
 * target side of a destructuring pattern. A member receiver, computed key or
 * default initializer still reads the alias when the surrounding pattern is written.
 */
export function isPropDefaultWrite(id: ts.Identifier): boolean
{
    let part: ts.Node = id;
    let inPattern = false;
    for (;;)
    {
        const parent = part.parent;
        if (ts.isBinaryExpression(parent))
        {
            const operator = parent.operatorToken.kind;
            return parent.left === part && operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
        }
        if (ts.isForOfStatement(parent) || ts.isForInStatement(parent))
        {
            return parent.initializer === part;
        }
        if (ts.isDeleteExpression(parent) || ts.isPostfixUnaryExpression(parent))
        {
            return !inPattern;
        }
        if (ts.isPrefixUnaryExpression(parent))
        {
            return !inPattern && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken);
        }
        if ((ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent)
            || ts.isTypeAssertionExpression(parent) || ts.isSatisfiesExpression(parent)) && parent.expression === part)
        {
            part = parent;
            continue;
        }
        if (ts.isArrayLiteralExpression(parent) || ts.isObjectLiteralExpression(parent)
            || ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)
            || (ts.isShorthandPropertyAssignment(parent) && parent.name === part)
            || (ts.isPropertyAssignment(parent) && parent.initializer === part))
        {
            inPattern = true;
            part = parent;
            continue;
        }
        return false;
    }
}
