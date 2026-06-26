// @vitest-environment node
//
// "Without workspace" coverage: an UNTITLED (never-saved) buffer has a pathless URI
// (`untitled:...`). The service must map it to a synthetic in-root `.azeroth` path so the
// virtual module is valid and features work, instead of throwing "source file not found".

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AzerothLanguageService } from '../src/index.ts';

const SRC = `export default component Scratch
{
    state count = 0;
    derived doubled = count * 2;
    <button onClick={() => count++}>{count} -> {doubled}</button>
}
`;

describe('language-service: untitled (no-workspace scratch) buffers', () =>
{
    let dir: string;
    let ls: AzerothLanguageService;
    const uri = 'untitled:Untitled-1';

    beforeAll(() =>
    {
        dir = mkdtempSync(join(tmpdir(), 'az-untitled-'));
        ls = new AzerothLanguageService(dir);
        ls.didOpen(uri, SRC);
    });

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('serves hover on an untitled document (does not throw)', () =>
    {
        const hover = ls.getHover(uri, { line: 3, character: 13 }); // `doubled`
        expect(hover).not.toBeNull();
    });

    it('serves diagnostics (a clean buffer -> none)', () =>
    {
        expect(ls.getDiagnostics(uri)).toHaveLength(0);
    });

    it('serves semantic tokens and completions', () =>
    {
        expect(ls.getSemanticTokens(uri).data.length).toBeGreaterThan(0);
        expect(ls.getCompletions(uri, { line: 4, character: 40 }).length).toBeGreaterThan(0);
    });

    it('reflects edits to the untitled buffer', () =>
    {
        ls.didChange(uri, SRC.replace('count * 2', 'count * 3'));
        expect(ls.getDiagnostics(uri)).toHaveLength(0);
        ls.didClose(uri);
    });
});
