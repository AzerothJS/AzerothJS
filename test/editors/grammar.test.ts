// VS Code's TextMate grammar must stay structurally sound: it is a native
// `source.azeroth` grammar (no borrowed grammar) covering the TypeScript module
// body plus AzerothJS markup, and it marks the built-in control-flow components.
// These structural snapshots catch accidental breakage (a bad scope name, a lost
// pattern, a missing built-in) without needing a TextMate tokenizer in the test
// runner.
//
// The JetBrains plugin uses a NATIVE language implementation (its own lexer), so
// there is nothing to cross-check here.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

const VSCODE_GRAMMAR = 'editors/vscode/syntaxes/azeroth.tmLanguage.json';

const BUILTINS = ['Show', 'For', 'Switch', 'Match', 'Portal', 'Dynamic', 'Suspense', 'ErrorBoundary', 'Transition', 'Outlet'];

function grammar(rel: string): Record<string, unknown>
{
    return JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
}

describe('azeroth.tmLanguage.json', () =>
{
    it('declares the native source.azeroth scope and does not borrow another grammar', () =>
    {
        const g = grammar(VSCODE_GRAMMAR);
        expect(g.scopeName).toBe('source.azeroth');
        const includes = (g.patterns as Array<{ include?: string }>).map(p => p.include);
        expect(includes).toContain('#comments');
        expect(includes).toContain('#markup');
        expect(includes).toContain('#statements');
        // It is a standalone grammar: no embedded external scope.
        const json = JSON.stringify(g);
        expect(json).not.toContain('source.tsx');
        expect(json).not.toContain('source.ts');
    });

    it('highlights every built-in control-flow component in the markup grammar', () =>
    {
        const g = grammar(VSCODE_GRAMMAR);
        const element = (g.repository as Record<string, { begin: string; beginCaptures: Record<string, { name: string }> }>)['markup-element'];
        for (const name of BUILTINS)
        {
            expect(element.begin).toContain(name);
        }
        // The built-in alternative is scoped as a support class.
        const scopes = Object.values(element.beginCaptures).map(c => c.name);
        expect(scopes).toContain('support.class.component.azeroth');
    });
});
