// The editor contract for `let=` bindings, verified against the REAL language service:
// the bound name must hover with its inferred narrowed type, rename as one symbol
// (declaration and reads together), and resolve go-to-definition onto its declaration.
// These ride the projection's typed-adapter emission - if that regresses, this is the
// spec that says so in editor terms rather than emission terms.
import { describe, it, expect } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { AzerothLanguageService } from '../../src/language-service/index.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tsconfig = path.join(fixtures, 'tsconfig.json');

const SOURCE = [
    'export default component Panel',                                   // 0
    '{',                                                                // 1
    '    state report = null as { n: number } | null;',                 // 2
    '    state done = false;',                                          // 3
    '',                                                                 // 4
    '    <div>',                                                        // 5
    '        <Show when={ done ? report : null } let={ report }>',      // 6  binding at col 51
    '            <p title={ String(report.n) }>{ report.n }</p>',       // 7  reads at col 30 and 44
    '        </Show>',                                                  // 8
    '    </div>',                                                       // 9
    '}',                                                                // 10
    ''
].join('\n');

function openService(): { service: AzerothLanguageService; uri: string }
{
    const service = new AzerothLanguageService(fixtures, tsconfig);
    const uri = pathToFileURL(path.join(fixtures, 'LetPanel.azeroth')).href;
    service.didOpen(uri, SOURCE);
    return { service, uri };
}

describe('let binding editor behavior', () =>
{
    it('hover on a read shows the narrowed inferred type, not any', () =>
    {
        const { service, uri } = openService();
        const hover = service.getHover(uri, { line: 7, character: 31 });
        const text = hover === null ? '' : hover.contents;

        expect(text).toContain('report');
        expect(text).toContain('n: number');
        expect(text).not.toContain('any');
    });

    it('rename from a read covers the declaration and every read', () =>
    {
        const { service, uri } = openService();
        const edit = service.getRenameEdits(uri, { line: 7, character: 31 }, 'entry');
        const ranges = Object.values(edit?.changes ?? {}).flat();

        // The let={ report } declaration plus both reads in line 7.
        expect(ranges.length).toBeGreaterThanOrEqual(3);
        expect(ranges.some((r) => r.range.start.line === 6)).toBe(true);
        expect(ranges.filter((r) => r.range.start.line === 7).length).toBeGreaterThanOrEqual(2);
    });

    it('go-to-definition from a read lands on the let declaration', () =>
    {
        const { service, uri } = openService();
        const defs = service.getDefinition(uri, { line: 7, character: 31 });

        expect(defs.some((d) => d.range.start.line === 6)).toBe(true);
    });

    it('the outer state `report` is untouched by a rename inside the binding', () =>
    {
        const { service, uri } = openService();
        const edit = service.getRenameEdits(uri, { line: 7, character: 31 }, 'entry');
        const ranges = Object.values(edit?.changes ?? {}).flat();

        // Line 2 declares the STATE report; the binding shadows it. Renaming the bound
        // name must not touch the state declaration (the `when` expression on line 6
        // reads the OUTER report and must also survive).
        expect(ranges.some((r) => r.range.start.line === 2)).toBe(false);
    });
});
