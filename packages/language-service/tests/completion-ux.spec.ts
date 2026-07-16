// @vitest-environment node
//
// Editor-UX guarantees for completion:
//  - a TypeScript symbol commits on `.` (so `user|` + `.` chains into member completion);
//  - an event attribute commits on `=`/space, like a prop;
//  - a COMPONENT's attribute completion is not flooded with the generic DOM-event list (a component
//    only accepts its declared props), while a HOST element still offers events.

import { describe, it, expect } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { AzerothLanguageService } from '../src/index.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tsconfig = path.join(fixtures, 'tsconfig.json');

function completions(source: string, line: number, character: number)
{
    const ls = new AzerothLanguageService(fixtures, tsconfig);
    const uri = pathToFileURL(path.join(fixtures, 'C.azeroth')).href;
    ls.didOpen(uri, source);
    return ls.getCompletions(uri, { line, character });
}

describe('completion UX: commit characters', () =>
{
    it('a TypeScript symbol commits on `.`', () =>
    {
        // `    <p>{ co }</p>` - caret right after `co`, completing the in-scope `count`.
        const src = 'export default component C\n{\n    state count = 0;\n    <p>{ co }</p>\n}\n';
        const sym = completions(src, 3, 11).find(i => i.label === 'count');
        expect(sym, 'expected the in-scope `count` symbol').toBeDefined();
        expect(sym!.commitCharacters).toContain('.');
    });

    it('an event attribute commits on `=`', () =>
    {
        // `    <button >` - caret in attribute position on a host element.
        const onClick = completions('export default component C\n{\n    <button ></button>\n}\n', 2, 12)
            .find(i => i.label === 'onClick');
        expect(onClick, 'expected the onClick event on a host element').toBeDefined();
        expect(onClick!.commitCharacters).toContain('=');
    });
});

describe('completion UX: component attributes are not flooded with DOM events', () =>
{
    it('a host element offers DOM events', () =>
    {
        const labels = completions('export default component C\n{\n    <button ></button>\n}\n', 2, 12).map(i => i.label);
        expect(labels).toContain('onClick');
    });

    it('a component does NOT offer the generic DOM-event list', () =>
    {
        // `<Show >` is a component tag - its attributes are its declared props (when/fallback), never
        // the 43-event `on*` dump that used to bury them.
        const labels = completions('export default component C\n{\n    state n = 0;\n    <Show ></Show>\n}\n', 3, 9).map(i => i.label);
        expect(labels).not.toContain('onClick');
        expect(labels).not.toContain('onPointerMove');
    });
});
