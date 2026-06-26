// @vitest-environment node
//
// Real-execution coverage for ir.isReactive and the IR node/binding shapes as
// produced by the live lowerer. isReactive: the explicit `reactive` flag wins;
// otherwise reactivity is derived from a non-empty dependency set.
import { describe, it, expect } from 'vitest';
import { isReactive } from '../src/ir.ts';
import type { ReactiveExpr } from '../src/ir.ts';

const span = { start: 0, end: 1 };

describe('isReactive', () =>
{
    it('is false for an empty dependency set with no explicit flag', () =>
    {
        const expr: ReactiveExpr = { span, deps: [], pure: true };
        expect(isReactive(expr)).toBe(false);
    });

    it('is true when the dependency set is non-empty', () =>
    {
        const expr: ReactiveExpr = { span, deps: [{ kind: 'source', name: 'n' }], pure: true };
        expect(isReactive(expr)).toBe(true);
    });

    it('honours an explicit reactive:true over an empty dep set', () =>
    {
        const expr: ReactiveExpr = { span, deps: [], pure: true, reactive: true };
        expect(isReactive(expr)).toBe(true);
    });

    it('honours an explicit reactive:false over a non-empty dep set', () =>
    {
        const expr: ReactiveExpr = { span, deps: [{ kind: 'source', name: 'n' }], pure: true, reactive: false };
        expect(isReactive(expr)).toBe(false);
    });

    it('counts a prop dependency as reactive', () =>
    {
        const expr: ReactiveExpr = { span, deps: [{ kind: 'prop', field: 'x' }], pure: true };
        expect(isReactive(expr)).toBe(true);
    });
});
