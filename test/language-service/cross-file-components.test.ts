// Item 4 audit: editor intelligence that crosses the markup <-> definition and
// file boundaries. Components live in their own `.azeroth`/`.ts` files, so prop
// completion, auto-import, and go-to-definition must all reach across files.
// These open sibling documents in memory (the project resolves `.azeroth`
// imports to their virtual twins, so no on-disk fixtures are needed).

import { describe, it, expect, beforeEach } from 'vitest';
import { AzerothLanguageService, LineIndex, pathToUri, type Position } from '@azerothjs/language-service';
import path from 'node:path';

const ROOT = process.cwd();

function at(source: string, needle: string, offsetInNeedle = 0): Position
{
    return new LineIndex(source).positionAt(source.indexOf(needle) + offsetInNeedle);
}

const WIDGET = [
    'export default function Widget(props: { title: string; count: number })',
    '{',
    '    return <h2 class="widget">{props.title}: {props.count}</h2>;',
    '}'
].join('\n');

let ls: AzerothLanguageService;
const widgetUri = pathToUri(path.join(ROOT, 'Widget.azeroth'));

beforeEach(() =>
{
    ls = new AzerothLanguageService(ROOT);
    ls.didOpen(widgetUri, WIDGET);
});

describe('cross-file component intelligence', () =>
{
    it('completes the props of a component imported from another file', () =>
    {
        const u = pathToUri(path.join(ROOT, 'HostProps.azeroth'));
        const src = "import Widget from './Widget.azeroth';\nconst x = <Widget />;";
        ls.didOpen(u, src);
        // Caret just after `<Widget ` (inside the opening tag, attribute position).
        const labels = ls.getCompletions(u, at(src, '<Widget />', '<Widget '.length)).map(i => i.label);
        expect(labels).toContain('title');
        expect(labels).toContain('count');
    });

    it('auto-imports a component used as a tag with no existing imports', () =>
    {
        const u = pathToUri(path.join(ROOT, 'HostAuto.azeroth'));
        // A complete tag compiles to a `Widget(...)` value call, where TypeScript
        // offers the not-yet-imported symbol with an import code action.
        const src = 'const x = <Widget />;';
        ls.didOpen(u, src);
        const item = ls.getCompletions(u, at(src, '<Widget', '<Widget'.length)).find(i => i.label === 'Widget');
        expect(item).toBeTruthy();
        const resolved = ls.resolveCompletion(u, item!);
        const edits = resolved.additionalTextEdits ?? [];
        // The import must be inserted into the ORIGINAL document (mapped back from
        // the virtual module), even though the file had no imports to anchor to.
        expect(edits.length).toBeGreaterThan(0);
        expect(edits.map(e => e.newText).join('')).toContain('Widget');
    });

    it('go-to-definition on a component tag jumps to its definition file', () =>
    {
        const u = pathToUri(path.join(ROOT, 'HostDef.azeroth'));
        const src = "import Widget from './Widget.azeroth';\nconst x = <Widget />;";
        ls.didOpen(u, src);
        const defs = ls.getDefinition(u, at(src, '<Widget />', 1));
        expect(defs.length).toBeGreaterThan(0);
        expect(defs.some(d => d.uri === widgetUri)).toBe(true);
    });
});
