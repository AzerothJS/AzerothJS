// @vitest-environment node
//
// The editor's view of a `style { ... }` section.
//
// Before the section existed, this exact text reached the virtual TypeScript verbatim and the
// author was told `Cannot find name 'red'` about their own stylesheet - the language service
// confidently reporting on a language it was not looking at. The section projects to nothing,
// so no mapping covers it, and every provider's rule for an unmapped region is already "drop
// it". These tests hold the two halves of that: TypeScript says nothing inside the section, and
// the CSS engine says the right things.

import { describe, it, expect, afterAll } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AzerothLanguageService } from '../../src/language-service/index.ts';
import { StyleIndex } from '../../src/language-service/style-index.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tsconfig = path.join(fixtures, 'tsconfig.json');

const SOURCE = [
    'style',                            // 0
    '{',                                // 1
    '    .card { color: red; }',        // 2
    '    .card:hover { padding: 0 }',   // 3
    '}',                                // 4
    '',                                 // 5
    'export default component Card',    // 6
    '{',                                // 7
    '    <article class="card">x</article>', // 8
    '}',                                // 9
    ''
].join('\n');

const workspaces: string[] = [];
afterAll(() =>
{
    for (const dir of workspaces)
    {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A fresh service with the module open, so no cross-test state can mask a failure. */
function open(source = SOURCE): { service: AzerothLanguageService; uri: string }
{
    const service = new AzerothLanguageService(fixtures, tsconfig);
    const uri = pathToFileURL(path.join(fixtures, 'Card.azeroth')).href;
    service.didOpen(uri, source);
    return { service, uri };
}

describe('a style section in the editor', () =>
{
    it('produces no diagnostic anywhere inside it', () =>
    {
        const { service, uri } = open();
        const inside = service.getDiagnostics(uri).filter((d) => d.range.start.line >= 1 && d.range.start.line <= 4);

        expect(inside, `TypeScript must not report on CSS: ${ JSON.stringify(inside) }`).toEqual([]);
    });

    it('completes CSS properties inside a rule, not TypeScript identifiers', () =>
    {
        const { service, uri } = open();
        // Caret after `color: ` on the `.card` rule.
        const items = service.getCompletions(uri, { line: 2, character: 18 });

        expect(items.length).toBeGreaterThan(0);
        expect(items.some((item) => item.label === 'red' || item.label === 'rgb()')).toBe(true);
        // A TypeScript keyword here would mean the caret was classified as script.
        expect(items.some((item) => item.label === 'state')).toBe(false);
    });

    it('hovers a CSS property with its CSS documentation', () =>
    {
        const { service, uri } = open();
        const hover = service.getHover(uri, { line: 2, character: 13 });

        expect(hover).toBeTruthy();
        expect(String(hover?.contents).toLowerCase()).toContain('color');
    });

    it('hovers the `style` keyword itself with the section\'s documentation', () =>
    {
        const { service, uri } = open();
        const hover = service.getHover(uri, { line: 0, character: 2 });

        expect(String(hover?.contents)).toContain('scoped stylesheet');
    });

    it('is indexed as a class DEFINITION site, so `class="..."` can complete against it', () =>
    {
        // The index is what class completion, hover and go-to-definition all read. Before the
        // section, a file whose classes lived in one was invisible to every one of them.
        const dir = mkdtempSync(path.join(tmpdir(), 'az-style-'));
        workspaces.push(dir);
        writeFileSync(path.join(dir, 'Card.azeroth'), SOURCE, 'utf8');

        const defs = new StyleIndex(dir).byName('card');

        expect(defs.length).toBeGreaterThan(0);
        expect(defs[0]?.file.endsWith('Card.azeroth')).toBe(true);
        expect(defs[0]?.rule).toContain('color: red');
    });

    it('shows a colour swatch for a colour in the section', () =>
    {
        const { service, uri } = open();
        const colours = service.getDocumentColors(uri);

        expect(colours.some((colour) => colour.range.start.line === 2)).toBe(true);
    });

    it('says nothing about a `style` that is not a section', () =>
    {
        const { service, uri } = open(
            'const style = { pad: 1 };\n\nexport default component C\n{\n    <p style="color: red">{ style.pad }</p>\n}\n'
        );

        expect(service.getDiagnostics(uri).filter((d) => d.severity === 1)).toEqual([]);
    });
});
