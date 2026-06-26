// @vitest-environment node
//
// AzerothJS authoring keywords compile away and aren't TypeScript keywords, so TypeScript's
// completion never offers them - typing `sta`/`effe` in a component body surfaced nothing. The
// completion provider contributes them (as snippets) in script position. Guards that, plus the
// scaffold snippet using the CURRENT `component { }` model (the old one emitted legacy `function`).

import { describe, it, expect } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { AzerothLanguageService } from '../src/index.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tsconfig = path.join(fixtures, 'tsconfig.json');

const SOURCE = [
    'export default component Counter',  // 0
    '{',                                  // 1
    '    ',                               // 2  <- caret: component-body (script) position
    '    <div></div>',                    // 3
    '}',                                  // 4
    ''
].join('\n');

function completionsAt(line: number, character: number)
{
    const service = new AzerothLanguageService(fixtures, tsconfig);
    const uri = pathToFileURL(path.join(fixtures, 'Counter.azeroth')).href;
    service.didOpen(uri, SOURCE);
    return service.getCompletions(uri, { line, character });
}

describe('completion: AzerothJS keywords', () =>
{
    const items = completionsAt(2, 4);
    const byLabel = (label: string) => items.find(item => item.label === label);

    it('offers every authoring keyword in component-body position', () =>
    {
        for (const keyword of ['state', 'derived', 'deferred', 'effect', 'component', 'batch', 'untrack', 'cleanup', 'dispose', 'with'])
        {
            expect(byLabel(keyword), `expected a completion for "${ keyword }"`).toBeDefined();
        }
    });

    it('expands `state` to a snippet ranked above TypeScript globals', () =>
    {
        const state = byLabel('state');
        expect(state?.insertTextFormat).toBe(2);          // snippet format
        expect(state?.insertText).toContain('${1:name}');
        expect(state?.sortText?.startsWith('0_')).toBe(true);
    });

    it('scaffolds the current `component { }` syntax (no legacy `function`)', () =>
    {
        const scaffold = byLabel('azeroth-component');
        expect(scaffold?.insertText).toContain('export default component');
        expect(scaffold?.insertText).not.toContain('function');
        // The legacy `createSignal` snippet is gone - the `state` keyword replaces it.
        expect(byLabel('azeroth-signal')).toBeUndefined();
    });
});
