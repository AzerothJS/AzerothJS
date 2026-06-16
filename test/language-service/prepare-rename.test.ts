// Focused tests for the prepareRename provider: validating a rename target
// up-front. A renameable local symbol yields the identifier's range plus a
// placeholder equal to its current name; a non-identifier position (whitespace,
// a keyword) is rejected with null. Mirrors the language-service.test.ts harness.

import { describe, it, expect, beforeEach } from 'vitest';
import { AzerothLanguageService, LineIndex, pathToUri, type Position } from '@azerothjs/language-service';
import path from 'node:path';

const ROOT = process.cwd();

/** A position located by searching the source for `needle`. */
function at(source: string, needle: string, offsetInNeedle = 0): Position
{
    return new LineIndex(source).positionAt(source.indexOf(needle) + offsetInNeedle);
}

const COUNTER = [
    "import { createSignal } from '@azerothjs/core';",
    'export default function Counter() {',
    '    const [count, setCount] = createSignal(0);',
    '    return <button onClick={() => setCount(count() + 1)}>Count: {count()}</button>;',
    '}'
].join('\n');

let ls: AzerothLanguageService;
const uri = pathToUri(path.join(ROOT, 'Counter.azeroth'));

beforeEach(() =>
{
    ls = new AzerothLanguageService(ROOT);
    ls.didOpen(uri, COUNTER);
});

describe('prepareRename', () =>
{
    it('returns the identifier range and a placeholder for a renameable local symbol', () =>
    {
        const pos = at(COUNTER, 'const [count', 'const ['.length);
        const result = ls.getPrepareRename(uri, pos);
        expect(result).not.toBeNull();
        expect(result!.placeholder).toBe('count');
        const idx = new LineIndex(COUNTER);
        const start = idx.offsetAt(result!.range.start);
        const end = idx.offsetAt(result!.range.end);
        expect(COUNTER.slice(start, end)).toBe('count');
    });

    it('returns null on a non-identifier position (a keyword)', () =>
    {
        const pos = at(COUNTER, 'return <button', 1);
        expect(ls.getPrepareRename(uri, pos)).toBeNull();
    });
});
