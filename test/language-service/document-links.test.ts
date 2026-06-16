// Document links: a relative import specifier in a `.azeroth` file becomes a
// clickable link to the imported file. Resolution is on-disk (the editor opens a
// real file://), so the fixtures are written to a temp dir: a host importing a
// sibling `.azeroth` component and a `.ts` helper, plus an extensionless import
// that must resolve via the `.ts` probe. The link's range must cover the
// specifier string and its target must end with the resolved file.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AzerothLanguageService, LineIndex, pathToUri } from '@azerothjs/language-service';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dir: string;
let ls: AzerothLanguageService;
let hostUri: string;
let host: string;

beforeAll(() =>
{
    dir = mkdtempSync(path.join(tmpdir(), 'azeroth-links-'));
    writeFileSync(path.join(dir, 'Widget.azeroth'), 'export default function Widget() { return <h2>hi</h2>; }');
    writeFileSync(path.join(dir, 'helper.ts'), 'export const greet = () => \'hi\';');
    host = [
        "import Widget from './Widget.azeroth';",
        "import { greet } from './helper';",
        "import { something } from '@azerothjs/core';",
        'export default function Host()',
        '{',
        '    return <Widget />;',
        '}'
    ].join('\n');
    hostUri = pathToUri(path.join(dir, 'Host.azeroth'));
    ls = new AzerothLanguageService(dir);
    ls.didOpen(hostUri, host);
});

afterAll(() =>
{
    rmSync(dir, { recursive: true, force: true });
});

describe('document links', () =>
{
    it('links a sibling `.azeroth` import to its resolved file', () =>
    {
        const links = ls.getDocumentLinks(hostUri);
        const link = links.find(l => l.target?.endsWith('Widget.azeroth'));
        expect(link).toBeTruthy();
        // The range covers the specifier STRING between the quotes.
        const lineIndex = new LineIndex(host);
        const start = host.indexOf('./Widget.azeroth');
        expect(lineIndex.offsetAt(link!.range.start)).toBe(start);
        expect(lineIndex.offsetAt(link!.range.end)).toBe(start + './Widget.azeroth'.length);
    });

    it('resolves an extensionless `.ts` helper import via the probe', () =>
    {
        const links = ls.getDocumentLinks(hostUri);
        const link = links.find(l => l.target?.endsWith('helper.ts'));
        expect(link).toBeTruthy();
        const lineIndex = new LineIndex(host);
        const start = host.indexOf('./helper');
        expect(lineIndex.offsetAt(link!.range.start)).toBe(start);
        expect(lineIndex.offsetAt(link!.range.end)).toBe(start + './helper'.length);
    });

    it('skips bare module specifiers', () =>
    {
        const links = ls.getDocumentLinks(hostUri);
        expect(links.some(l => l.target?.includes('@azerothjs'))).toBe(false);
        // Only the two relative imports resolve to a target.
        expect(links.filter(l => l.target).length).toBe(2);
    });
});
