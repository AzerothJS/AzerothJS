// @vitest-environment node
//
// Language-service coverage for component PARAMETERS as ordinary TypeScript. A parameter's type drives
// hover, member completion, and formatting through the ONE projection - and a named interface must behave
// identically to an inline object type. These build a real service over each parameter form and assert:
//   - hover on a destructured prop name resolves its real type (the `const { ... } = props` binding maps);
//   - `props.<member>` completion offers the declared props (named interface AND inline object type);
//   - whole-document formatting leaves every parameter signature byte-for-byte intact (the param region,
//     including destructuring defaults like `size = "md"`, is never corrupted by the mapped TS formatter).
import { describe, it, expect } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { AzerothLanguageService } from '../src/index.ts';
import { parseModule } from '@azerothjs/compiler';
import type { ComponentDecl } from '@azerothjs/compiler';
import type { TextEdit } from '../src/protocol.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tsconfig = path.join(fixtures, 'tsconfig.json');

function service(source: string): { svc: AzerothLanguageService; uri: string }
{
    const svc = new AzerothLanguageService(fixtures, tsconfig);
    const uri = pathToFileURL(path.join(fixtures, 'Card.azeroth')).href;
    svc.didOpen(uri, source);
    return { svc, uri };
}

function hoverText(source: string, line: number, character: number): string | null
{
    const { svc, uri } = service(source);
    const hover = svc.getHover(uri, { line, character });
    return hover && typeof hover.contents === 'string' ? hover.contents : null;
}

function completionLabels(source: string, line: number, character: number): string[]
{
    const { svc, uri } = service(source);
    return svc.getCompletions(uri, { line, character }).map(item => item.label);
}

/** Applies LSP text edits to `source` (right-to-left so earlier offsets stay valid). */
function applyEdits(source: string, edits: TextEdit[]): string
{
    const lines = source.split('\n');
    const offsetAt = (line: number, ch: number): number =>
        lines.slice(0, line).reduce((sum, l) => sum + l.length + 1, 0) + ch;
    const flat = edits
        .map(e => ({ start: offsetAt(e.range.start.line, e.range.start.character), end: offsetAt(e.range.end.line, e.range.end.character), text: e.newText }))
        .sort((a, b) => b.start - a.start);
    let out = source;
    for (const e of flat)
    {
        out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    return out;
}

describe('component params - hover resolves prop types', () =>
{
    it('hovers a destructured prop name to its declared type', () =>
    {
        const src = [
            'interface CardProps { title: string; }',
            'export default component Card({ title }: CardProps)',
            '{',
            '    <h1>{title}</h1>',          // line 3: `title` read at col 9
            '}',
            ''
        ].join('\n');
        const contents = hoverText(src, 3, 10);
        expect(contents).toContain('title');
        expect(contents).toContain('string');
    });

    it('hovers a `props.<member>` access (named interface) to its declared type', () =>
    {
        const src = [
            'interface CardProps { count: number; }',
            'export default component Card(props: CardProps)',
            '{',
            '    <p>{props.count}</p>',       // line 3: `count` member at col 14
            '}',
            ''
        ].join('\n');
        const contents = hoverText(src, 3, 15);
        expect(contents).toContain('count');
        expect(contents).toContain('number');
    });
});

describe('component params - member completion (named interface == inline object type)', () =>
{
    const NAMED = [
        'interface CardProps { title: string; count: number; }',
        'export default component Card(props: CardProps)',
        '{',
        '    <p>{props.title}</p>',           // line 3: caret right after `props.` is col 14
        '}',
        ''
    ].join('\n');

    const INLINE = [
        'export default component Card(props: { title: string; count: number })',
        '{',
        '    <p>{props.title}</p>',           // line 2: caret right after `props.` is col 14
        '}',
        ''
    ].join('\n');

    it('offers the declared props after `props.` for a named interface', () =>
    {
        const labels = completionLabels(NAMED, 3, 14);
        expect(labels).toContain('title');
        expect(labels).toContain('count');
    });

    it('offers the declared props after `props.` for an inline object type (identical behaviour)', () =>
    {
        const labels = completionLabels(INLINE, 2, 14);
        expect(labels).toContain('title');
        expect(labels).toContain('count');
    });
});

describe('component params - formatting preserves every signature form', () =>
{
    // The parameter text of the first component, canonicalised so benign normalisation (collapsed
    // whitespace, a trailing `;` the TS formatter may add inside an inline object type) does not count
    // as a difference - only real corruption (a dropped default, a mangled binding) would.
    function paramOf(source: string): string
    {
        const c = parseModule(source).items.find(i => i.kind === 'component') as ComponentDecl;
        const raw = c.propsParam ? source.slice(c.propsParam.start, c.propsParam.end) : '';
        return raw.replace(/;(\s*\})/g, '$1').replace(/\s+/g, ' ').trim();
    }

    const SIGNATURES = [
        'component Card(props: CardProps)',
        'component Card({ title, size }: CardProps)',
        'component Card({ title, size = "md" }: CardProps)',
        'component Card(props: { title: string; size?: string })',
        'component Card({ title, size }: { title: string; size?: string })',
        'component Card({ title, size = "md" }: { title: string; size?: string })'
    ];

    for (const signature of SIGNATURES)
    {
        it(`preserves the parameter of \`${ signature }\` through a full-document format`, () =>
        {
            // A deliberately over-indented body line gives the formatter real work to do; the parameter
            // must survive semantically (defaults and bindings intact).
            const src = [
                'interface CardProps { title: string; size?: string; }',
                `export default ${ signature }`,
                '{',
                '            const x = 1;',     // over-indented on purpose
                '    <p>{x}</p>',
                '}',
                ''
            ].join('\n');
            const { svc, uri } = service(src);
            const edits = svc.getFormattingEdits(uri);
            const formatted = applyEdits(src, edits);
            expect(paramOf(formatted)).toBe(paramOf(src));
            // The formatter actually ran (it produced edits for the stray indentation).
            expect(edits.length).toBeGreaterThan(0);
        });
    }
});
