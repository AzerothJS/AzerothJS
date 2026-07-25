// @vitest-environment node
//
// The published grammar weld. The compiler package SHIPS the TextMate grammar
// (`@azerothjs/compiler/azeroth.tmLanguage.json` - the copy Shiki/docs tooling and the
// linguist submission consume); the VS Code extension bundles its own copy. This test
// keeps the two byte-identical so an edit to either without the other fails CI instead
// of shipping divergent highlighting.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

describe('the published TextMate grammar', () =>
{
    it('is byte-identical to the VS Code extension bundle', () =>
    {
        const published = readFileSync(join(here, '..', 'syntaxes', 'azeroth.tmLanguage.json'), 'utf8');
        const extension = readFileSync(join(here, '..', '..', '..', 'editors', 'vscode', 'syntaxes', 'azeroth.tmLanguage.json'), 'utf8');
        expect(published).toBe(extension);
    });

    it('declares the shape Shiki registration needs', () =>
    {
        const grammar = JSON.parse(readFileSync(join(here, '..', 'syntaxes', 'azeroth.tmLanguage.json'), 'utf8')) as
            { name: string; scopeName: string; patterns: unknown[]; repository: Record<string, unknown> };
        expect(grammar.scopeName).toBe('source.azeroth');
        expect(grammar.patterns.length).toBeGreaterThan(0);
        expect(Object.keys(grammar.repository).length).toBeGreaterThan(0);
        // The mount keyword made it into the published copy (the 6.2 single-change discipline).
        expect(JSON.stringify(grammar)).toContain('mount');
    });
});
