// TypeScript's secondary "declared here" / "expected type comes from" spans ride
// along on a diagnostic as `relatedInformation`. The provider must map every such
// span back into source (the `.azeroth` URI and a sane sub-document range) rather
// than drop it, so the editor can offer a peek to the related location.

import { describe, it, expect, beforeEach } from 'vitest';
import { AzerothLanguageService, pathToUri } from '@azerothjs/language-service';
import path from 'node:path';

const ROOT = process.cwd();

let ls: AzerothLanguageService;

beforeEach(() =>
{
    ls = new AzerothLanguageService(ROOT);
});

describe('diagnostics relatedInformation', () =>
{
    it('maps a use-before-declaration related span into source', () =>
    {
        // `x` is used before its declaration: TypeScript attaches `relatedInformation`
        // ("'x' is declared here") pointing at the `const x = 1;` on the second line.
        const uri = pathToUri(path.join(ROOT, 'Related.azeroth'));
        const src = [
            'const y = x;',
            'const x = 1;'
        ].join('\n');
        ls.didOpen(uri, src);

        const diags = ls.getDiagnostics(uri);
        const withRelated = diags.find(d => d.relatedInformation !== undefined);

        expect(withRelated).toBeTruthy();
        expect(withRelated!.source.startsWith('azeroth')).toBe(true);

        const related = withRelated!.relatedInformation!;
        expect(related.length).toBeGreaterThan(0);

        const info = related[0];
        expect(info.message.length).toBeGreaterThan(0);
        // Mapped back into the user's own document, not the virtual module.
        expect(info.location.uri).toBe(uri);
        // The declaration is on the second line; a sane, non-negative range.
        expect(info.location.range.start.line).toBe(1);
        expect(info.location.range.start.character).toBeGreaterThanOrEqual(0);
        expect(info.location.range.end.character).toBeGreaterThan(info.location.range.start.character);
    });
});
