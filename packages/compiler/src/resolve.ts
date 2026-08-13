/**
 * The reactive-read collector. Given a parsed slice and the component's closed reactive-source set, it returns the dependency set:
 * which reactive sources the slice reads. This is what makes compile-time fine-grained reactivity
 * sound.
 *
 * It is a thin consumer of the shared, scope-aware traversal in walk.ts, so the dependency collector
 * and the R2 rewriter (rewrite.ts) resolve reactivity IDENTICALLY. It listens to `read`/`propsRead`
 * and ignores `write` - a pure write (`x = 1`) is not a dependency.
 *
 * @see {@link collectReads} - the collector entry point
 * @internal Compiler analysis stage; not part of the package's public API.
 */

import type * as ts from 'typescript';

import type { Dep, ReactiveSources } from './dep.ts';

import { traverseReactive } from './walk.ts';

/**
 * The reactive dependencies a parsed slice reads, deduplicated and in first-seen order.
 *
 * Fine-grained reactivity needs to know exactly which sources an expression depends on, so
 * the IR can emit a targeted effect and nothing wider. Producing that through the SAME
 * traversal the rewriter uses is what guarantees dependencies and rewrites cannot disagree
 * about what is reactive.
 *
 * It listens to reads only. A bare write is not a dependency, and a read of a name shadowed
 * in an inner scope is correctly excluded.
 *
 * `sources` must be the component's COMPLETE source set. A name missing from it is treated as
 * a plain identifier, which silently drops a real dependency.
 *
 * @param root - The parsed slice.
 * @param sources - The component's reactive-source names, and whether it takes props.
 * @returns One entry per distinct source or prop field read.
 * @example
 * const { sourceFile } = parseExpressionSlice('Math.floor(count)', 0);
 *
 * collectReads(sourceFile, { names: new Set(['count']), hasProps: false });
 * // [{ kind: 'source', name: 'count' }]
 *
 * @see {@link traverseReactive}
 * @internal
 */
export function collectReads(root: ts.Node, sources: ReactiveSources): Dep[]
{
    const deps: Dep[] = [];
    const seen = new Set<string>();

    const add = (key: string, dep: Dep): void =>
    {
        if (!seen.has(key))
        {
            seen.add(key);
            deps.push(dep);
        }
    };

    traverseReactive(root, sources, {
        read: (id) => add(`s:${ id.text }`, { kind: 'source', name: id.text }),
        propsRead: (_node, field) => add(`p:${ field }`, { kind: 'prop', field })
    });

    return deps;
}
