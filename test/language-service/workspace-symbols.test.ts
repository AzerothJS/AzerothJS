// Project-wide symbol search across the open documents. getWorkspaceSymbols
// runs TypeScript's navigate-to over every rooted file (open `.azeroth` buffers
// plus any `.ts` they pull in by import) and maps each hit's span back to its
// original source. A declaration whose body straddles markup can't be mapped as
// one contiguous range, so each hit is ranged on its name identifier (which is
// always verbatim): that surfaces script-level exports (a helper function, a
// constant), a real `.ts` export, and default-exported components whose whole
// declaration spans scaffolding. These tests also cover fuzzy prefix matching.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AzerothLanguageService, pathToUri } from '@azerothjs/language-service';
import { writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// A component file that also exports plain script symbols. The component itself
// returns markup (its span straddles scaffolding), but the exported helper and
// constant live entirely in verbatim script, so they map cleanly to source.
const PANEL = [
    'export function panelTitle(open: boolean): string',
    '{',
    '    return open ? \'shown\' : \'hidden\';',
    '}',
    'export default function SidePanel(props: { open: boolean })',
    '{',
    '    return <aside>{panelTitle(props.open)}</aside>;',
    '}'
].join('\n');

const BADGE = [
    'export const BADGE_LABEL = \'ok\';',
    'export default function StatusBadge()',
    '{',
    '    return <span class="badge">{BADGE_LABEL}</span>;',
    '}'
].join('\n');

// A default-exported component whose whole declaration straddles markup
// scaffolding. Ranging on the name span (not the full declaration) is what lets
// it surface in symbol search at all.
const CARD = 'export default function PanelCard(props: { title: string }){ return <div>{props.title}</div>; }';

// A real `.ts` export joins the program only when an open `.azeroth` buffer
// imports it (the editor doesn't root project `.ts` files itself), so the
// fixture is written to disk and pulled in via an import below.
const helperPath = path.join(ROOT, 'ws-symbols-helper.ts');
const HELPER = 'export function describeRealm(name: string): string\n{\n    return `Realm: ${ name }`;\n}\n';

let ls: AzerothLanguageService;
const panelUri = pathToUri(path.join(ROOT, 'SidePanel.azeroth'));
const cardUri = pathToUri(path.join(ROOT, 'PanelCard.azeroth'));
const badgeUri = pathToUri(path.join(ROOT, 'StatusBadge.azeroth'));
const consumerUri = pathToUri(path.join(ROOT, 'WsConsumer.azeroth'));

beforeEach(() =>
{
    writeFileSync(helperPath, HELPER);
    ls = new AzerothLanguageService(ROOT);
    ls.didOpen(panelUri, PANEL);
    ls.didOpen(badgeUri, BADGE);
    ls.didOpen(cardUri, CARD);
    // Importing the helper roots its `.ts` file in the program so its export is
    // visible to navigate-to.
    ls.didOpen(consumerUri, "import { describeRealm } from './ws-symbols-helper.ts';\nconst x = <p>{describeRealm('A')}</p>;");
});

afterEach(() =>
{
    rmSync(helperPath, { force: true });
});

describe('workspace symbols', () =>
{
    it('finds a script export from an .azeroth component with a source uri and range', () =>
    {
        const hits = ls.getWorkspaceSymbols('panelTitle');
        const helper = hits.find(s => s.name === 'panelTitle');
        expect(helper).toBeTruthy();
        expect(helper!.location.uri).toBe(panelUri);
        // The mapped range points at the declaration in the original source.
        const line = PANEL.split('\n')[helper!.location.range.start.line];
        expect(line).toContain('panelTitle');
    });

    it('finds a default-exported component by its name span', () =>
    {
        // The component's whole declaration straddles markup scaffolding, so
        // only the name span maps - the symbol must still surface, ranged on it.
        const hits = ls.getWorkspaceSymbols('PanelCard');
        const card = hits.find(s => s.name === 'PanelCard');
        expect(card).toBeTruthy();
        expect(card!.location.uri).toBe(cardUri);
        const range = card!.location.range;
        const line = CARD.split('\n')[range.start.line];
        expect(line.slice(range.start.character, range.end.character)).toBe('PanelCard');
    });

    it('finds a real .ts export pulled into the program by an import', () =>
    {
        const hits = ls.getWorkspaceSymbols('describeRealm');
        const fn = hits.find(s => s.name === 'describeRealm');
        expect(fn).toBeTruthy();
        expect(fn!.location.uri).toBe(pathToUri(helperPath));
    });

    it('matches a fuzzy prefix across open components', () =>
    {
        // Navigate-to does prefix/fuzzy matching, so a short prefix surfaces the
        // constant export from the badge component without its full name.
        const names = ls.getWorkspaceSymbols('BADGE').map(s => s.name);
        expect(names).toContain('BADGE_LABEL');
    });
});
