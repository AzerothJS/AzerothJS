// @vitest-environment node
//
// Semantic-token coverage for the reactive surface: the name declared by a reactive keyword
// (`state count`, `form login`, ...) must carry the `reactive` modifier so both editors can colour
// it distinctly from plain variables (VS Code maps `variable.reactive` via semanticTokenScopes;
// JetBrains maps the modifier to AZEROTH_SEM_REACTIVE). The token type stays `variable` so a theme
// without the mapping still colours it sensibly.

import { describe, it, expect } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { AzerothLanguageService, SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS } from '../src/index.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tsconfig = path.join(fixtures, 'tsconfig.json');

const VARIABLE_TYPE = SEMANTIC_TOKEN_TYPES.indexOf('variable');
const REACTIVE_BIT = 1 << SEMANTIC_TOKEN_MODIFIERS.indexOf('reactive');

interface DecodedToken { line: number; character: number; length: number; type: number; modifiers: number }

/** Unpacks LSP's delta-encoded token array into absolute tokens. */
function decode(data: number[]): DecodedToken[]
{
    const tokens: DecodedToken[] = [];
    let line = 0;
    let character = 0;
    for (let i = 0; i + 4 < data.length + 1; i += 5)
    {
        line += data[i] ?? 0;
        character = data[i] === 0 ? character + (data[i + 1] ?? 0) : (data[i + 1] ?? 0);
        tokens.push({ line, character, length: data[i + 2] ?? 0, type: data[i + 3] ?? 0, modifiers: data[i + 4] ?? 0 });
    }
    return tokens;
}

function tokensFor(source: string): { tokens: DecodedToken[]; lines: string[] }
{
    const service = new AzerothLanguageService(fixtures, tsconfig);
    const uri = pathToFileURL(path.join(fixtures, 'Tokens.azeroth')).href;
    service.didOpen(uri, source);
    return { tokens: decode(service.getSemanticTokens(uri).data), lines: source.split('\n') };
}

describe('semantic tokens: reactive declaration names', () =>
{
    const SOURCE = [
        'export default component Counter',
        '{',
        '    state count = 0;',
        '    derived doubled = count() * 2;',
        '    form login = { email: \'\' };',
        '    const plain = 1;',
        '    <p>{doubled()}{plain}</p>',
        '}',
        ''
    ].join('\n');

    function tokenAt(tokens: DecodedToken[], lines: string[], line: number, name: string): DecodedToken | undefined
    {
        const character = lines[line]!.indexOf(name);
        return tokens.find(t => t.line === line && t.character === character && t.length === name.length);
    }

    it('marks state/derived/form declaration names with the reactive modifier', () =>
    {
        const { tokens, lines } = tokensFor(SOURCE);
        for (const [line, name] of [[2, 'count'], [3, 'doubled'], [4, 'login']] as const)
        {
            const token = tokenAt(tokens, lines, line, name);
            expect(token, `no token on '${ name }'`).toBeDefined();
            expect(token!.type).toBe(VARIABLE_TYPE);
            expect(token!.modifiers & REACTIVE_BIT, `'${ name }' missing reactive modifier`).toBe(REACTIVE_BIT);
        }
    });

    it('leaves a plain const WITHOUT the reactive modifier', () =>
    {
        const { tokens, lines } = tokensFor(SOURCE);
        const token = tokenAt(tokens, lines, 5, 'plain');
        expect(token).toBeDefined();
        expect(token!.modifiers & REACTIVE_BIT).toBe(0);
    });
});
