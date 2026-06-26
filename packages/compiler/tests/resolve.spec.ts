// @vitest-environment node
//
// Real-execution coverage for collectReads: dependency collection over a parsed
// TypeScript slice - source vs prop reads, dedup, first-seen order, write-not-a-
// read, and scope-aware shadowing soundness.
import { describe, it, expect } from 'vitest';
import { collectReads } from '../src/resolve.ts';
import { parseExpressionSlice, parseStatementsSlice } from '../src/ts-slice.ts';
import type { ReactiveSources, Dep } from '../src/resolve.ts';

const sources = (names: string[], hasProps = false): ReactiveSources => ({ names: new Set(names), hasProps });

function readsOfExpr(code: string, src: ReactiveSources): Dep[]
{
    return collectReads(parseExpressionSlice(code, 0).sourceFile, src);
}

function readsOfStmts(code: string, src: ReactiveSources): Dep[]
{
    return collectReads(parseStatementsSlice(code, 0).sourceFile, src);
}

describe('collectReads', () =>
{
    it('collects a source read', () =>
    {
        expect(readsOfExpr('Math.floor(count)', sources(['count']))).toEqual([{ kind: 'source', name: 'count' }]);
    });

    it('collects a props.field read', () =>
    {
        expect(readsOfExpr('props.label', sources([], true))).toEqual([{ kind: 'prop', field: 'label' }]);
    });

    it('collects a bare props read as the whole-bag field *', () =>
    {
        expect(readsOfExpr('JSON.stringify(props)', sources([], true))).toEqual([{ kind: 'prop', field: '*' }]);
    });

    it('dedupes repeated reads of one source (first-seen order)', () =>
    {
        expect(readsOfExpr('a + b + a', sources(['a', 'b']))).toEqual([
            { kind: 'source', name: 'a' },
            { kind: 'source', name: 'b' }
        ]);
    });

    it('does NOT treat a pure write as a read dependency', () =>
    {
        // `x = 1` is a write only - no dependency.
        expect(readsOfStmts('x = 1;', sources(['x']))).toEqual([]);
    });

    it('a read that is also written still counts as a read', () =>
    {
        // `x = x + 1` reads x (on the right) and writes x (on the left).
        expect(readsOfStmts('x = x + 1;', sources(['x']))).toEqual([{ kind: 'source', name: 'x' }]);
    });

    it('excludes a name shadowed by a function parameter', () =>
    {
        expect(readsOfExpr('((count) => count + 1)', sources(['count']))).toEqual([]);
    });

    it('excludes a name shadowed by a block-scoped local but keeps the outer read', () =>
    {
        const deps = readsOfStmts('log(n); { const n = 5; log(n); }', sources(['n']));
        expect(deps).toEqual([{ kind: 'source', name: 'n' }]);
    });

    it('ignores a name not in the source set (silently non-reactive)', () =>
    {
        expect(readsOfExpr('unknown + 1', sources(['count']))).toEqual([]);
    });
});
