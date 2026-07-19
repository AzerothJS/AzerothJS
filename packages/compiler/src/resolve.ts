/**
 * MODULE: compiler/resolve - the reactive-read collector
 *
 * Given a parsed slice and the component's closed reactive-source set, it returns the dependency set:
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

// `Dep` and `ReactiveSources` are pure data (no TypeScript dependency); they
// live in ./dep.ts and are re-exported here for the collector's consumers.
export type { Dep, ReactiveSources } from './dep.ts';

/**
 * collectReads
 *
 * PURPOSE:
 * Collects the set of reactive dependencies a parsed slice reads - deduplicated, in first-seen order.
 *
 * WHY IT EXISTS:
 * Fine-grained reactivity needs to know exactly which sources an expression depends on so the IR can
 * emit a targeted effect (and nothing wider). This is the function that produces those dep sets, and
 * doing it via the SAME traversal the rewriter uses (walk.ts) guarantees deps and rewrites can never
 * disagree about what is reactive.
 *
 * COMPILER / RUNTIME ROLE:
 * Compiler, analysis stage; called by analyze.ts for each reactive scope. Operates on TypeScript AST.
 *
 * INPUT CONTRACT:
 * - root: the parsed slice (a `ts.Node`/`ts.SourceFile`, typically from ts-slice.ts).
 * - sources: the component's closed reactive-source set ({@link ReactiveSources}: source names + hasProps).
 *
 * OUTPUT CONTRACT:
 * - A {@link Dep}[]: `{ kind: 'source', name }` for state/derived reads and `{ kind: 'prop', field }`
 *   for props reads, each appearing at most once.
 *
 * WHY THIS DESIGN:
 * It only listens to `read`/`propsRead` from the shared traversal and ignores `write` - a bare write
 * (`x = 1`) is not a dependency. Scope-awareness comes from walk.ts, so a shadowing local/param is
 * correctly NOT treated as a source read.
 *
 * WHEN TO USE:
 * Computing a scope's dependency set during analysis.
 *
 * WHEN NOT TO USE:
 * To rewrite reads into getter calls - that's rewrite.ts (which shares the same traversal).
 *
 * EDGE CASES:
 * - Reads of a name shadowed in an inner scope are excluded (soundness).
 * - Deduped by a `s:`/`p:` key, so repeated reads of one source yield one Dep.
 *
 * PERFORMANCE NOTES:
 * One traversal of the slice; dedup via a Set.
 *
 * DEVELOPER WARNING:
 * `sources` must be the component's COMPLETE source set - a name missing from it is treated as a plain
 * (non-reactive) identifier, silently dropping a real dependency.
 *
 * @param root - The parsed slice (e.g. a `ts.SourceFile` from ts-slice.ts)
 * @param sources - The component's reactive sources
 * @returns The deduplicated dependency set the slice reads
 * @see {@link traverseReactive}
 *
 * @example
 * ```ts
 * const { sourceFile } = parseExpressionSlice('Math.floor(count)', 0);
 * collectReads(sourceFile, { names: new Set(['count']), hasProps: false });
 * // [{ kind: 'source', name: 'count' }]
 * ```
 *
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
