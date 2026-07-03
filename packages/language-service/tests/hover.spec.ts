// @vitest-environment node
//
// AzerothJS authoring keywords (`component`, `state`, `derived`, `deferred`, `effect`, `watch`,
// and the reactive wrappers) compile away, so TypeScript has no symbol to describe them -
// hovering one used to return nothing. The hover provider supplies their docs from language-data.
// These guard that keyword forms get docs while member accesses / calls fall through to TypeScript.

import { describe, it, expect } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { AzerothLanguageService } from '../src/index.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tsconfig = path.join(fixtures, 'tsconfig.json');

const SOURCE = [
    'export default component Counter',          // 0  `component` at col 15
    '{',                                          // 1
    '    state count = 0 with { name: \'count\' };', // 2  `state` at col 4, `with` at col 20
    '    derived doubled = count() * 2;',         // 3  `derived` at col 4
    '    effect',                                 // 4  `effect` at col 4 (brace on next line)
    '    {',                                       // 5
    '        document.title = String(doubled());',// 6  `document` (a real global) at col 8
    '    }',                                       // 7
    '    <button onClick={() => count(count() + 1)}>{doubled()}</button>', // 8
    '}',                                          // 9
    ''
].join('\n');

function hoverAt(line: number, character: number): string | null
{
    const service = new AzerothLanguageService(fixtures, tsconfig);
    const uri = pathToFileURL(path.join(fixtures, 'Counter.azeroth')).href;
    service.didOpen(uri, SOURCE);
    const hover = service.getHover(uri, { line, character });
    return hover && typeof hover.contents === 'string' ? hover.contents : null;
}

describe('hover: AzerothJS keywords', () =>
{
    it('documents `component`', () => expect(hoverAt(0, 17)).toContain('AzerothJS component'));
    it('documents `state`', () => expect(hoverAt(2, 6)).toContain('reactive state'));
    it('documents `derived`', () => expect(hoverAt(3, 6)).toContain('computed value'));
    it('documents `effect` even with the brace on the next line', () => expect(hoverAt(4, 6)).toContain('reactive side effect'));
    it('documents the `with` clause contextually for its owning keyword (state)', () => expect(hoverAt(2, 22)).toContain('`state` options'));
    it('lists a keyword\'s own `with` options in its hover (state -> equals)', () => expect(hoverAt(2, 6)).toContain('equals'));
    it('includes a `with` usage example in the keyword hover (state)', () => expect(hoverAt(2, 6)).toContain('termsAccepted'));
    it('omits the options section for a keyword that takes none (component)', () => expect(hoverAt(0, 17)).not.toContain('options'));

    it('does NOT treat a real symbol (`document`) as a keyword', () =>
    {
        // `document` is a DOM global, not an Azeroth keyword - hover must be TypeScript's, not a keyword doc.
        const contents = hoverAt(6, 10);
        expect(contents).not.toContain('AzerothJS component');
        expect(contents).not.toContain('reactive state');
    });
});
