// @vitest-environment node
//
// Compiler audit: locks the invariants verified by adversarial probing, and records the
// known gaps as `todo` markers (intended behavior, not yet implemented) plus concrete
// assertions of the current (defective) output so a future fix breaks loudly here.
import { describe, it, expect } from 'vitest';
import { generateModule } from '../src/codegen.ts';
import { diagnoseModule } from '../src/diagnostics.ts';
import { typeCheckModuleTS } from '../src/typecheck-ts.ts';

const code = (src: string): string => generateModule(src, 'X.azeroth').code;

describe('compiler audit — verified invariants', () =>
{
    it('codegen is deterministic (identical output for identical input)', () =>
    {
        const src = 'component C { state a = 0; state b = 0; <div><span>{a}</span><For each={list}>{(i) => <li>{i}</li>}</For></div> }';
        expect(code(src)).toBe(code(src));
    });

    it('the optimizer folds literal arithmetic/concat into the template', () =>
    {
        expect(code('component C { <p>{1 + 2}</p> }')).toContain('<p>3</p>');
        expect(code('component C { <p>{"a" + "b"}</p> }')).toContain('<p>ab</p>');
        // Folded value matches what the runtime would compute (no compile/runtime drift).
        expect(code('component C { <p>{0.1 + 0.2}</p> }')).toContain('0.30000000000000004');
    });

    it('the optimizer is conservative: comparisons/booleans/null are NOT folded', () =>
    {
        // These keep a runtime binding rather than being baked, so runtime render
        // semantics (e.g. how a boolean child is rendered) are never pre-decided.
        for (const expr of ['1 < 2', 'true', 'null', 'cond ? a : b'])
        {
            expect(code(`component C { <p>{${ expr }}</p> }`)).toContain('bindHole');
        }
    });

    it('nested component props use the getter-object contract; event props stay functions', () =>
    {
        const out = code('component C { state n = 0; <Child a="lit" b={n} onPick={() => n++} {...rest}><span>kid</span></Child> }');
        expect(out).toContain("a: 'lit'");
        expect(out).toMatch(/get b\(\) \{ return n\(\); \}/);
        expect(out).toMatch(/get onPick\(\) \{ return \(\) => setN/);
        expect(out).toContain('...rest');
        expect(out).toMatch(/get children\(\)/);
    });

    it('preserves generic arrows but rejects angle-bracket casts (TSX rule)', () =>
    {
        // `.azeroth` follows the TSX rule: a generic arrow keeps its disambiguating comma (`<T,>`)
        // and survives untouched, but an angle-bracket type assertion (`<Foo>expr`) is disallowed -
        // it is now read as a forgotten-close-tag markup error (write `expr as Foo` instead).
        expect(code('component C { const id = <T,>(v: T) => v; <p>ok</p> }')).toContain('<T,>(v: T) => v');
        expect(() => code('component C { const y = <Foo>bar; <p>ok</p> }')).toThrow(/Unclosed <Foo>/);
    });

    it('error-severity diagnostics are not silently downgraded (severity is preserved)', () =>
    {
        const handler = diagnoseModule('component C { state n = 0; <button onClick={n++}>x</button> }');
        expect(handler.find(d => d.code === 'azeroth/handler-not-function')?.severity).toBe('error');
        const assignDerived = diagnoseModule('component C { state n = 0; derived d = n * 2; <button onClick={() => d = 5}>{d}</button> }');
        expect(assignDerived.find(d => d.code === 'azeroth/assign-to-derived')?.severity).toBe('error');
    });
});

describe('compiler audit — Phase 1 fixes (M1 + enforcement consistency)', () =>
{
    it('M1: assigning or incrementing a `derived` is a located compile error (no phantom setter)', () =>
    {
        expect(() => code('component C { state n = 0; derived d = n * 2; <button onClick={() => d = 5}>{d}</button> }'))
            .toThrow(/Cannot assign to `d`: a `derived` value is read-only/);
        expect(() => code('component C { state n = 0; derived d = n * 2; <button onClick={() => d++}>{d}</button> }'))
            .toThrow(/read-only/);
        // Comprehensive: a derived write inside an effect is rejected too, not just in handlers.
        expect(() => code('component C { state n = 0; derived d = n * 2; effect { d = 5; } <p>{d}</p> }'))
            .toThrow(/read-only/);
    });

    it('a `state` write is still allowed (no false positive on writable sources)', () =>
    {
        expect(() => code('component C { state n = 0; <button onClick={() => n = 5}>{n}</button> }')).not.toThrow();
    });

    it('error-severity diagnostics fail generateModule, not only the Vite plugin (handler-not-function)', () =>
    {
        expect(() => code('component C { state n = 0; <button onClick={n++}>x</button> }'))
            .toThrow(/handler-not-function/);
    });
});

describe('compiler audit — M2 fixes (malformed markup is a hard, located error)', () =>
{
    it('M2: markup the parser COMMITTED to (mismatched/nested/attrs) is a located CompileError, not raw passthrough', () =>
    {
        // `<div><span></div>` committed (nested element + a `</` close tag), so it now hard-errors
        // instead of degrading to invalid raw TS that only oxc would later choke on.
        expect(() => code('component C { <div><span></div> }')).toThrow(/Mismatched closing tag|Expected/);
        expect(() => code('component C { <div class="x"> }')).toThrow();        // committed via attribute
        expect(() => code('component C { <Show when={c}><p>x</p></div> }')).toThrow();
        expect(() => code('component C { <>x }')).toThrow();                    // committed via fragment
    });

    it('M2: the committed-markup error is located (carries a source offset)', () =>
    {
        let caught: unknown;
        try
        {
            code('component C {\n    <div><span></div>\n}');
        }
        catch (err)
        {
            caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as { offset?: number }).offset).toBeGreaterThan(0);
    });

    it('M2 boundary: generic arrows fall back, but angle-bracket casts are now rejected', () =>
    {
        // A generic arrow throws in attribute-name reading (the `,`) before the opening tag commits,
        // so it still falls back to opaque TS. An angle-bracket cast completes an opening tag and
        // commits, so a forgotten close is a located error (the TSX cast rule).
        expect(() => code('component C { const id = <T,>(v: T) => v; <p>ok</p> }')).not.toThrow();
        expect(() => code('component C { const y = <Foo>bar; <p>ok</p> }')).toThrow(/Unclosed <Foo>/);
        expect(() => code('component C { const n = <number>x; <p>ok</p> }')).toThrow(/Unclosed <number>/);
    });
});

describe('compiler audit — Phase 2 (IR validation before codegen)', () =>
{
    it('a component exercising every binding kind passes IR validation and compiles', () =>
    {
        // text hole, attribute, event, and a component slot (Show) -> the IR has text/attribute/
        // event/component bindings over hole/element/slot nodes; validatePlan accepts it.
        const out = code('component C { state n = 0; <div class={n}><button onClick={() => n++}>{n}</button><Show when={n}><p>+</p></Show></div> }');
        expect(out).toContain('bindHole(');
        expect(out).toContain('bindSlot(');
        expect(out).toContain('addEventListener(');
        expect(out).toContain('setProp(');
    });

    it('determinism holds with IR validation in the pipeline', () =>
    {
        const src = 'component C { state a = 0; <ul><For each={list}>{(i) => <li>{i}</li>}</For></ul> }';
        expect(code(src)).toBe(code(src));
    });
});

describe('compiler audit — current behavior of invalid input (residual; see audit report)', () =>
{
    it('FIXED: a bare `<Foo>bar` (forgotten `</Foo>`) is now a located error, not an opaque cast', () =>
    {
        // Angle-bracket casts are disallowed, so a completed opening tag commits to markup: the
        // missing `</Foo>` is reported where it sits instead of silently shipping as `(bar as Foo)`.
        let caught: unknown;
        try
        {
            code('component C { <Foo>bar }');
        }
        catch (err)
        {
            caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toMatch(/Unclosed <Foo>/);
        expect((caught as { offset?: number }).offset).toBeGreaterThan(0);
    });

    it('RESIDUAL: a setup effect hidden in a comma sequence is not rejected (handler setup-leak)', () =>
    {
        // The handler classifier only inspects the top-level expression form, so a comma sequence
        // whose last operand is a write slips through and the setter runs at setup. A type-checker
        // would reject it (number is not a handler); see U1.
        const out = code('component C { state n = 0; <button onClick={(a, n++)}>x</button> }');
        expect(out).toMatch(/addEventListener\('click', \(a, setN/);
    });
});

const codes = (src: string): string[] => diagnoseModule(src).map((d) => `${ d.severity }:${ d.code }`);
const withDerived = (body: string): string => `component C(props: { id: number }) { state n = 0; derived d = n * 2; ${ body } }`;

describe('correctness — M1 derived mutation (caught in BOTH phases, every context)', () =>
{
    it('the semantic phase (diagnoseModule) reports assign-to-derived in a handler', () =>
    {
        expect(codes(withDerived('<button onClick={() => d = 5}>{d}</button>'))).toContain('error:azeroth/assign-to-derived');
    });

    it('...in an effect body', () =>
    {
        expect(codes(withDerived('effect { d++; }  <p>{d}</p>'))).toContain('error:azeroth/assign-to-derived');
    });

    it('...in an opaque setup statement', () =>
    {
        expect(codes(withDerived('d = 9;  <p>{d}</p>'))).toContain('error:azeroth/assign-to-derived');
    });

    it('...in a hole expression', () =>
    {
        expect(codes(withDerived('<p>{(d = 5)}</p>'))).toContain('error:azeroth/assign-to-derived');
    });

    it('both phases reject and generateModule throws a read-only error', () =>
    {
        const src = withDerived('<button onClick={() => d = 5}>{d}</button>');
        // Semantic phase:
        expect(diagnoseModule(src).some((x) => x.code === 'azeroth/assign-to-derived' && x.severity === 'error')).toBe(true);
        // Rewrite phase / generateModule gate:
        expect(() => code(src)).toThrow(/read-only/);
    });

    it('the diagnostic is located (positive offset)', () =>
    {
        const d = diagnoseModule('component C {\n  state n = 0; derived d = n * 2;\n  effect { d = 5; }\n  <p>{d}</p>\n}')
            .find((x) => x.code === 'azeroth/assign-to-derived');
        expect(d!.start).toBeGreaterThan(0);
    });

    it('compound and ++/-- forms are all rejected; a state write is NOT', () =>
    {
        for (const w of ['d = 5', 'd += 1', 'd++', '--d'])
        {
            expect(() => code(withDerived(`<button onClick={() => ${ w }}>x</button>`))).toThrow(/read-only/);
        }
        expect(codes(withDerived('<button onClick={() => n = 5}>{n}</button>'))).not.toContain('error:azeroth/assign-to-derived');
    });

    it('does NOT false-positive on a derived READ used as an attribute inside render-function markup', () =>
    {
        // A render-function value (`fallback={() => (<markup/>)}`) embeds markup whose `attr={d}` reads
        // as the assignment `attr = {d}` if parsed as flat TS. The diagnostic must not flag the read;
        // here `total={d}` is a plain read of the derived, not a write.
        const src = withDerived('<Show when={n} fallback={() => (<Pagination total={d} onChange={(p: number) => n = p} />)}><p>x</p></Show>');
        expect(codes(src)).not.toContain('error:azeroth/assign-to-derived');
        expect(() => code(src)).not.toThrow();
    });

    it('STILL rejects a genuine derived write inside render-function markup (codegen rewrite guard)', () =>
    {
        // The diagnostic skips markup-bearing expressions, but the codegen rewrite guard remains the
        // backstop: a real `d = 5` inside the fallback markup must still throw.
        const src = withDerived('<Show when={n} fallback={() => (<button onClick={() => d = 5}>x</button>)}><p>x</p></Show>');
        expect(() => code(src)).toThrow(/read-only/);
    });
});

describe('correctness — M2 malformed markup stress (every case is a located error)', () =>
{
    const malformed = [
        '<div><span></div>',
        '<div class="x">',
        '<Show when={c}>x',
        '<ul><li>a</ul>',
        '<>x',
        '<div></span>',
        '<a href="x">link',
        '<section><p>text</section>'
    ];
    for (const markup of malformed)
    {
        it(`rejects ${ JSON.stringify(markup) } with a located CompileError`, () =>
        {
            let err: unknown;
            try
            {
                code(`component C { state c = false; ${ markup } }`);
            }
            catch (e)
            {
                err = e;
            }
            expect(err).toBeInstanceOf(Error);
            expect((err as { offset?: number }).offset).toBeGreaterThan(0);
        });
    }

    it('the same shapes, well-formed, still compile', () =>
    {
        expect(() => code('component C { <div class="x"><span>a</span></div> }')).not.toThrow();
        expect(() => code('component C { state c = false; <Show when={c}><p>x</p></Show> }')).not.toThrow();
        expect(() => code('component C { <ul><li>a</li></ul> }')).not.toThrow();
        expect(() => code('component C { <section><p>text</p></section> }')).not.toThrow();
    });
});

describe('correctness — M3 handler edge cases (accept functions, reject setup effects)', () =>
{
    const reject = ['count++', '--count', 'count = 5', 'count += 1', 'save()', 'props.onClose()', 'save?.()'];
    const accept = ['save', 'props.onClose', '() => count++', '(e) => save(e)', 'makeHandler(id)'];
    const wrap = (h: string): string => `component C(props: { id: number }) { state count = 0; <button onClick={${ h }}>x</button> }`;

    for (const h of reject)
    {
        it(`rejects onClick={${ h }}`, () =>
        {
            expect(() => code(wrap(h))).toThrow();
        });
    }
    for (const h of accept)
    {
        it(`accepts onClick={${ h }}`, () =>
        {
            expect(() => code(wrap(h))).not.toThrow();
        });
    }
});

describe('compiler audit — U1 type-checker (real ts.Program, now implemented)', () =>
{
    it('provides a build-time type-check path: non-function handlers are caught', () =>
    {
        // `count` is a number-typed state, not a function - a type-only error the syntactic
        // guard cannot see (a bare identifier read is not assignment/++/call).
        const diagnostics = typeCheckModuleTS('component C { state count = 0; <button onClick={count}>x</button> }');
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].code).toBe('azeroth/handler-type');
    });

    it('provides a build-time type-check path: wrong component prop types are caught', () =>
    {
        const source = `component Child(props: { count: number }) {
    <p>{props.count}</p>
}
component Parent {
    <Child count={"nope"} />
}`;
        const diagnostics = typeCheckModuleTS(source);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].code).toBe('azeroth/prop-type');
    });

    it('type-checks setup-effect handlers wrapped in comma/conditional expressions', () =>
    {
        // The syntactic guard cannot see through `(count, count++)`, but the real checker types
        // the comma expression as number -> not assignable to an event handler -> rejected.
        const diagnostics = typeCheckModuleTS('component C { state count = 0; <button onClick={(count, count++)}>x</button> }');
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].code).toBe('azeroth/handler-type');
    });
});
