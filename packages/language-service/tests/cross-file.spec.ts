// @vitest-environment node
//
// Cross-file intelligence: a symbol declared in a `.ts` file, used inside a `.azeroth` component, must
// behave exactly as it would between two `.ts` files - completion, type inference, hover,
// go-to-definition (into the `.ts`), find-references (spanning both files), safe cross-file rename, and
// type errors. This is the property that makes `.azeroth` feel like first-class TypeScript, so it is
// guarded directly against an on-disk `helpers.ts` (see fixtures/cross-file/).

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AzerothLanguageService, pathToUri } from '../src/index.ts';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cross-file');
const tsconfig = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tsconfig.json');
// Use the service's own path->URI scheme so location comparisons are apples-to-apples (it normalizes
// the drive letter / encoding differently from Node's pathToFileURL).
const helpersUri = pathToUri(path.join(dir, 'helpers.ts'));

// A component that imports `User`, `defaultUser` and `greet` from the sibling `.ts` module.
const CONSUMER = [
    'import { defaultUser, greet, type User } from \'./helpers\';', // 0
    '',                                                            // 1
    'export default component Consumer',                           // 2
    '{',                                                           // 3
    '    const current: User = defaultUser;',                      // 4
    '    const message: string = greet(current);',                // 5
    '    <div title={ message }>{ defaultUser.name }</div>',       // 6
    '}',                                                           // 7
    ''
].join('\n');

function open(source = CONSUMER): { ls: AzerothLanguageService; uri: string }
{
    const ls = new AzerothLanguageService(dir, tsconfig);
    const uri = pathToUri(path.join(dir, 'Consumer.azeroth'));
    ls.didOpen(uri, source);
    return { ls, uri };
}

describe('cross-file .ts ↔ .azeroth intelligence', () =>
{
    it('infers the imported type for member completion', () =>
    {
        const { ls, uri } = open();
        // Caret right after `defaultUser.` in `{ defaultUser.name }` on line 6.
        const dot = CONSUMER.split('\n')[6].indexOf('defaultUser.') + 'defaultUser.'.length;
        const items = ls.getCompletions(uri, { line: 6, character: dot });
        const labels = items.map(i => i.label);
        expect(labels).toContain('id');
        expect(labels).toContain('name');
    });

    it('hovers an imported function with its real signature', () =>
    {
        const { ls, uri } = open();
        const col = CONSUMER.split('\n')[5].indexOf('greet(') + 1;
        const hover = ls.getHover(uri, { line: 5, character: col });
        expect(hover).not.toBeNull();
        expect(JSON.stringify(hover)).toContain('User');
    });

    it('jumps to definition in the .ts file', () =>
    {
        const { ls, uri } = open();
        const col = CONSUMER.split('\n')[5].indexOf('greet(') + 1;
        const defs = ls.getDefinition(uri, { line: 5, character: col });
        expect(defs.some(d => d.uri === helpersUri)).toBe(true);
    });

    it('finds references spanning both files', () =>
    {
        const { ls, uri } = open();
        const col = CONSUMER.split('\n')[4].indexOf('defaultUser');
        const refs = ls.getReferences(uri, { line: 4, character: col });
        expect(refs.some(r => r.uri === helpersUri)).toBe(true); // the declaration
        expect(refs.some(r => r.uri === uri)).toBe(true);        // the usage in the component
    });

    it('renames safely across the file boundary', () =>
    {
        const { ls, uri } = open();
        const col = CONSUMER.split('\n')[4].indexOf('defaultUser');
        const edit = ls.getRenameEdits(uri, { line: 4, character: col }, 'currentUser');
        expect(edit).not.toBeNull();
        const uris = Object.keys(edit!.changes ?? {});
        expect(uris).toContain(helpersUri); // edits the `.ts` declaration
        expect(uris).toContain(uri);        // and the `.azeroth` usages
    });

    it('reports a cross-file type error when the imported contract is violated', () =>
    {
        // `greet` takes a `User`; passing a number must surface as a diagnostic in the `.azeroth` file.
        const bad = CONSUMER.replace('greet(current)', 'greet(123)');
        const { ls, uri } = open(bad);
        const diags = ls.getDiagnostics(uri);
        expect(diags.length).toBeGreaterThan(0);
    });
});
