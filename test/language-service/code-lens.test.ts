// Code lens: a "N references" annotation over each top-level declaration. The
// first pass places unresolved lenses (cheap - no reference counting); the
// resolve step fills each one's command with its live reference count. A
// component defined in its own `.azeroth` file is imported and used as a tag
// from a sibling, so the declaration has exactly one cross-file reference, which
// the resolved command must report.

import { describe, it, expect, beforeEach } from 'vitest';
import { AzerothLanguageService, LineIndex, pathToUri, type Position } from '@azerothjs/language-service';
import path from 'node:path';

const ROOT = process.cwd();

function at(source: string, needle: string, offsetInNeedle = 0): Position
{
    return new LineIndex(source).positionAt(source.indexOf(needle) + offsetInNeedle);
}

const WIDGET = [
    'export default function Widget(props: { title: string })',
    '{',
    '    return <h2>{props.title}</h2>;',
    '}'
].join('\n');

const HOST = [
    "import Widget from './Widget.azeroth';",
    'export default function Host()',
    '{',
    '    return <Widget title="hi" />;',
    '}'
].join('\n');

let ls: AzerothLanguageService;
const widgetUri = pathToUri(path.join(ROOT, 'Widget.azeroth'));
const hostUri = pathToUri(path.join(ROOT, 'Host.azeroth'));

beforeEach(() =>
{
    ls = new AzerothLanguageService(ROOT);
    ls.didOpen(widgetUri, WIDGET);
    ls.didOpen(hostUri, HOST);
});

describe('code lens', () =>
{
    it('emits an unresolved lens over the component declaration', () =>
    {
        const lenses = ls.getCodeLenses(widgetUri);
        expect(lenses.length).toBeGreaterThan(0);
        // The lens sits on the `Widget` declaration's name line.
        const lens = lenses.find(l => l.range.start.line === at(WIDGET, 'Widget').line);
        expect(lens).toBeTruthy();
        // Unresolved: no command yet, but the data payload routes the resolve.
        expect(lens!.command).toBeUndefined();
        expect((lens!.data as { uri: string }).uri).toBe(widgetUri);
    });

    it('resolves a lens to a command whose title reports the reference count', () =>
    {
        const [lens] = ls.getCodeLenses(widgetUri);
        expect(lens).toBeTruthy();
        const resolved = ls.resolveCodeLens(widgetUri, lens);
        expect(resolved.command).toBeTruthy();
        expect(resolved.command!.title).toMatch(/\d+ reference/);
        expect(resolved.command!.command).toBe('editor.action.showReferences');
    });
});
