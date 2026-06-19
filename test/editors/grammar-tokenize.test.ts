// Real TextMate tokenization of the native `source.azeroth` grammar, using the
// same engine VS Code runs (vscode-textmate + vscode-oniguruma). The structural
// test (grammar.test.ts) checks the grammar's shape; this checks it actually
// colours the right things - most importantly that element TEXT stays plain
// (a word like `return` between tags must not be coloured as a keyword) while
// script, tags, attributes, and self-closing tags tokenize correctly.

import { describe, it, expect, beforeAll } from 'vitest';
import { Registry, parseRawGrammar, INITIAL, type IGrammar } from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
let grammar: IGrammar;

beforeAll(async () =>
{
    const wasm = readFileSync(path.join(ROOT, 'node_modules/vscode-oniguruma/release/onig.wasm'));
    await oniguruma.loadWASM(wasm.buffer as ArrayBuffer);
    const registry = new Registry({
        onigLib: Promise.resolve({
            createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
            createOnigString: (s) => new oniguruma.OnigString(s)
        }),
        loadGrammar: async (scope) => scope === 'source.azeroth'
            ? parseRawGrammar(readFileSync(path.join(ROOT, 'editors/vscode/syntaxes/azeroth.tmLanguage.json'), 'utf8'), 'azeroth.tmLanguage.json')
            : null
    });
    grammar = (await registry.loadGrammar('source.azeroth'))!;
});

/** The scope string covering the first character of `needle` on its line. */
function scopesAt(code: string, lineText: string, col: number): string
{
    let stack = INITIAL;
    for (const line of code.split('\n'))
    {
        const result = grammar.tokenizeLine(line, stack);
        stack = result.ruleStack;
        if (line === lineText)
        {
            const token = result.tokens.find(t => col >= t.startIndex && col < t.endIndex);
            return token ? token.scopes.slice(1).join(' ') : '';
        }
    }
    return '(line not found)';
}

const SAMPLE = [
    'export default function P() {',
    '    return (',
    '        <div class="a" onClick={fn}>',
    '            return home if for',
    '            <span>{x}</span>',
    '            <img src="y" />',
    '        </div>',
    '    );',
    '}',
    'const after = 5;'
].join('\n');

describe('azeroth grammar tokenization', () =>
{
    it('colours a real script keyword as a keyword', () =>
    {
        expect(scopesAt(SAMPLE, '    return (', 4)).toContain('keyword');
    });

    it('leaves element text PLAIN (a keyword word between tags is not a keyword)', () =>
    {
        // "return home if for" is element content; the `r` of return is col 12.
        const scopes = scopesAt(SAMPLE, '            return home if for', 12);
        expect(scopes).not.toContain('keyword');
        expect(scopes).not.toContain('attribute');
    });

    it('colours a host tag name and its attributes', () =>
    {
        const line = '        <div class="a" onClick={fn}>';
        expect(scopesAt(SAMPLE, line, line.indexOf('div'))).toContain('entity.name.tag');
        expect(scopesAt(SAMPLE, line, line.indexOf('class'))).toContain('attribute-name');
        expect(scopesAt(SAMPLE, line, line.indexOf('onClick'))).toContain('attribute-name.event');
    });

    it('recovers after a self-closing tag (no run-to-end-of-file)', () =>
    {
        // The line AFTER the markup block must tokenize as script again.
        expect(scopesAt(SAMPLE, 'const after = 5;', 0)).toContain('storage.type');
    });

    it('does NOT treat a generic type argument as a tag', () =>
    {
        // `Promise<void>` must not open a `<void>` element (which would swallow
        // the rest of the file). The `<` is an operator, and code after it stays
        // script (the regression the user hit: async/function/return lost colour).
        const code = [
            'async function f(): Promise<void>',
            '{',
            '    return 1;',
            '}'
        ].join('\n');
        const ltCol = 'async function f(): Promise<void>'.indexOf('<');
        expect(scopesAt(code, 'async function f(): Promise<void>', ltCol)).not.toContain('tag');
        // Code on the following lines must still be script.
        expect(scopesAt(code, '    return 1;', 4)).toContain('keyword');
    });

    it('colours primitive type names in annotations', () =>
    {
        const code = 'export default function F(props: { url: string; ok: boolean; n: number }) {}';
        expect(scopesAt(code, code, code.indexOf('string'))).toContain('support.type');
        expect(scopesAt(code, code, code.indexOf('boolean'))).toContain('support.type');
        expect(scopesAt(code, code, code.indexOf('number'))).toContain('support.type');
    });

    it('colours import binding names', () =>
    {
        const code = "import Foo from './a';\nimport { bar, baz as qux } from './b';";
        expect(scopesAt(code, "import Foo from './a';", 'import Foo'.indexOf('Foo'))).toContain('variable');
        const named = "import { bar, baz as qux } from './b';";
        expect(scopesAt(code, named, named.indexOf('bar'))).toContain('variable');
        expect(scopesAt(code, named, named.indexOf('qux'))).toContain('variable');
    });
});
