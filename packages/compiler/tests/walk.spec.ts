// @vitest-environment node
//
// Real-execution coverage for traverseReactive: the shared scope-aware traversal
// that emits read / propsRead / write events. Validates event classification,
// write-vs-read separation, props handling, and lexical shadowing across
// function and block scopes.
import { describe, it, expect } from 'vitest';
import type * as ts from 'typescript';
import { traverseReactive } from '../src/walk.ts';
import { parseExpressionSlice, parseStatementsSlice } from '../src/ts-slice.ts';
import type { ReactiveSources } from '../src/dep.ts';

const sources = (names: string[], hasProps = false): ReactiveSources => ({ names: new Set(names), hasProps });

interface Events
{
    reads: string[];
    propsReads: string[];
    writes: string[];
}

function walkExpr(code: string, src: ReactiveSources): Events
{
    return run(parseExpressionSlice(code, 0).sourceFile, src);
}

function walkStmts(code: string, src: ReactiveSources): Events
{
    return run(parseStatementsSlice(code, 0).sourceFile, src);
}

function run(root: ts.Node, src: ReactiveSources): Events
{
    const events: Events = { reads: [], propsReads: [], writes: [] };
    traverseReactive(root, src, {
        read: (id) => events.reads.push(id.text),
        propsRead: (_node, field) => events.propsReads.push(field),
        write: (target) => events.writes.push(target.text)
    });
    return events;
}

describe('traverseReactive - read events', () =>
{
    it('reports an unshadowed source read', () =>
    {
        expect(walkExpr('count + 1', sources(['count'])).reads).toEqual(['count']);
    });

    it('reports a shorthand-property read', () =>
    {
        expect(walkExpr('({ count })', sources(['count'])).reads).toEqual(['count']);
    });

    it('does not report a name absent from the source set', () =>
    {
        expect(walkExpr('other + 1', sources(['count'])).reads).toEqual([]);
    });
});

describe('traverseReactive - props events', () =>
{
    it('reports a props.field access as that field', () =>
    {
        expect(walkExpr('props.label', sources([], true)).propsReads).toEqual(['label']);
    });

    it('reports a bare props read as the whole bag *', () =>
    {
        expect(walkExpr('use(props)', sources([], true)).propsReads).toEqual(['*']);
    });

    it('ignores props entirely when hasProps is false', () =>
    {
        const events = walkExpr('props.label', sources([], false));
        expect(events.propsReads).toEqual([]);
        expect(events.reads).toEqual([]);
    });
});

describe('traverseReactive - write events (not reads)', () =>
{
    it('reports a plain assignment as a write, never a read', () =>
    {
        const events = walkStmts('x = 1;', sources(['x']));
        expect(events.writes).toEqual(['x']);
        expect(events.reads).toEqual([]);
    });

    it('reports ++/-- as a write', () =>
    {
        expect(walkStmts('x++;', sources(['x'])).writes).toEqual(['x']);
        expect(walkStmts('--x;', sources(['x'])).writes).toEqual(['x']);
    });

    it('separates the write target from a read on the right-hand side', () =>
    {
        const events = walkStmts('x = x + 1;', sources(['x']));
        expect(events.writes).toEqual(['x']);
        expect(events.reads).toEqual(['x']);
    });
});

describe('traverseReactive - scope shadowing', () =>
{
    it('a function parameter shadows a source for the whole function body', () =>
    {
        expect(walkExpr('((count) => count + count)', sources(['count'])).reads).toEqual([]);
    });

    it('a block-scoped const shadows the source inside the block only', () =>
    {
        const events = walkStmts('log(n); { const n = 9; log(n); } log(n);', sources(['n']));
        // The two outer reads fire; the block-local read is shadowed.
        expect(events.reads).toEqual(['n', 'n']);
    });

    it('a destructured local binds every introduced name into the shadow scope', () =>
    {
        const events = walkStmts('{ const { a, b } = obj; log(a, b); }', sources(['a', 'b']));
        expect(events.reads).toEqual([]);
    });

    it('a name not bound by the inner scope is still reactive inside it', () =>
    {
        // `m` is not shadowed by the param `count`, so its read fires.
        expect(walkExpr('((count) => m + count)', sources(['count', 'm'])).reads).toEqual(['m']);
    });
});
