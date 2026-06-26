// @vitest-environment node
//
// Go to Implementation: from an interface (or abstract member) to its concrete implementors. A pure
// TypeScript query over the virtual module - this guards that it is wired through the facade and that
// results map back to the original `.azeroth` source, including code authored inside a component body.

import { describe, it, expect } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { AzerothLanguageService } from '../src/index.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tsconfig = path.join(fixtures, 'tsconfig.json');

const SOURCE = [
    'export interface Greeter',          // 0
    '{',                                  // 1
    '    greet(): string;',               // 2
    '}',                                  // 3
    '',                                   // 4
    'export class HelloGreeter implements Greeter', // 5
    '{',                                  // 6
    '    greet(): string { return \'hi\'; }', // 7
    '}',                                  // 8
    '',                                   // 9
    'export default component App',       // 10
    '{',                                  // 11
    '    const greeter: Greeter = new HelloGreeter();', // 12
    '    <div>{ greeter.greet() }</div>', // 13
    '}',                                  // 14
    ''
].join('\n');

function service(): { ls: AzerothLanguageService; uri: string }
{
    const ls = new AzerothLanguageService(fixtures, tsconfig);
    const uri = pathToFileURL(path.join(fixtures, 'App.azeroth')).href;
    ls.didOpen(uri, SOURCE);
    return { ls, uri };
}

describe('go to implementation', () =>
{
    it('resolves an interface to its implementing class', () =>
    {
        const { ls, uri } = service();
        // Caret on `Greeter` in `export interface Greeter`.
        const impls = ls.getImplementation(uri, { line: 0, character: 'export interface '.length + 1 });
        expect(impls.length).toBeGreaterThanOrEqual(1);
        // The implementor is the `HelloGreeter` class on line 5 of this same document.
        expect(impls.some(loc => loc.range.start.line === 5)).toBe(true);
    });

    it('works from a type annotation inside a component body', () =>
    {
        const { ls, uri } = service();
        // Caret on `Greeter` in `    const greeter: Greeter = ...` (line 12, 4-space indent).
        const impls = ls.getImplementation(uri, { line: 12, character: '    const greeter: '.length + 1 });
        expect(impls.some(loc => loc.range.start.line === 5)).toBe(true);
    });
});
