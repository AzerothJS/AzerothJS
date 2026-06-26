// @vitest-environment node
//
// Workspace-symbol search ("Go to Symbol in Workspace") must surface the user's own declarations and
// stay fast. It excludes declaration files (lib.dom.d.ts, node_modules `.d.ts`) for two reasons: those
// symbols aren't navigation targets a developer searches for, AND scanning them is a large fixed cost
// that dominates the query (seconds on a real project, independent of project size). This guards both
// halves: the user's component/interface ARE found; a lib-only symbol is NOT.

import { describe, it, expect } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { AzerothLanguageService } from '../src/index.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tsconfig = path.join(fixtures, 'tsconfig.json');

const SOURCE = [
    'export interface WidgetProps',
    '{',
    '    label: string;',
    '}',
    '',
    'export default component Widget(props: WidgetProps)',
    '{',
    '    state widgetCount = 0;',
    '    <button onClick={() => widgetCount = widgetCount + 1}>{props.label}{widgetCount}</button>',
    '}',
    ''
].join('\n');

function service(): AzerothLanguageService
{
    const ls = new AzerothLanguageService(fixtures, tsconfig);
    const uri = pathToFileURL(path.join(fixtures, 'Widget.azeroth')).href;
    ls.didOpen(uri, SOURCE);
    return ls;
}

describe('workspace symbols', () =>
{
    it('finds the user\'s exported component', () =>
    {
        const symbols = service().getWorkspaceSymbols('Widget');
        expect(symbols.some(s => s.name === 'Widget')).toBe(true);
    });

    it('finds the user\'s exported interface', () =>
    {
        const symbols = service().getWorkspaceSymbols('WidgetProps');
        expect(symbols.some(s => s.name === 'WidgetProps')).toBe(true);
    });

    it('excludes declaration-file (lib/dts) symbols', () =>
    {
        // `HTMLElement` exists only in lib.dom.d.ts. With declaration files excluded the search
        // returns no such symbol - before that exclusion this query returned the lib.dom declaration
        // (and dragged the whole lib/node_modules scan into every query).
        const symbols = service().getWorkspaceSymbols('HTMLElement');
        expect(symbols.some(s => s.name === 'HTMLElement')).toBe(false);
    });
});
