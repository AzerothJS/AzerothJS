// CSS intelligence for the reactive styleMap({ ... }) helper: its object keys
// complete and hover as CSS property names (camelCase), its string values
// complete as CSS values, and color values render swatches - all via the shared
// CSS engine, so VS Code and JetBrains behave identically.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AzerothLanguageService, pathToUri } from '@azerothjs/language-service';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

let dir: string;
let ls: AzerothLanguageService;
let uri: string;

/** Loads `source` (with a `|` caret) and returns the caret position. */
function open(source: string): { position: { line: number; character: number } }
{
    const offset = source.indexOf('|');
    const clean = source.slice(0, offset) + source.slice(offset + 1);
    ls.didChange(uri, clean);
    const before = clean.slice(0, offset);
    return { position: { line: before.split('\n').length - 1, character: offset - (before.lastIndexOf('\n') + 1) } };
}

beforeAll(() =>
{
    // Isolated workspace root: the service scans its root for `.azeroth` files on
    // construction, so a bare `tmpdir()` would index every stray file there.
    dir = fs.mkdtempSync(path.join(tmpdir(), 'azeroth-style-'));
    ls = new AzerothLanguageService(dir);
    uri = pathToUri(path.join(dir, 'StyleMap.azeroth'));
    ls.didOpen(uri, 'export default () => <div></div>;');
});

afterAll(() =>
{
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('styleMap key completion', () =>
{
    it('suggests CSS property names in camelCase', () =>
    {
        const { position } = open('export default () => <div style={styleMap({ |})}></div>;');
        const labels = ls.getCompletions(uri, position).map(item => item.label);
        expect(labels).toContain('fontWeight');
        expect(labels).toContain('backgroundColor');
        expect(labels).not.toContain('font-weight');
    });

    it('still suggests properties for a later entry', () =>
    {
        const { position } = open('export default () => <div style={styleMap({ color: \'red\', back| })}></div>;');
        const labels = ls.getCompletions(uri, position).map(item => item.label);
        expect(labels).toContain('backgroundColor');
    });

    it('still detects the object when an earlier value contains a paren', () =>
    {
        // A `)` inside a value string must not desync styleMap call detection.
        const { position } = open('export default () => <div style={styleMap({ content: \')\', back| })}></div>;');
        const labels = ls.getCompletions(uri, position).map(item => item.label);
        expect(labels).toContain('backgroundColor');
    });

    it('does not fire outside a styleMap object', () =>
    {
        const { position } = open('export default () => { const x = { fo| }; return <div></div>; };');
        const labels = ls.getCompletions(uri, position).map(item => item.label);
        expect(labels).not.toContain('fontWeight');
    });
});

describe('styleMap value completion', () =>
{
    it('suggests CSS values inside a value string', () =>
    {
        const { position } = open('export default () => <div style={styleMap({ display: \'|\' })}></div>;');
        const labels = ls.getCompletions(uri, position).map(item => item.label);
        expect(labels).toContain('flex');
        expect(labels).toContain('block');
    });

    it('suggests CSS values for a quoted kebab-case key', () =>
    {
        const { position } = open('export default () => <div style={styleMap({ \'font-weight\': \'|\' })}></div>;');
        const labels = ls.getCompletions(uri, position).map(item => item.label);
        expect(labels).toContain('bold');
    });

    it('does not crash or mis-complete for a computed key', () =>
    {
        const { position } = open('export default () => <div style={styleMap({ [dynamicKey]: \'|\' })}></div>;');
        // A computed key is not a CSS property; value completion bails (no CSS values).
        const labels = ls.getCompletions(uri, position).map(item => item.label);
        expect(labels).not.toContain('flex');
    });
});

describe('styleMap key hover', () =>
{
    it('shows CSS property documentation for a key', () =>
    {
        const { position } = open('export default () => <div style={styleMap({ fontWei|ght: \'bold\' })}></div>;');
        const hover = ls.getHover(uri, position);
        expect(hover).not.toBeNull();
        expect(hover!.contents.toLowerCase()).toContain('font');
    });
});

describe('styleMap colors', () =>
{
    it('renders a swatch for a string color value', () =>
    {
        ls.didChange(uri, 'export default () => <div style={styleMap({ color: \'#00ff00\' })}></div>;');
        const colors = ls.getDocumentColors(uri);
        expect(colors.length).toBeGreaterThan(0);
        expect(colors[0].color.green).toBeCloseTo(1);
        expect(colors[0].color.red).toBeCloseTo(0);
    });

    it('leaves non-color string values alone', () =>
    {
        ls.didChange(uri, 'export default () => <div style={styleMap({ fontWeight: \'bold\' })}></div>;');
        expect(ls.getDocumentColors(uri).length).toBe(0);
    });
});
