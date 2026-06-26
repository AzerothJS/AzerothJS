// @vitest-environment node
//
// Stale-state guard. Under a storm of rapid edits the service must always answer against the LATEST
// content - never a result computed from a prior version left behind in a cache. We alternate a broken
// handler and a valid one many times (the diagnostic the editor path reliably surfaces) and assert the
// diagnostics flip every time, and that the projected virtual code reflects an edit immediately.

import { describe, it, expect } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { AzerothLanguageService } from '../src/index.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tsconfig = path.join(fixtures, 'tsconfig.json');

const BAD = 'export default component C\n{\n    state n = 0;\n    <button onClick={n}>x</button>\n}\n';
const GOOD = 'export default component C\n{\n    state n = 0;\n    <button onClick={() => { n = n + 1; }}>x</button>\n}\n';

function open(): { ls: AzerothLanguageService; uri: string }
{
    const ls = new AzerothLanguageService(fixtures, tsconfig);
    const uri = pathToFileURL(path.join(fixtures, 'C.azeroth')).href;
    ls.didOpen(uri, GOOD);
    return { ls, uri };
}

describe('incremental consistency under edit storms', () =>
{
    it('never serves stale diagnostics across rapid broken/valid edits', () =>
    {
        const { ls, uri } = open();
        // 20 flips is plenty to expose a stale cache; kept modest so the storm stays well under the
        // timeout even under full-suite CPU contention (each edit forces a real incremental check).
        for (let i = 0; i < 20; i++)
        {
            ls.didChange(uri, BAD);
            expect(ls.getDiagnostics(uri).some(d => d.code === 1360), `broken edit ${ i }`).toBe(true);
            ls.didChange(uri, GOOD);
            expect(ls.getDiagnostics(uri).some(d => d.code === 1360), `valid edit ${ i }`).toBe(false);
        }
    }, 20000); // generous timeout: a real type-check storm, not flaky under CI contention

    it('reflects the latest content in the projection immediately after an edit', () =>
    {
        const { ls, uri } = open();
        ls.didChange(uri, GOOD.replace('state n =', 'state renamedSignal ='));
        // The edit changed the symbol; querying right away must see the new name, not the old.
        const virtual = ls.getVirtualCode(uri);
        expect(virtual).toContain('renamedSignal');
        expect(virtual).not.toMatch(/\blet n\b/);
    });

    it('interleaves diagnostics, completion and hover without drift', () =>
    {
        const { ls, uri } = open();
        // A storm that mixes read-only queries between content swaps; the final state must be clean.
        for (let i = 0; i < 14; i++)
        {
            ls.didChange(uri, i % 2 === 0 ? BAD : GOOD);
            ls.getCompletions(uri, { line: 2, character: 8 });
            ls.getHover(uri, { line: 2, character: 10 });
            ls.getDiagnostics(uri);
        }
        ls.didChange(uri, GOOD);
        expect(ls.getDiagnostics(uri).some(d => d.code === 1360)).toBe(false);
    }, 20000);
});
