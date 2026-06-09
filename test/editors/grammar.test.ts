// The TextMate grammar is shipped by both editors and must stay structurally
// sound: it reuses VS Code's TypeScript+JSX grammar (source.tsx) for the whole
// file and adds an AzerothJS layer that marks the built-in control-flow
// components. These structural snapshots catch accidental breakage (a bad scope
// name, a dropped include, a missing built-in) without needing a TextMate
// tokenizer in the test runner.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

const VSCODE_GRAMMAR = 'editors/vscode/syntaxes/azeroth.tmLanguage.json';
const JETBRAINS_GRAMMAR = 'editors/jetbrains/src/main/resources/textmate/azeroth.tmLanguage.json';

const BUILTINS = ['Show', 'For', 'Switch', 'Match', 'Portal', 'Dynamic', 'Suspense', 'ErrorBoundary', 'Transition', 'Outlet'];

function grammar(rel: string): Record<string, unknown>
{
    return JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
}

describe('azeroth.tmLanguage.json', () =>
{
    it('declares the source.azeroth scope and embeds the TypeScript+JSX grammar', () =>
    {
        const g = grammar(VSCODE_GRAMMAR);
        expect(g.scopeName).toBe('source.azeroth');
        const includes = (g.patterns as Array<{ include?: string }>).map(p => p.include);
        expect(includes).toContain('source.tsx');
        expect(includes).toContain('#azeroth-builtins');
    });

    it('highlights every built-in control-flow component', () =>
    {
        const g = grammar(VSCODE_GRAMMAR);
        const builtins = (g.repository as Record<string, { match: string; name: string }>)['azeroth-builtins'];
        expect(builtins.name).toContain('support.class.component');
        for (const name of BUILTINS)
        {
            expect(builtins.match).toContain(name);
        }
        // The match must only fire right after a tag open (`<` or `</`).
        expect(builtins.match).toContain('</?');
    });

    it('ships the same grammar to the JetBrains plugin', () =>
    {
        const a = grammar(VSCODE_GRAMMAR);
        const b = grammar(JETBRAINS_GRAMMAR);
        expect(b.scopeName).toBe(a.scopeName);
        expect((b.repository as Record<string, { match: string }>)['azeroth-builtins'].match)
            .toBe((a.repository as Record<string, { match: string }>)['azeroth-builtins'].match);
    });
});
