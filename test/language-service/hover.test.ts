// Focused tests for the enriched hover provider: built-in component tags get a
// rich markdown card (signature + doc + fenced example), host elements surface
// the HTML dataset description, and plain TypeScript symbols still resolve to
// their inferred type info. Mirrors the language-service.test.ts harness.

import { describe, it, expect, beforeEach } from 'vitest';
import { AzerothLanguageService, LineIndex, pathToUri, type Position } from '@azerothjs/language-service';
import path from 'node:path';

const ROOT = process.cwd();

/** A position located by searching the source for `needle`. */
function at(source: string, needle: string, offsetInNeedle = 0): Position
{
    return new LineIndex(source).positionAt(source.indexOf(needle) + offsetInNeedle);
}

const COUNTER = [
    "import { createSignal } from '@azerothjs/core';",
    'export default function Counter() {',
    '    const [count, setCount] = createSignal(0);',
    '    return <button onClick={() => setCount(count() + 1)}>Count: {count()}</button>;',
    '}'
].join('\n');

let ls: AzerothLanguageService;
const uri = pathToUri(path.join(ROOT, 'Counter.azeroth'));

beforeEach(() =>
{
    ls = new AzerothLanguageService(ROOT);
    ls.didOpen(uri, COUNTER);
});

describe('built-in component hover', () =>
{
    it('renders the Show description and a fenced azeroth example', () =>
    {
        const u = uri.replace('Counter', 'ShowRich');
        const src = 'const x = <Show when={a}><p>hi</p></Show>;';
        ls.didOpen(u, src);
        const hover = ls.getHover(u, at(src, 'Show', 1));
        expect(hover).not.toBeNull();
        expect(hover!.contents).toContain('built-in component');
        // Description paragraph from the language-data entry.
        expect(hover!.contents).toContain('Conditionally renders');
        // A fenced `azeroth` usage example.
        expect(hover!.contents).toContain('```azeroth');
        expect(hover!.contents).toContain('<Show');
    });

    it('maps the hover range onto just the tag name', () =>
    {
        const u = uri.replace('Counter', 'ForRange');
        const src = 'const x = <For each={a} key={k}>{(i) => i}</For>;';
        ls.didOpen(u, src);
        const hover = ls.getHover(u, at(src, 'For', 1));
        expect(hover?.range).toBeDefined();
        const idx = new LineIndex(src);
        const start = idx.offsetAt(hover!.range!.start);
        const end = idx.offsetAt(hover!.range!.end);
        expect(src.slice(start, end)).toBe('For');
    });
});

describe('host element hover', () =>
{
    it('surfaces the HTML dataset description for a host element tag', () =>
    {
        const u = uri.replace('Counter', 'DivHover');
        const src = 'const x = <div></div>;';
        ls.didOpen(u, src);
        const hover = ls.getHover(u, at(src, 'div', 1));
        expect(hover).not.toBeNull();
        expect(hover!.contents.length).toBeGreaterThan(0);
        expect(hover!.contents.toLowerCase()).toContain('div');
    });
});

describe('user component hover', () =>
{
    it('renders the component name and a props table with the optional marker', () =>
    {
        const u = uri.replace('Counter', 'CardUse');
        const src = [
            'function Card(props: { title: string; subtitle?: string })',
            '{',
            '    return <div>{props.title}</div>;',
            '}',
            'export default Card;',
            'const x = <Card title={t} subtitle={s}/>;'
        ].join('\n');
        ls.didOpen(u, src);
        const hover = ls.getHover(u, at(src, '<Card title', '<'.length));
        expect(hover).not.toBeNull();
        expect(hover!.contents).toContain('Card');
        expect(hover!.contents).toContain('title');
        expect(hover!.contents).toContain('subtitle');
        // The optional prop carries the optional marker; the required one does not.
        expect(hover!.contents).toMatch(/subtitle[^\n]*Yes/);
        expect(hover!.contents).toMatch(/title[^\n]*No/);
    });
});

describe('TypeScript symbol hover', () =>
{
    it('still resolves a signal read to its inferred type', () =>
    {
        const hover = ls.getHover(uri, at(COUNTER, 'Count: {count()}', 'Count: {'.length));
        expect(hover).not.toBeNull();
        expect(hover!.contents).toContain('count');
        expect(hover!.contents).toContain('number');
    });
});
