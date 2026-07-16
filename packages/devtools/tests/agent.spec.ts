// Smoke coverage for the devtools agent's pure, deterministic surface - the leak-trend
// heuristic and the transport-safe value preview. The stateful hook (createAgent) needs a
// live reactivity graph and DOM; here we pin the two functions that carry the analysis logic,
// so a regression in the leak detector or the value formatter is caught without a browser.
import { describe, it, expect } from 'vitest';
import { detectLeakTrend, previewValue } from '../src/agent.ts';

describe('detectLeakTrend', () =>
{
    it('returns false below the sample cap (not enough history to judge)', () =>
    {
        expect(detectLeakTrend([1, 2, 3])).toBe(false);
        expect(detectLeakTrend(Array.from({ length: 29 }, (_v, i) => i))).toBe(false);
    });

    it('flags a sustained upward climb across the full window', () =>
    {
        const climbing = Array.from({ length: 30 }, (_v, i) => i * 5);
        expect(detectLeakTrend(climbing)).toBe(true);
    });

    it('does NOT flag a plateau after a startup ramp', () =>
    {
        // First half ramps, second half is flat and high - materially higher on average but
        // not still climbing, so it is a settled baseline, not a leak.
        const plateau = [...Array.from({ length: 15 }, (_v, i) => i), ...(Array(15).fill(100) as number[])];
        expect(detectLeakTrend(plateau)).toBe(false);
    });

    it('does NOT flag steady noise around a stable level', () =>
    {
        const noise = Array.from({ length: 30 }, (_v, i) => 50 + (i % 2 === 0 ? 1 : -1));
        expect(detectLeakTrend(noise)).toBe(false);
    });
});

describe('previewValue', () =>
{
    it('renders primitives and nullish values', () =>
    {
        expect(previewValue(null)).toBe('null');
        expect(previewValue(undefined)).toBe('undefined');
        expect(previewValue(42)).toBe('42');
        expect(previewValue(true)).toBe('true');
        expect(previewValue('hi')).toBe('"hi"');
        expect(previewValue(() => 0)).toBe('fn()');
    });

    it('summarizes arrays by length and truncates long strings', () =>
    {
        expect(previewValue([1, 2, 3])).toBe('Array(3)');
        const long = 'x'.repeat(200);
        const out = previewValue(long);
        expect(out.endsWith('...')).toBe(true);
        expect(out.length).toBeLessThanOrEqual(120);
    });

    it('serializes plain objects and survives a circular reference', () =>
    {
        expect(previewValue({ a: 1 })).toBe('{"a":1}');
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(previewValue(circular)).toBe('Object');
    });
});
