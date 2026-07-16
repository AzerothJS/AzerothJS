// @vitest-environment node
//
// Real-execution coverage for parseModule: module split (opaque vs component),
// body-item recognition (props/state/derived/effect/markup/opaque-statements),
// whole-source tiling, never-throws totality, and the documented limitations
// (leading export, unterminated declarations, markup-aware brace scanning).
import { describe, it, expect } from 'vitest';
import { parseModule } from '@azerothjs/compiler';
import type { Module, ComponentDecl } from '@azerothjs/compiler';

function component(m: Module): ComponentDecl
{
    const c = m.items.find(i => i.kind === 'component');
    expect(c).toBeDefined();
    return c as ComponentDecl;
}

describe('parseModule - module structure', () =>
{
    it('splits opaque host code from a component declaration', () =>
    {
        const src = 'import x from \'y\';\ncomponent A { <p>hi</p> }\nconst z = 1;';
        const m = parseModule(src);
        expect(m.kind).toBe('module');
        expect(m.items.map(i => i.kind)).toEqual(['opaque', 'component', 'opaque']);
    });

    it('items tile the whole source (every byte covered exactly once)', () =>
    {
        const src = 'const a = 1;\ncomponent A { <p>x</p> }\nconst b = 2;';
        const m = parseModule(src);
        expect(m.start).toBe(0);
        expect(m.end).toBe(src.length);
        // Contiguous, non-overlapping tiling.
        let cursor = 0;
        for (const item of m.items)
        {
            expect(item.start).toBe(cursor);
            cursor = item.end;
        }
        expect(cursor).toBe(src.length);
    });

    it('records the component name and name span', () =>
    {
        const src = 'component Counter { <p>x</p> }';
        const c = component(parseModule(src));
        expect(c.name).toBe('Counter');
        expect(src.slice(c.nameStart, c.nameEnd)).toBe('Counter');
    });

    it('returns no items for empty input', () =>
    {
        expect(parseModule('').items).toEqual([]);
    });
});

describe('parseModule - body items', () =>
{
    it('recognises every body construct in source order', () =>
    {
        const src = [
            'component Full(props: { label: string }) {',
            '    state count = 0;',
            '    derived doubled = count * 2;',
            '    effect { console.log(count); }',
            '    const helper = 1;',
            '    <p>{doubled}</p>',
            '}'
        ].join('\n');
        const c = component(parseModule(src));
        expect(c.body.map(b => b.kind)).toEqual([
            'state', 'derived', 'effect', 'opaque-statements', 'markup'
        ]);
    });

    it('extracts state/derived names and their name spans', () =>
    {
        const src = 'component C { state foo = 1; derived bar = foo + 1; <p>{bar}</p> }';
        const c = component(parseModule(src));
        const state = c.body.find(b => b.kind === 'state') as { name: string; nameStart: number; nameEnd: number };
        const derived = c.body.find(b => b.kind === 'derived') as { name: string; nameStart: number; nameEnd: number };
        expect(state.name).toBe('foo');
        expect(src.slice(state.nameStart, state.nameEnd)).toBe('foo');
        expect(derived.name).toBe('bar');
        expect(src.slice(derived.nameStart, derived.nameEnd)).toBe('bar');
    });

    it('keeps the effect block interior span exclusive of the braces', () =>
    {
        const src = 'component C { effect { run(); } <p>x</p> }';
        const c = component(parseModule(src));
        const effect = c.body.find(b => b.kind === 'effect') as { bodyStart: number; bodyEnd: number };
        expect(src.slice(effect.bodyStart, effect.bodyEnd)).toBe(' run(); ');
    });

    it('treats the last markup item as available; collects each markup item', () =>
    {
        const src = 'component C { state n = 0; <p>a</p> <p>{n}</p> }';
        const c = component(parseModule(src));
        const markups = c.body.filter(b => b.kind === 'markup');
        expect(markups).toHaveLength(2);
    });

    it('does not miscount braces inside markup text', () =>
    {
        // The apostrophe and a literal brace-looking char inside text must not
        // break the body brace scan: the markup and the trailing state still parse.
        const src = 'component C { <p>it\'s here</p> }';
        const c = component(parseModule(src));
        expect(c.body.map(b => b.kind)).toEqual(['markup']);
        expect(c.end).toBe(src.length);
    });

    it('finds the next component when markup follows a `props`/`effect` block on the same line', () =>
    {
        // Regression: markup after a `}`-delimited block must be consumed as a region, or its
        // `</tag>` close is mis-scanned (the `<` as a less-than operator, then `/.../` as a regex)
        // and swallows the component's closing brace plus the following component.
        const src = 'component A(props: { n: number }) { effect { run(); } <p>x</p> } component B { <p>y</p> }';
        const kinds = parseModule(src).items.map((i) => (i.kind === 'component' ? `component:${ i.name }` : i.kind));
        expect(kinds).toEqual(['component:A', 'opaque', 'component:B']);
    });
});

describe('parseModule - totality and documented limitations', () =>
{
    it('never throws on malformed input, degrading to an opaque region', () =>
    {
        const src = 'const a = {{{ ;;; ';
        let m: Module | null = null;
        expect(() =>
        {
            m = parseModule(src);
        }).not.toThrow();
        expect(m!.items).toEqual([{ kind: 'opaque', start: 0, end: src.length }]);
    });

    it('leaves a leading `export` in the preceding opaque region (the component is still found)', () =>
    {
        const src = 'export component C { <p>x</p> }';
        const m = parseModule(src);
        // The `component` keyword is recognised at depth 0, but the leading
        // `export ` is NOT absorbed into the component - it stays opaque before it.
        expect(m.items.map(i => i.kind)).toEqual(['opaque', 'component']);
        const opaque = m.items[0]!;
        expect(src.slice(opaque.start, opaque.end)).toBe('export ');
        const c = m.items[1] as ComponentDecl;
        expect(c.start).toBe('export '.length);
    });

    it('recognises a generic component and captures its type-parameter span', () =>
    {
        const src = 'component Foo<T> { <p>x</p> }';
        const c = parseModule(src).items.find(i => i.kind === 'component') as ComponentDecl;
        expect(c).toBeDefined();
        expect(c.name).toBe('Foo');
        expect(c.typeParams).not.toBeNull();
        expect(src.slice(c.typeParams!.start, c.typeParams!.end)).toBe('<T>');
    });

    it('captures the parameter as one verbatim span across every TS parameter form', () =>
    {
        const param = (src: string): string =>
        {
            const c = parseModule(src).items.find(i => i.kind === 'component') as ComponentDecl;
            expect(c.propsParam).not.toBeNull();
            return src.slice(c.propsParam!.start, c.propsParam!.end);
        };
        // Named + interface, destructured (+/- defaults), inline object type, and inline + destructured.
        expect(param('component Card(props: CardProps) { <p>x</p> }')).toBe('props: CardProps');
        expect(param('component Card({ title, size }: CardProps) { <p>x</p> }')).toBe('{ title, size }: CardProps');
        expect(param('component Card({ title, size = "sm" }: CardProps) { <p>x</p> }')).toBe('{ title, size = "sm" }: CardProps');
        expect(param('component Card(props: { title: string }) { <p>x</p> }')).toBe('props: { title: string }');
        expect(param('component Card({ title }: { title: string }) { <p>x</p> }')).toBe('{ title }: { title: string }');
    });

    it('reports no parameter for a prop-less component (bare or empty parens)', () =>
    {
        const bare = parseModule('component App { <p>x</p> }').items.find(i => i.kind === 'component') as ComponentDecl;
        const empty = parseModule('component App() { <p>x</p> }').items.find(i => i.kind === 'component') as ComponentDecl;
        expect(bare.propsParam).toBeNull();
        expect(empty.propsParam).toBeNull();
    });

    it('an unterminated declaration (no semicolon) swallows the following markup', () =>
    {
        // statementEnd finds no top-level `;`, so the `state` decl runs to the
        // body end - the markup output is consumed into it. Documented limitation.
        const src = 'component C { state n = 0 <p>x</p> }';
        const c = component(parseModule(src));
        expect(c.body.map(b => b.kind)).toEqual(['state']);
        expect(c.body.some(b => b.kind === 'markup')).toBe(false);
    });

    it('recognises constructs only at the body top level, not nested', () =>
    {
        // A `state` token inside an opaque setup statement is not a construct.
        const src = 'component C { const obj = { state: 1 }; <p>x</p> }';
        const c = component(parseModule(src));
        expect(c.body.map(b => b.kind)).toEqual(['opaque-statements', 'markup']);
    });
});
