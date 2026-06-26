// @vitest-environment node
//
// Real-execution coverage for the R2 reactive rewrite: reads -> getter calls,
// writes -> setter calls (plain/compound/++/--), props left as-is, shorthand
// property expansion, statement-list rewriting, scope-aware shadowing, the
// setterName convention, and the documented non-idempotency.
import { describe, it, expect } from 'vitest';
import { rewriteReactive, rewriteStatements, setterName } from '../src/rewrite.ts';
import type { ReactiveSources } from '../src/dep.ts';

const sources = (names: string[], hasProps = false): ReactiveSources => ({ names: new Set(names), hasProps });

describe('setterName', () =>
{
    it('capitalises the first letter and prefixes set', () =>
    {
        expect(setterName('count')).toBe('setCount');
        expect(setterName('x')).toBe('setX');
        expect(setterName('isOpen')).toBe('setIsOpen');
    });
});

describe('rewriteReactive - reads', () =>
{
    it('rewrites a source read to a getter call', () =>
    {
        expect(rewriteReactive('count + 1', sources(['count']))).toBe('count() + 1');
    });

    it('leaves a non-source identifier untouched', () =>
    {
        expect(rewriteReactive('other + 1', sources(['count']))).toBe('other + 1');
    });

    it('leaves a props.field read as-is (getter object reactivity)', () =>
    {
        expect(rewriteReactive('props.x + 1', sources(['count'], true))).toBe('props.x + 1');
    });

    it('expands a shorthand property read to key: getter()', () =>
    {
        expect(rewriteReactive('({ count })', sources(['count']))).toBe('({ count: count() })');
    });

    it('rewrites multiple reads of the same source', () =>
    {
        expect(rewriteReactive('count + count', sources(['count']))).toBe('count() + count()');
    });
});

describe('rewriteReactive - writes', () =>
{
    it('rewrites a plain assignment to a setter call', () =>
    {
        expect(rewriteReactive('count = 5', sources(['count']))).toBe('setCount(5)');
    });

    it('rewrites a compound assignment to a functional-updater setter call', () =>
    {
        expect(rewriteReactive('count += 2', sources(['count']))).toBe('setCount(__p => __p + (2))');
    });

    it('rewrites ++/-- to a functional-updater setter call', () =>
    {
        expect(rewriteReactive('count++', sources(['count']))).toBe('setCount(__p => __p + 1)');
        expect(rewriteReactive('count--', sources(['count']))).toBe('setCount(__p => __p - 1)');
    });
});

describe('rewriteReactive - scope shadowing', () =>
{
    it('leaves a shadowing parameter untouched', () =>
    {
        expect(rewriteReactive('((count) => count + 1)', sources(['count']))).toBe('((count) => count + 1)');
    });

    it('rewrites only the unshadowed read outside the inner scope', () =>
    {
        // Outer `count` read is rewritten; the param `count` inside the arrow is not.
        const result = rewriteReactive('count + ((count) => count)(0)', sources(['count']));
        expect(result).toBe('count() + ((count) => count)(0)');
    });
});

describe('rewriteReactive - non-idempotency (documented)', () =>
{
    it('running twice yields a double getter call x()()', () =>
    {
        const once = rewriteReactive('count', sources(['count']));
        expect(once).toBe('count()');
        expect(rewriteReactive(once, sources(['count']))).toBe('count()()');
    });
});

describe('rewriteStatements', () =>
{
    it('rewrites reads inside a statement list', () =>
    {
        expect(rewriteStatements('log(count);', sources(['count']))).toBe('log(count());');
    });

    it('rewrites a write statement to a setter call', () =>
    {
        expect(rewriteStatements('count = count + 1;', sources(['count']))).toBe('setCount(count() + 1);');
    });

    it('rewrites across multiple statements with a shadowing local', () =>
    {
        const code = 'const local = count; { const count = 9; log(count); } log(count);';
        const result = rewriteStatements(code, sources(['count']));
        // First and last `count` (outer) -> getter; the block-local one stays plain.
        expect(result).toBe('const local = count(); { const count = 9; log(count); } log(count());');
    });
});
