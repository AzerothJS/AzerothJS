// azeroth/handler-call: the hyperscript twin of the compiler's
// azeroth/handler-call markup rule. `h('button', { onClick: save() })`
// calls save() while BUILDING the element and passes its result as the
// handler. Zero-argument calls of a plain reference are flagged;
// `onClick: makeHandler(id)` (the factory idiom) stays silent.

import type { Rule } from 'eslint';
import { type AstNode, type CallNode, isCallTo, isIdentifier } from '../ast.ts';

/** `save` or `actions.reset` - a bare callable reference. */
function isBareReference(node: AstNode | undefined): boolean
{
    if (node === undefined)
    {
        return false;
    }
    if (node.type === 'Identifier')
    {
        return true;
    }
    if (node.type === 'MemberExpression')
    {
        return (node.computed !== true)
            && isBareReference(node.object as AstNode)
            && isIdentifier(node.property as AstNode);
    }
    return false;
}

export const handlerCall: Rule.RuleModule = {
    meta:
    {
        type: 'problem',
        docs:
        {
            description: 'disallow zero-argument calls passed as h() event handlers'
        },
        messages:
        {
            called: '{{key}}: {{callee}}() runs while the element is being built and passes its RESULT as the handler. Use {{key}}: {{callee}} or {{key}}: () => {{callee}}().'
        },
        schema: []
    },

    create(context): Rule.RuleListener
    {
        return {
            CallExpression(node): void
            {
                const call = node as unknown as CallNode;
                if (!isCallTo(call, 'h'))
                {
                    return;
                }
                const props = call.arguments[1];
                if (props === undefined || props.type !== 'ObjectExpression')
                {
                    return;
                }

                for (const property of props.properties as AstNode[])
                {
                    if (property.type !== 'Property' || property.computed === true)
                    {
                        continue;
                    }
                    const key = property.key as AstNode;
                    if (!isIdentifier(key) || !/^on[A-Z]/.test(key.name))
                    {
                        continue;
                    }
                    const value = property.value as AstNode;
                    if (
                        value.type === 'CallExpression' &&
                        (value as CallNode).arguments.length === 0 &&
                        isBareReference((value as CallNode).callee)
                    )
                    {
                        const source = context.sourceCode.getText(
                            (value as CallNode).callee as unknown as Parameters<typeof context.sourceCode.getText>[0]
                        );
                        context.report({
                            node: value,
                            messageId: 'called',
                            data: { key: key.name, callee: source }
                        } as unknown as Parameters<typeof context.report>[0]);
                    }
                }
            }
        };
    }
};
