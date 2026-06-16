// Document colors: a CSS color literal in a static `style="…"` value or a css``
// template renders a swatch. The service wraps vscode-css-languageservice, so
// these tests assert the normalized RGBA (`#ff0000` -> red 1, green/blue 0) and
// that getColorPresentations offers at least one spelling for a picked color.

import { describe, it, expect, beforeAll } from 'vitest';
import { AzerothLanguageService, pathToUri } from '@azerothjs/language-service';
import path from 'node:path';
import { tmpdir } from 'node:os';

let ls: AzerothLanguageService;
let styleUri: string;
let templateUri: string;

beforeAll(() =>
{
    const dir = tmpdir();
    ls = new AzerothLanguageService(dir);

    styleUri = pathToUri(path.join(dir, 'Styled.azeroth'));
    ls.didOpen(styleUri, 'export default () => <div style="color: #ff0000">hi</div>;');

    templateUri = pathToUri(path.join(dir, 'Scoped.azeroth'));
    ls.didOpen(templateUri, 'const sheet = css`.box { background: #00ff00; }`;\nexport default () => <div>hi</div>;');
});

describe('document colors', () =>
{
    it('finds a color in a static style attribute', () =>
    {
        const colors = ls.getDocumentColors(styleUri);
        expect(colors.length).toBeGreaterThan(0);
        const red = colors[0];
        expect(red.color.red).toBeCloseTo(1);
        expect(red.color.green).toBeCloseTo(0);
        expect(red.color.blue).toBeCloseTo(0);
    });

    it('finds a color in a css`` template', () =>
    {
        const colors = ls.getDocumentColors(templateUri);
        expect(colors.length).toBeGreaterThan(0);
        const green = colors[0];
        expect(green.color.green).toBeCloseTo(1);
        expect(green.color.red).toBeCloseTo(0);
        expect(green.color.blue).toBeCloseTo(0);
    });

    it('offers at least one presentation for a picked color', () =>
    {
        const colors = ls.getDocumentColors(styleUri);
        const info = colors[0];
        const presentations = ls.getColorPresentations(styleUri, info.color, info.range);
        expect(presentations.length).toBeGreaterThan(0);
        expect(presentations.some(p => p.label.length > 0)).toBe(true);
    });
});
