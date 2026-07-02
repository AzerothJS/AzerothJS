// @vitest-environment node
//
// Coverage for emitDeclarations: the `.d.ts` produced for an `.azeroth` module must declare its public
// surface so plain TypeScript resolves `.azeroth` imports - the export form (default / named) preserved,
// prop-less components taking no parameter, exported types kept, and non-exported helpers (whose bodies
// may contain `.azeroth` markup) dropped.
import { describe, it, expect } from 'vitest';
import { emitDeclarations, emitDeclarationsWithMap, decodeMappings, encodeMappings } from '@azerothjs/compiler';

/** Emits the declaration text for a module (virtual path; no external imports need resolving). */
function dts(source: string): string
{
    return emitDeclarations(source, '/virtual/mod.azeroth');
}

describe('emitDeclarations', () =>
{
    it('emits a default-export component as a default function with an inferred return type', () =>
    {
        // The return type is inferred from the returned markup (`h()` -> HTMLElement when @azerothjs/core
        // resolves; `any` in this dependency-free unit context). Either way it is a default function decl.
        const out = dts('export default component App { <div>hi</div> }');
        expect(out).toMatch(/export default function App\(props\?: \{\}\): \w+;/);
    });

    it('emits an OPTIONAL parameter for a prop-less component (callable as `App()`)', () =>
    {
        // A prop-less component still declares `props?` so a `.ts` caller can write `App()` (zero args)
        // while a required-prop component is still enforced (its props type has required members).
        const out = dts('export default component App { <div>hi</div> }');
        expect(out).toContain('props?: {}');
    });

    it('emits a named-export component as a named declared function with its props type', () =>
    {
        const out = dts('export component Card(props: { title: string }) { <div>{props.title}</div> }');
        expect(out).toContain('function Card');
        expect(out).toContain('title: string');
        expect(out).not.toContain('export default');
    });

    it('preserves an exported interface referenced by a component prop', () =>
    {
        const out = dts('export interface Foo { x: number }\nexport default component C(props: { foo: Foo }) { <p>x</p> }');
        expect(out).toContain('interface Foo');
        expect(out).toContain('foo: Foo');
    });

    it('carries type parameters from a generic signature-form component', () =>
    {
        const out = dts('export default component List<T>(props: { items: T[] }) { <ul>x</ul> }');
        expect(out).toContain('function List<T>');
        expect(out).toContain('items: T[]');
    });

    it('drops a non-exported helper whose body contains markup (not valid TS)', () =>
    {
        const out = dts('const renderRow = (n: number) => <li>{n}</li>;\nexport default component C { <ul>x</ul> }');
        expect(out).not.toContain('renderRow');
    });

    it('elides an unused value import but keeps a type-only import the surface references', () =>
    {
        const src = 'import { helper } from \'./util\';\nimport type { Item } from \'./types\';\n'
            + 'export default component C(props: { item: Item }) { <p>{helper()}</p> }';
        const out = dts(src);
        expect(out).toContain('Item');           // referenced by the prop type -> kept
        expect(out).not.toContain('helper');     // value used only in (dropped) markup -> elided
    });

    it('emits the exported types of a component-less module', () =>
    {
        // A `.azeroth` that only declares shared types is still a useful import target.
        const out = dts('export type ID = string;\nexport interface Entity { id: ID }');
        expect(out).toContain('export type ID = string');
        expect(out).toContain('interface Entity');
    });

    it('drops a non-exported local from a module (no public surface)', () =>
    {
        // The import makes this module-mode, so the non-exported `x` is not emitted.
        const out = dts('import type { T } from \'./t\';\nconst x: number = 1;');
        expect(out).not.toContain('const x');
    });
});

describe('emitDeclarationsWithMap - declaration map remapped to the .azeroth SOURCE', () =>
{
    it('maps the declared component name onto the `component` declaration in the source', () =>
    {
        // TS's declaration map points into the PROJECTED module; the remap must translate it so an
        // editor following the map (go-to-definition from a `.d.ts`) lands on the REAL declaration.
        const source = 'export default component App { <div>hi</div> }';
        const { dts: text, map } = emitDeclarationsWithMap(source, '/virtual/mod.azeroth');
        expect(text).toContain('export default function App');
        expect(map).not.toBeNull();
        expect(map!.sources).toEqual(['/virtual/mod.azeroth']);

        // Decode and assert at least one segment points AT the component name in the source
        // (line 0, the column of `App`), proving positions are source - not projection - offsets.
        const segments = decodeMappings(map!.mappings).flat();
        expect(segments.length).toBeGreaterThan(0);
        const nameColumn = source.indexOf('App');
        expect(segments.some(s => s.sourceLine === 0 && s.sourceColumn === nameColumn)).toBe(true);
        // And no segment can point past the one-line source text - a projected offset would.
        for (const segment of segments)
        {
            expect(segment.sourceLine).toBe(0);
            expect(segment.sourceColumn).toBeLessThanOrEqual(source.length);
        }
    });

    it('round-trips decodeMappings(encodeMappings(x))', () =>
    {
        const lines = [
            [{ genColumn: 0, sourceLine: 0, sourceColumn: 0 }, { genColumn: 15, sourceLine: 0, sourceColumn: 31 }],
            [],
            [{ genColumn: 4, sourceLine: 2, sourceColumn: 8 }]
        ];
        expect(decodeMappings(encodeMappings(lines))).toEqual(lines);
    });
});
