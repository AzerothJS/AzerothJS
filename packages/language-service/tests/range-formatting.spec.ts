// @vitest-environment node
//
// Range formatting (Format Selection) runs TypeScript's formatter over just the selected range, then
// keeps only the edits that map back to user-authored script/expression spans - so a messy block of
// script is tidied while the markup the selection straddles is left alone. Guards that a messy script
// selection produces edits, and that a markup-only selection produces none.

import { describe, it, expect } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { AzerothLanguageService } from '../src/index.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tsconfig = path.join(fixtures, 'tsconfig.json');

const SOURCE = [
    'export default component App',  // 0
    '{',                              // 1
    '    const    x=1;',              // 2  messy
    '    const    y =2;',             // 3  messy
    '    <div>{ x + y }</div>',       // 4  markup
    '}',                              // 5
    ''
].join('\n');

function service(): { ls: AzerothLanguageService; uri: string }
{
    const ls = new AzerothLanguageService(fixtures, tsconfig);
    const uri = pathToFileURL(path.join(fixtures, 'App.azeroth')).href;
    ls.didOpen(uri, SOURCE);
    return { ls, uri };
}

describe('range formatting', () =>
{
    it('produces edits for a messy script selection', () =>
    {
        const { ls, uri } = service();
        const edits = ls.getRangeFormattingEdits(uri, {
            start: { line: 2, character: 0 },
            end: { line: 3, character: 18 }
        });
        expect(edits.length).toBeGreaterThan(0);
        // Every edit lands on the selected script lines, never the markup line below.
        expect(edits.every(e => e.range.start.line <= 3)).toBe(true);
    });

    it('leaves a markup-only selection untouched', () =>
    {
        const { ls, uri } = service();
        const edits = ls.getRangeFormattingEdits(uri, {
            start: { line: 4, character: 4 },
            end: { line: 4, character: 9 }
        });
        expect(edits.length).toBe(0);
    });
});
