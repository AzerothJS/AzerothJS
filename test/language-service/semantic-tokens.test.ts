// Semantic-token modifiers. The markup provider can't see the TypeScript
// classifications a `.ts` file would (it tokenises tags/attributes), so the one
// modifier it can derive is `defaultLibrary`: a built-in component tag (`Show`,
// `For`, …) is library-provided, a user component or host tag is not. These
// tests pin the modifier mask the encoder emits as each token's 5th int, and
// guard that the type-index half of the legend is unchanged.

import { describe, it, expect, beforeEach } from 'vitest';
import {
    AzerothLanguageService,
    LineIndex,
    pathToUri,
    SEMANTIC_TOKEN_TYPES,
    SEMANTIC_TOKEN_MODIFIERS,
    type Position
} from '@azerothjs/language-service';
import path from 'node:path';

const ROOT = process.cwd();

interface DecodedToken
{
    position: Position;
    length: number;
    type: number;
    modifiers: number;
}

/** Reverses LSP's packed delta encoding into absolute-positioned tokens. */
function decode(data: number[]): DecodedToken[]
{
    const tokens: DecodedToken[] = [];
    let line = 0;
    let character = 0;
    for (let i = 0; i < data.length; i += 5)
    {
        const deltaLine = data[i];
        const deltaChar = data[i + 1];
        line += deltaLine;
        character = deltaLine === 0 ? character + deltaChar : deltaChar;
        tokens.push({
            position: { line, character },
            length: data[i + 2],
            type: data[i + 3],
            modifiers: data[i + 4]
        });
    }
    return tokens;
}

/** The decoded token that begins at `needle` in `source`, or undefined. */
function tokenAt(source: string, data: number[], needle: string): DecodedToken | undefined
{
    const pos = new LineIndex(source).positionAt(source.indexOf(needle));
    return decode(data).find(t => t.position.line === pos.line && t.position.character === pos.character);
}

/** The decoded token that begins at `pos`, or undefined. */
function decodeFind(data: number[], pos: Position): DecodedToken | undefined
{
    return decode(data).find(t => t.position.line === pos.line && t.position.character === pos.character);
}

const DEFAULT_LIBRARY_BIT = 1 << SEMANTIC_TOKEN_MODIFIERS.indexOf('defaultLibrary');

let ls: AzerothLanguageService;

beforeEach(() =>
{
    ls = new AzerothLanguageService(ROOT);
});

describe('semantic-token modifiers', () =>
{
    it('marks a built-in component tag with the defaultLibrary modifier', () =>
    {
        const source = 'const x = <Show when={true}>ok</Show>;';
        const uri = pathToUri(path.join(ROOT, 'ShowTag.azeroth'));
        ls.didOpen(uri, source);

        const token = tokenAt(source, ls.getSemanticTokens(uri).data, 'Show');
        expect(token).toBeDefined();
        expect(token!.modifiers & DEFAULT_LIBRARY_BIT).toBe(DEFAULT_LIBRARY_BIT);
    });

    it('leaves a user component and a host tag with no modifiers', () =>
    {
        const source = 'const x = <Counter><span>hi</span></Counter>;';
        const uri = pathToUri(path.join(ROOT, 'PlainTags.azeroth'));
        ls.didOpen(uri, source);
        const data = ls.getSemanticTokens(uri).data;

        expect(tokenAt(source, data, 'Counter')!.modifiers).toBe(0);
        expect(tokenAt(source, data, 'span')!.modifiers).toBe(0);
    });

    it('keeps the type index of an existing case stable (component = 0)', () =>
    {
        const source = 'const x = <Show>ok</Show>;';
        const uri = pathToUri(path.join(ROOT, 'TypeIndex.azeroth'));
        ls.didOpen(uri, source);

        const token = tokenAt(source, ls.getSemanticTokens(uri).data, 'Show');
        expect(token).toBeDefined();
        expect(token!.type).toBe(SEMANTIC_TOKEN_TYPES.indexOf('component'));
        expect(SEMANTIC_TOKEN_TYPES.indexOf('component')).toBe(0);
    });
});

const DECLARATION_BIT = 1 << SEMANTIC_TOKEN_MODIFIERS.indexOf('declaration');

describe('semantic-token script classification', () =>
{
    // A file with script, a function, and a markup hole reading a script binding.
    const source = 'const count = 0;\nfunction inc(){ return count + 1; }\nconst el = <div>{count}</div>;';

    function tokens(): { source: string; data: number[] }
    {
        const uri = pathToUri(path.join(ROOT, 'Script.azeroth'));
        ls.didOpen(uri, source);
        return { source, data: ls.getSemanticTokens(uri).data };
    }

    it('classifies a function declaration in the script region', () =>
    {
        const { data } = tokens();
        const token = tokenAt(source, data, 'inc');
        expect(token).toBeDefined();
        expect(token!.type).toBe(SEMANTIC_TOKEN_TYPES.indexOf('function'));
        expect(token!.modifiers & DECLARATION_BIT).toBe(DECLARATION_BIT);
    });

    it('classifies a variable reference inside a function body', () =>
    {
        const { data } = tokens();
        // The `count` read inside `return count + 1` (after the function body opens).
        const at = source.indexOf('count', source.indexOf('return'));
        const pos = new LineIndex(source).positionAt(at);
        const token = decodeFind(data, pos);
        expect(token).toBeDefined();
        expect(token!.type).toBe(SEMANTIC_TOKEN_TYPES.indexOf('variable'));
    });

    it('keeps the markup tag token unchanged when TS tokens are merged', () =>
    {
        const { data } = tokens();
        const token = tokenAt(source, data, 'div');
        expect(token).toBeDefined();
        expect(token!.type).toBe(SEMANTIC_TOKEN_TYPES.indexOf('tag'));
        expect(token!.length).toBe(3);
        expect(token!.modifiers).toBe(0);
    });
});
