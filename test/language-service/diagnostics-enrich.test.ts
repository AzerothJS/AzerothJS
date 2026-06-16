// Diagnostics enrichment: every diagnostic the service emits is attributable to
// the azeroth toolchain (an `azeroth*` source), a markup syntax error points at
// the offending token rather than the whole document, and a TS diagnostic's
// related locations ("'x' is declared here") are mapped back to source and
// surfaced as `relatedInformation`.

import { describe, it, expect, beforeEach } from 'vitest';
import { AzerothLanguageService, LineIndex, pathToUri } from '@azerothjs/language-service';
import path from 'node:path';

const ROOT = process.cwd();

let ls: AzerothLanguageService;

beforeEach(() =>
{
    ls = new AzerothLanguageService(ROOT);
});

describe('diagnostics enrichment', () =>
{
    it('tags a type error with an azeroth source', () =>
    {
        const uri = pathToUri(path.join(ROOT, 'EnrichType.azeroth'));
        ls.didOpen(uri, 'const n: number = "not a number";');

        const diags = ls.getDiagnostics(uri);
        const typeError = diags.find(d => d.severity === 1);

        expect(typeError).toBeTruthy();
        expect(typeError!.source.startsWith('azeroth')).toBe(true);
    });

    it('surfaces a cross-reference error\'s relatedInformation, mapped to source', () =>
    {
        // `x` is used before its declaration: TypeScript attaches relatedInformation
        // ("'x' is declared here"). The primary diagnostic stays azeroth-tagged and
        // the related location is mapped back into the source document.
        const uri = pathToUri(path.join(ROOT, 'EnrichRelated.azeroth'));
        const src = [
            'const y = x;',
            'const x = 1;'
        ].join('\n');
        ls.didOpen(uri, src);

        const diags = ls.getDiagnostics(uri);
        const crossRef = diags.find(d => d.severity === 1);

        expect(crossRef).toBeTruthy();
        expect(crossRef!.source.startsWith('azeroth')).toBe(true);
        expect(crossRef!.relatedInformation?.length).toBeGreaterThan(0);
        const related = crossRef!.relatedInformation![0];
        expect(related.location.uri).toBe(uri);
        expect(related.location.range.start.line).toBe(1);
        expect(related.message.length).toBeGreaterThan(0);
    });

    it('a markup syntax error has source azeroth and a sub-document range', () =>
    {
        const uri = pathToUri(path.join(ROOT, 'EnrichMarkup.azeroth'));
        const src = 'const x = <a onclick={f}></b>;';
        ls.didOpen(uri, src);

        const diags = ls.getDiagnostics(uri);

        expect(diags).toHaveLength(1);
        const parseError = diags[0];
        expect(parseError.source).toBe('azeroth');
        expect(parseError.severity).toBe(1); // Error

        // The range must point at the offending token, not span the whole document.
        const lineIndex = new LineIndex(src);
        const full = lineIndex.rangeAt(0, src.length);
        const sameStart =
            parseError.range.start.line === full.start.line &&
            parseError.range.start.character === full.start.character;
        const sameEnd =
            parseError.range.end.line === full.end.line &&
            parseError.range.end.character === full.end.character;
        expect(sameStart && sameEnd).toBe(false);
    });
});
