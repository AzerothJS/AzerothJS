// azeroth/no-self-write-in-effect: inside one createEffect callback, calling
// a signal's setter while also reading its getter is the synchronous
// feedback loop - the write re-runs the effect that is currently running.
// Wrapping the write in untrack() (or restructuring) is the fix, and an
// untrack-wrapped write is exactly what the rule permits.

import type { Rule } from 'eslint';
import {
    type AstNode,
    type CallNode,
    type SignalPairs,
    collectSignalPair,
    findAncestor,
    isCallTo,
    isFunctionNode,
    isIdentifier
} from '../ast.ts';

interface EffectFrame
{
    /** The effect's callback function node. */
    fn: AstNode;

    /** Getter names called (not via untrack) in this callback. */
    reads: Set<string>;

    /** Setter calls (not via untrack) awaiting the read check. */
    writes: { node: CallNode; setterName: string }[];
}

export const noSelfWriteInEffect: Rule.RuleModule = {
    meta:
    {
        type: 'problem',
        docs:
        {
            description: 'disallow writing a signal inside an effect that reads it (synchronous feedback loop)'
        },
        messages:
        {
            selfWrite: 'This effect reads {{getter}}() and writes it with {{setter}}() - a synchronous feedback loop. Wrap the write in untrack(() => ...) or derive the value with createMemo.'
        },
        schema: []
    },

    create(context): Rule.RuleListener
    {
        const pairs: SignalPairs = { getterOf: new Map(), getters: new Set() };
        const stack: EffectFrame[] = [];

        function insideUntrack(node: AstNode, boundary: AstNode): boolean
        {
            return findAncestor(node, (a) => isCallTo(a, 'untrack'), boundary) !== null;
        }

        return {
            VariableDeclarator(node): void
            {
                collectSignalPair(node as unknown as AstNode, pairs);
            },

            CallExpression(node): void
            {
                const call = node as unknown as CallNode;

                // Entering an effect: the callback is argument 0.
                if (isCallTo(call, 'createEffect') && isFunctionNode(call.arguments[0]))
                {
                    stack.push({ fn: call.arguments[0], reads: new Set(), writes: [] });
                    return;
                }

                const frame = stack[stack.length - 1];
                if (frame === undefined || !isIdentifier(call.callee))
                {
                    return;
                }
                const name = call.callee.name;

                if (pairs.getters.has(name) && !insideUntrack(call, frame.fn))
                {
                    frame.reads.add(name);
                }

                const getter = pairs.getterOf.get(name);
                if (getter !== undefined && !insideUntrack(call, frame.fn))
                {
                    frame.writes.push({ node: call, setterName: name });
                }
            },

            'CallExpression:exit'(node): void
            {
                const call = node as unknown as CallNode;
                const frame = stack[stack.length - 1];
                if (frame === undefined || !isCallTo(call, 'createEffect') || call.arguments[0] !== frame.fn)
                {
                    return;
                }
                stack.pop();

                for (const write of frame.writes)
                {
                    const getter = pairs.getterOf.get(write.setterName);
                    if (getter !== undefined && frame.reads.has(getter))
                    {
                        context.report({
                            node: write.node,
                            messageId: 'selfWrite',
                            data: { getter, setter: write.setterName }
                        } as unknown as Parameters<typeof context.report>[0]);
                    }
                }
            }
        };
    }
};
