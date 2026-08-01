// @vitest-environment node
//
// Coverage for the SINGLE Azeroth -> TypeScript projection (generateVirtualCode), the one lowering every
// tool (type checker, language service, TS plugin, declaration emitter, azeroth-tsc) consumes. Asserts
// the projected shape of each component-body construct, the component call/signature contract, and the
// four subtle correctness rules the projection enforces:
// - state with a type annotation is cast (`= (init as T)`) so reads aren't flow-narrowed to the init;
// - effect/wrapper bodies are arrows (`void (() => ...)`) so a `return` does not leak into the component;
// - props is a DEFAULTED parameter (optional for callers, typed `P` in the body);
// - a render-callback child is passed bare to `__azRender`, an IIFE child is wrapped.
import { describe, it, expect } from 'vitest';
import { generateVirtualCode, CompileError } from '@azerothjs/compiler';

/** The projected TypeScript for an `.azeroth` source. */
function code(src: string): string
{
    return generateVirtualCode(src).code;
}

describe('generateVirtualCode - component signature', () =>
{
    it('projects a component to a function with a DEFAULTED props parameter', () =>
    {
        const out = code('export default component Card(props: { title: string }) { <div>{props.title}</div> }');
        // Defaulted param: optional for `.ts` callers (App()), still typed in the body.
        expect(out).toContain('function Card(props: {');
        expect(out).toContain('title: string');
        expect(out).toContain('= (undefined as unknown as');
    });

    it('carries the leading export form (default) onto the projected function', () =>
    {
        expect(code('export default component App { <p>x</p> }')).toContain('export default function App(');
    });

    it('returns the rendered markup so the inferred return type is HTMLElement', () =>
    {
        expect(code('component C { <div>hi</div> }')).toContain('return (h(');
    });
});

describe('generateVirtualCode - reactive body keywords', () =>
{
    it('casts a TYPED state initializer to its declared type (no flow-narrowing)', () =>
    {
        const out = code('component C { state x: number | null = null; <p>x</p> }');
        expect(out).toContain('let x: number | null = (null as number | null)');
    });

    it('projects an UNTYPED state as a plain let (no cast)', () =>
    {
        const out = code('component C { state n = 0; <p>x</p> }');
        expect(out).toMatch(/let n = 0;/);
        expect(out).not.toContain('0 as');
    });

    it('projects derived and deferred as const', () =>
    {
        const out = code('component C { state n = 0; derived d = n + 1; deferred f = n * 2; <p>{d}{f}</p> }');
        expect(out).toContain('const d = n + 1');
        expect(out).toContain('const f = n * 2');
    });

    it('projects a destructured-prop signature with a `const { ... } = props` binding for typing', () =>
    {
        const out = code('component Card({ title, size = "sm" }: CardProps) { <p>{title}</p> }');
        expect(out).toContain('(props: CardProps');
        expect(out).toContain('const { title, size = "sm" } = props;');
    });

    it('wraps an effect body in an arrow so a `return` cannot leak into the component', () =>
    {
        const out = code('component C { state n = 0; effect { if (n < 0) { return; } } <p>x</p> }');
        expect(out).toContain('void (() => {');
        // Not a bare block - a bare `;{ ... return; }` would make the component return `... | undefined`.
        expect(out).not.toMatch(/;\{\s*if \(n < 0\)/);
    });

    it('projects effect (deps) as on([getters], (params) => { body })', () =>
    {
        const out = code('component C { state n = 0; effect (n) (v) { console.log(v); } <p>x</p> }');
        expect(out).toContain('on([');
        expect(out).toContain('() => (n)');
        expect(out).toContain('(v) => {');
    });

    it('handles a NESTED keyword (cleanup inside an effect) - no keyword leaks', () =>
    {
        const out = code('component C { effect { const off = () => {}; cleanup { off(); } } <p>x</p> }');
        expect(out).not.toMatch(/\bcleanup\s*\{/);
        expect(out).toContain('off()');
    });
});

describe('generateVirtualCode - markup', () =>
{
    it('always calls a component as Comp({ ... }) (never Comp()), so missing props are checked', () =>
    {
        const out = code('component App { <Card /> }');
        expect(out).toMatch(/Card\(\{\s*\}\)/);
        expect(out).not.toMatch(/Card\(\)/);
    });

    it('satisfies-checks a host event handler', () =>
    {
        const out = code('component C { <button onClick={(e) => e.preventDefault()}>x</button> }');
        expect(out).toContain("satisfies AzerothHandler<'onClick'>");
    });

    it('passes a render-callback child as the typed children: prop, but WRAPS a markup/IIFE child in __azRender', () =>
    {
        // A render callback becomes the real `children:` prop so its params infer from the component
        // signature. For's rows go through the __azRow adapter: the runtime children receives getters,
        // markup reads values - the adapter keeps the author arrow value-typed.
        const renderChild = code('component C { state items: number[] = []; <ul><For each={items}>{(item) => <li>{item}</li>}</For></ul> }');
        expect(renderChild).toContain('children: __azRow(items, (item) =>');
        expect(renderChild).not.toContain('__azRender');

        // A non-callback child (IIFE / markup thunk) still goes through the type-neutral __azRender.
        const iife = code('component C { state on = true; <ul><Show when={on}>{(() => <p>x</p>)()}</Show></ul> }');
        expect(iife).toContain('__azRender(() => (');
    });

    it('satisfies a component children prop with the any-typed ...__children spread', () =>
    {
        const out = code('component C { <Box>hi</Box> }');
        expect(out).toContain('...__children');
    });

    it('types an array-form <For> row via __azRowForm so row.field infers from the blank row', () =>
    {
        const out = code('component C { form rows[] = { a: "" }; <For each={rows.rows()} key={(row) => row.key}>{(row) => <input bind:value={row.a} />}</For> }');
        // The array-form declaration is wrapped so rows() types each row as FieldArrayRow<R> & R.
        expect(out).toContain('__azRowForm(createFieldArray(');
        // The row callback is the typed children: prop through __azRow, so `row` (and `row.a`) infer
        // from the blank row while the runtime prop stays getter-typed.
        expect(out).toContain('children: __azRow(rows.rows(), (row) =>');
    });
});

describe('generateVirtualCode - self-contained ambient declarations', () =>
{
    it('declares h for markup, AzerothHandler for handlers, __children + __azRender for children', () =>
    {
        const out = code('component C { <button onClick={(e) => 0}>x</button><Box>y</Box> }');
        expect(out).toContain("declare const h: typeof import('azerothjs').h");
        expect(out).toContain('type AzerothHandler<');
        expect(out).toContain('declare const __children:');
        expect(out).toContain('declare function __azRender(');
    });
});

describe('generateVirtualCode - source mapping', () =>
{
    it('round-trips a user identifier between source and generated positions', () =>
    {
        const src = 'component C { state count = 0; <p>{count}</p> }';
        const { code: out, mapping } = generateVirtualCode(src);
        // The reactive READ of `count` inside `{count}` (not the declaration).
        const readPos = src.indexOf('count', src.indexOf('{count}'));
        const gen = mapping.toGenerated(readPos);
        expect(gen).not.toBeNull();
        expect(out.slice(gen!, gen! + 5)).toBe('count');
        expect(mapping.toOriginal(gen!)).toBe(readPos);
    });

    it('maps a generated position in scaffolding back to null', () =>
    {
        const { mapping } = generateVirtualCode('component C { <div>x</div> }');
        // Offset 0 is the generated `function C(` scaffolding - no original origin.
        expect(mapping.toOriginal(0)).toBeNull();
    });

    it('round-trips a component tag that abuts mapped script (shared generated boundary)', () =>
    {
        // Regression: `=> <Inner` lowers to `=> Inner(...)` - the `<` emits nothing, so the tag's start
        // sits exactly on the preceding script segment's exclusive end. A position on the component name
        // must map back to the tag, not one character early onto the `<`.
        const src = 'component C { const make = (n: number) => <Inner v={n}/>; <div>{make(1)}</div> }';
        const { mapping } = generateVirtualCode(src);
        const tagPos = src.indexOf('Inner');
        const gen = mapping.toGenerated(tagPos);
        expect(gen).not.toBeNull();
        expect(mapping.toOriginal(gen!)).toBe(tagPos);
    });

    it('holds verbatim + bijective at every interior mapped offset across constructs', () =>
    {
        // Property check: for any offset strictly inside a mapped segment, the generated text is the
        // identical character (verbatim) and the round-trip returns the same offset (bijective). Found
        // via two consecutive mapped offsets, so segment boundaries never raise a false positive.
        const sources = [
            'export default component App(props: { title: string }) { <h1 class="t">{props.title}</h1> }',
            'component C { state n = 0; derived d = n + 1; effect { console.log(n); } <button onClick={() => n = n + 1}>{d}</button> }',
            'component L { state items: string[] = []; <Show when={items.length > 0}><For each={items}>{(it) => <Row label={it}/>}</For></Show> }',
            'import { helper } from "./h"; component C { const v = helper(2); return <Inner data={v}/>; }'
        ];
        for (const src of sources)
        {
            const { code: gen, mapping } = generateVirtualCode(src);
            for (let o = 0; o < src.length; o++)
            {
                const g = mapping.toGenerated(o);
                if (g === null)
                {
                    continue;
                }
                const next = mapping.toGenerated(o + 1);
                if (next === null || next !== g + 1)
                {
                    continue; // only offsets strictly interior to a segment
                }
                expect(gen[g], `verbatim @${ o } in ${ src.slice(0, 20) }`).toBe(src[o]);
                expect(mapping.toOriginal(g), `bijective @${ o } in ${ src.slice(0, 20) }`).toBe(o);
            }
        }
    });
});

describe('generateVirtualCode - totality (never throws on incomplete source)', () =>
{
    // The projection is the single lowering behind the LSP, the ts-plugin, azeroth-tsc,
    // and eslint. A throw here does not just break one file - the ts-plugin throws inside
    // getScriptSnapshot and takes down ALL .ts IntelliSense project-wide. So mid-typing
    // states must degrade to a verbatim projection, never throw.
    const midEdit = [
        'export default component App() { return <div>',        // unclosed tag
        'export default component App() {',                      // unclosed body
        'export default component App() { return <div><span>',   // nested unclosed
        'export default component App() { state x = ',           // incomplete declaration
        '<div>{name.replace(/'                                    // unterminated regex mid-hole
    ];

    for (const src of midEdit)
    {
        it(`degrades instead of throwing: ${ JSON.stringify(src.slice(0, 40)) }`, () =>
        {
            const vc = generateVirtualCode(src);
            expect(typeof vc.code).toBe('string');
            expect(vc.mapping).toBeDefined();
        });
    }

    it('a valid module still projects normally after the guard', () =>
    {
        const vc = generateVirtualCode('export default component App() { return <h1>hi</h1>; }');
        expect(vc.code).toContain('h(');
    });

    it('fails a pathologically hole-nested module with a LOCATED CompileError, not a RangeError', () =>
    {
        // MAX_MARKUP_DEPTH is enforced per parseMarkup call, and the projection re-enters the parser at
        // depth 0 for every `{ ... }` hole, so without its own depth guard nesting through holes
        // overflows this mutual recursion (emitMarkup -> emitNode -> emitChild -> emitDynamic ->
        // emitCode). A RangeError out of the ONE projection is an internal crash in every tool that runs it.
        let inner = 'x';
        for (let i = 0; i < 700; i++)
        {
            inner = `<div>{${ inner }}</div>`;
        }
        let err: unknown = null;
        try
        {
            generateVirtualCode(`component C { ${ inner } }`);
        }
        catch (error)
        {
            err = error;
        }
        expect(err).toBeInstanceOf(CompileError);
        expect((err as CompileError).message).toContain('nested deeper than 500 levels');
        expect((err as CompileError).offset).toBeGreaterThan(0);
    });
});
