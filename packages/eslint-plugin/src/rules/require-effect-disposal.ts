/**
 * Copyright (c) 2026 AzerothJS.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// azeroth/require-effect-disposal: a bare `createEffect(...)` statement at
// MODULE scope has no owner - no root collects its disposer and the caller
// discarded it, so the effect runs for the life of the page. Inside
// functions, ownership is unknowable syntactically (the surrounding
// component/render() usually provides a root), so the rule deliberately
// stays silent there - module scope is the case that is always wrong.

import type { Rule } from 'eslint';
import { type AstNode, isCallTo } from '../ast.ts';

/** Reports a createEffect whose disposer is dropped outside any owning scope, which leaks it. */
export const requireEffectDisposal: Rule.RuleModule =
{
    meta:
    {
        type: 'problem',
        docs:
        {
            description: 'disallow undisposable module-scope createEffect calls'
        },
        messages:
        {
            naked: 'Module-scope createEffect with a discarded disposer can never be stopped. Keep the returned dispose function, or create the effect inside a createRoot()/component.'
        },
        schema: []
    },

    create(context): Rule.RuleListener
    {
        return {
            ExpressionStatement(node): void
            {
                const statement = node as unknown as AstNode;
                const parent = statement.parent;
                if (parent === undefined || parent.type !== 'Program')
                {
                    return;
                }

                const expression = statement.expression as AstNode | undefined;
                if (isCallTo(expression, 'createEffect'))
                {
                    context.report({
                        node: expression,
                        messageId: 'naked'
                    });
                }
            }
        };
    }
};
