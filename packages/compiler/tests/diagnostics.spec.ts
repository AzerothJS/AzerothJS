// @vitest-environment node
//
// Real-execution coverage for diagnoseModule: each semantic diagnostic code -
// constant-derived, inert-effect, self-write-in-effect, handler-not-function -
// plus the deliberate non-finding cases (handler factory with args, reactive
// derived/effect).
import { describe, it, expect } from 'vitest';
import { diagnoseModule, diagnoseUnusedImports } from '@azerothjs/compiler';
import type { AzerothDiagnostic } from '@azerothjs/compiler';
import { generateModule } from '../src/codegen.ts';

function codes(src: string): string[]
{
    return diagnoseModule(src).map(d => d.code);
}

/** Compiles `src` then reports the unused-import names (the diagnostic needs the compiled JS). */
function unused(src: string): string[]
{
    return diagnoseUnusedImports(src, generateModule(src).code).map(d => d.message);
}

function find(src: string, code: string): AzerothDiagnostic | undefined
{
    return diagnoseModule(src).find(d => d.code === code);
}

describe('diagnoseUnusedImports', () =>
{
    it('flags an imported value that is never used', () =>
    {
        const out = unused('import { Show, Unused } from \'azerothjs\';\ncomponent C { state n = 0; <div><Show when={n}><p>x</p></Show></div> }');
        expect(out).toEqual(['`Unused` is imported but never used - remove the import.']);
    });

    it('does NOT flag a type-only import used in a props annotation', () =>
    {
        // The compiled JS drops type usages; the source cross-check keeps it.
        expect(unused('import type { IconNode } from \'lucide\';\ncomponent C(props: { icon: IconNode }) { <p>x</p> }')).toEqual([]);
    });

    it('does NOT flag a component used only in markup', () =>
    {
        expect(unused('import { Spinner } from \'./ui\';\ncomponent C { <div><Spinner /></div> }')).toEqual([]);
    });

    it('does NOT flag a helper used only in an attribute value', () =>
    {
        expect(unused('import { cn } from \'./cn\';\ncomponent C { <div class={cn("a")}>x</div> }')).toEqual([]);
    });

    it('reports the local alias name for an unused aliased import', () =>
    {
        expect(unused('import { foo as bar } from \'./x\';\ncomponent C { <p>hi</p> }')).toEqual(['`bar` is imported but never used - remove the import.']);
    });

    it('it is a warning located at the unused name', () =>
    {
        const src = 'import { Gone } from \'./x\';\ncomponent C { <p>hi</p> }';
        const diag = diagnoseUnusedImports(src, generateModule(src).code);
        expect(diag[0]!.severity).toBe('warning');
        expect(diag[0]!.code).toBe('azeroth/unused-import');
        expect(src.slice(diag[0]!.start, diag[0]!.end)).toBe('Gone');
    });
});

describe('diagnoseModule - constant-derived', () =>
{
    it('flags a derived that reads no reactive source', () =>
    {
        const diag = find('component C { derived d = 1 + 2; <p>{d}</p> }', 'azeroth/constant-derived');
        expect(diag).toBeDefined();
        expect(diag!.severity).toBe('warning');
        expect(diag!.message).toContain('derived d');
    });

    it('does not flag a derived that reads a source', () =>
    {
        expect(codes('component C { state n = 0; derived d = n + 1; <p>{d}</p> }')).not.toContain('azeroth/constant-derived');
    });

    it('does not flag a derived whose initializer contains a call (it may read a store accessor)', () =>
    {
        // `router.location()` is an external reactive source the dependency analysis cannot see;
        // warning here would suggest "use a plain value", which would silently break reactivity.
        expect(codes('component C { derived d = router.location().pathname; <p>{d}</p> }')).not.toContain('azeroth/constant-derived');
    });

    it('does not flag a derived that reads a PROPERTY off an external object', () =>
    {
        // The same argument as the call case, for the access shape the framework's OWN store uses.
        // `createStore` returns a proxy read by plain property access - `store.rows`, no call - so
        // a rule that exempts `router.location()` but flags `store.rows` fires on the idiomatic
        // way to consume the framework's own state container, and its suggested fix ("use a plain
        // value") would silently break reactivity in exactly the case it is most likely to hit.
        expect(codes('component C { derived d = socket.presence.online; <p>{d}</p> }')).not.toContain('azeroth/constant-derived');
        expect(codes('component C { derived d = settings.theme; <p>{d}</p> }')).not.toContain('azeroth/constant-derived');
    });

    it('still flags a provably constant derived built only from literals', () =>
    {
        // The exemption above must not swallow the rule: no external read, nothing to be reactive.
        expect(codes('component C { derived d = 1 + 2; <p>{d}</p> }')).toContain('azeroth/constant-derived');
        expect(codes('component C { derived d = `a${ 1 }b`; <p>{d}</p> }')).toContain('azeroth/constant-derived');
    });
});

describe('diagnoseModule - inert-effect', () =>
{
    it('flags an effect that reads no reactive source and has no calls/side effects', () =>
    {
        const diag = find('component C { effect { const x = 1 + 2; } <p>x</p> }', 'azeroth/inert-effect');
        expect(diag).toBeDefined();
        expect(diag!.severity).toBe('warning');
    });

    it('does not flag an effect that reads a source', () =>
    {
        expect(codes('component C { state n = 0; effect { console.log(n); } <p>{n}</p> }')).not.toContain('azeroth/inert-effect');
    });

    it('does not flag an effect whose body contains a call (it may read a store accessor)', () =>
    {
        // A call may read an external reactive source (e.g. a store) the analysis cannot see, or do
        // legitimate one-time setup (the `effect`-as-onMount idiom) - warning would be a false positive.
        expect(codes('component C { effect { setSeo({ title: "X" }); } <p>x</p> }')).not.toContain('azeroth/inert-effect');
    });
});

describe('diagnoseModule - self-write-in-effect', () =>
{
    it('flags an effect that both reads and assigns the same state', () =>
    {
        const diag = find('component C { state n = 0; effect { n = n + 1; } <p>{n}</p> }', 'azeroth/self-write-in-effect');
        expect(diag).toBeDefined();
        expect(diag!.severity).toBe('warning');
        expect(diag!.message).toContain('`n`');
    });

    it('does not flag an effect that writes a DIFFERENT state than it reads', () =>
    {
        const src = 'component C { state a = 0; state b = 0; effect { b = a + 1; } <p>{b}</p> }';
        expect(codes(src)).not.toContain('azeroth/self-write-in-effect');
    });

    it('flags `++`/`--` and compound self-updates (they read the target before writing)', () =>
    {
        expect(codes('component C { state n = 0; effect { n++; } <p>{n}</p> }')).toContain('azeroth/self-write-in-effect');
        expect(codes('component C { state n = 0; effect { n += 1; } <p>{n}</p> }')).toContain('azeroth/self-write-in-effect');
    });

    it('does NOT flag the clamp idiom: state read only in the GUARD, written from another source', () =>
    {
        // `page = totalPages` writes from a DIFFERENT source; `page` appears only in the condition, so
        // the write converges (stops once page <= totalPages) rather than looping.
        const src = 'component C { state page = 1; derived totalPages = 5; effect { if (page > totalPages) page = totalPages; } <p>{page}</p> }';
        expect(codes(src)).not.toContain('azeroth/self-write-in-effect');
    });
});

describe('diagnoseModule - handler-not-function', () =>
{
    it('flags a zero-arg call handler that runs at setup', () =>
    {
        const diag = find('component C { <button onClick={save()}>x</button> }', 'azeroth/handler-not-function');
        expect(diag).toBeDefined();
        expect(diag!.severity).toBe('error');
        expect(diag!.message).toContain('must be a function');
    });

    it('flags an assignment handler', () =>
    {
        expect(codes('component C { state n = 0; <button onClick={n = 1}>x</button> }')).toContain('azeroth/handler-not-function');
    });

    it('flags a ++/-- handler', () =>
    {
        expect(codes('component C { state n = 0; <button onClick={n++}>x</button> }')).toContain('azeroth/handler-not-function');
    });

    it('does NOT flag a handler-factory call WITH arguments', () =>
    {
        // onClick={makeHandler(id)} is the factory idiom - intentionally allowed.
        expect(codes('component C { <button onClick={makeHandler(id)}>x</button> }')).not.toContain('azeroth/handler-not-function');
    });

    it('does NOT flag a bare function-reference handler', () =>
    {
        expect(codes('component C { <button onClick={save}>x</button> }')).not.toContain('azeroth/handler-not-function');
    });

    it('does NOT flag an arrow-function handler', () =>
    {
        expect(codes('component C { state n = 0; <button onClick={() => n++}>x</button> }')).not.toContain('azeroth/handler-not-function');
    });
});

describe('diagnoseModule - multiple-roots', () =>
{
    it('flags every top-level markup region except the last (only the last is returned)', () =>
    {
        // Regression: without this diagnostic a component with <section> + <Show> silently
        // renders only the <Show> - the first root vanishes with no error.
        const src = 'component C { state on = false; <section>main</section> <Show when={on}>{() => <p>bar</p>}</Show> }';
        const diagnostic = find(src, 'azeroth/multiple-roots');
        expect(diagnostic).toBeDefined();
        expect(diagnostic?.severity).toBe('error');
        expect(diagnostic?.message).toContain('fragment');
        // The span points at the DISCARDED region (the first one).
        expect(src.slice(diagnostic!.start, diagnostic!.end)).toContain('<section>');
    });

    it('a single root - element, fragment, or control flow - is not flagged', () =>
    {
        expect(codes('component A { <section>one</section> }')).not.toContain('azeroth/multiple-roots');
        expect(codes('component B { state n = 0; <><p>{n}</p><p>two</p></> }')).not.toContain('azeroth/multiple-roots');
    });
});

describe('diagnoseModule - module-level', () =>
{
    it('returns an empty array for a module with no component', () =>
    {
        expect(diagnoseModule('const x = 1;')).toEqual([]);
    });

    it('every diagnostic carries a source span within the source', () =>
    {
        const src = 'component C { derived d = 1 + 2; <p>{d}</p> }';
        for (const diag of diagnoseModule(src))
        {
            expect(diag.start).toBeGreaterThanOrEqual(0);
            expect(diag.end).toBeGreaterThan(diag.start);
            expect(diag.end).toBeLessThanOrEqual(src.length);
        }
    });
});

describe('diagnoseModule - keyword-shadow (the STABILITY.md capture clause)', () =>
{
    it('a body-local named like a capture-guarded keyword warns with a span on the name', () =>
    {
        const src = 'component C { const mount = makeMount(); <p>x</p> }';
        const diags = diagnoseModule(src).filter((d) => d.code === 'azeroth/keyword-shadow');
        expect(diags).toHaveLength(1);
        expect(diags[0]!.severity).toBe('warning');
        expect(src.slice(diags[0]!.start, diags[0]!.end)).toBe('mount');
    });

    it('function declarations count; other names and the ORIGINAL keyword set do not', () =>
    {
        expect(diagnoseModule('component C { function mount() { return 1; } <p>x</p> }')
            .filter((d) => d.code === 'azeroth/keyword-shadow')).toHaveLength(1);

        // `mounted`, member access, and pre-1.0 keyword names stay quiet.
        const quiet = 'component C { const mounted = 1; const batch = 2; app.mount(); <p>{mounted + batch}</p> }';
        expect(diagnoseModule(quiet).filter((d) => d.code === 'azeroth/keyword-shadow')).toEqual([]);
    });
});

describe('diagnoseModule - malformed-component (the vanished-component diagnostic)', () =>
{
    const codesOf = (src: string): string[] =>
        diagnoseModule(src).filter((d) => d.code === 'azeroth/malformed-component').map((d) => d.message);

    it('a missing name, unbalanced generics, and a missing body brace each name their failure', () =>
    {
        expect(codesOf('component { <p>x</p> }')[0]).toContain('name is missing');
        expect(codesOf('component Foo<T { <p>x</p> }')[0]).toContain('type-parameter list never closes');
        expect(codesOf('component Foo(props: P) <p>x</p>')[0]).toContain('body `{` is missing');
    });

    it('the diagnostic spans the `component` keyword itself', () =>
    {
        const src = 'const a = 1;\ncomponent Broken(props: P) nope';
        const diag = diagnoseModule(src).find((d) => d.code === 'azeroth/malformed-component')!;
        expect(src.slice(diag.start, diag.end)).toBe('component');
    });

    it('ordinary identifiers named component never trigger: member access, annotation, assignment, strings, comments', () =>
    {
        const quiet = [
            'const component = 5; use(component);',
            'obj.component.render();',
            'interface X { component: string }',
            'const s = "component Foo {"; // component Bar {',
            '/* component Baz { */ const t = 1;'
        ];
        for (const src of quiet)
        {
            expect(codesOf(src)).toEqual([]);
        }
    });

    it('a VALID component is not flagged (and neither is code around it)', () =>
    {
        expect(codesOf('const x = 1;\ncomponent Fine { <p>{x}</p> }\nconst y = 2;')).toEqual([]);
    });
});

describe('declaration slips (silent-corruption traps)', () =>
{
    it('flags a missing semicolon that absorbs the next declaration', () =>
    {
        const diag = find('component A { state a = 1\n  state b = 2; <p>{a}</p> }', 'azeroth/unterminated-declaration');
        expect(diag).toBeDefined();
        expect(diag?.severity).toBe('error');
        // Points at the swallowed `state` keyword.
        expect(diag && 'component A { state a = 1\n  state b = 2; <p>{a}</p> }'.slice(diag.start, diag.end)).toBe('state');
    });

    it('flags a non-ASCII character in a declaration name', () =>
    {
        const diag = find('component A { state café = 1; <p>{a}</p> }', 'azeroth/non-ascii-name');
        expect(diag).toBeDefined();
        expect(diag?.severity).toBe('error');
    });

    it('does NOT flag correctly-terminated declarations', () =>
    {
        expect(codes('component A { state a = 1; state b = 2; <p>{a}</p> }')).not.toContain('azeroth/unterminated-declaration');
    });

    it('does NOT flag a keyword used as a member access or a value', () =>
    {
        expect(codes('component A(props: { state: boolean }) { derived x = props.state ? 1 : 2; <p>{x}</p> }'))
            .not.toContain('azeroth/unterminated-declaration');
        expect(codes('component A { store s = { state: 1 }; <p>{s.state}</p> }'))
            .not.toContain('azeroth/unterminated-declaration');
    });

    it('flags a missing semicolon that absorbs the RETURN MARKUP (decl -> markup)', () =>
    {
        // `state count = 0` with no `;`, then `<div>…`: the value runs to the body end and
        // swallows the markup (which vanishes). Undiagnosed, this compiles to garbage with 0 errors.
        const src = 'component App { state count = 0\n  <div>Count: {count()}</div> }';
        const diag = find(src, 'azeroth/unterminated-declaration');
        expect(diag).toBeDefined();
        expect(diag?.severity).toBe('error');
        expect(diag && src.slice(diag.start, diag.end)).toBe('state count');
    });

    it('flags markup placed directly as a declaration value', () =>
    {
        const src = 'component App { derived x = <div/>;\n  <p>ok</p> }';
        const diag = find(src, 'azeroth/unterminated-declaration');
        expect(diag).toBeDefined();
        expect(diag && src.slice(diag.start, diag.end)).toBe('<div');
    });

    it('does NOT flag a `<` comparison in a declaration value', () =>
    {
        expect(codes('component A { derived x = a() < b() ? 1 : 2; <p>{x}</p> }'))
            .not.toContain('azeroth/unterminated-declaration');
    });
});

describe('azeroth/for-row-shape - a For row is exactly one host element', () =>
{
    // The list reconciler tracks and moves rows by ELEMENT IDENTITY. A row rooted at a
    // component or at control flow returns a DocumentFragment, which empties itself into
    // the DOM on first insert; every later reconcile then diffs against an empty detached
    // node and the list blanks itself. First paint looks right, so this shipped in two
    // apps unnoticed - it is rejected here rather than left to fail silently at run time.
    const row = (body: string): string =>
        `component C { state items = []; <ul><For each={ items } key={ (r) => r.id } let={ row }>${ body }</For></ul> }`;

    it('rejects a control-flow-rooted row, naming the tag', () =>
    {
        const diag = find(row('<Show when={ row.ok }><li>x</li></Show>'), 'azeroth/for-row-shape');
        expect(diag?.severity).toBe('error');
        expect(diag?.message).toContain('<Show>');
        expect(diag?.message).toContain('wrap the row in an element');
    });

    it('rejects a component-rooted row and a multi-element row', () =>
    {
        expect(codes(row('<Card item={ row } />'))).toContain('azeroth/for-row-shape');
        expect(codes(row('<li>a</li><li>b</li>'))).toContain('azeroth/for-row-shape');
    });

    it('accepts one host element, including the wrapper that fixes the rejected shapes', () =>
    {
        expect(codes(row('<li>{ row.name }</li>'))).not.toContain('azeroth/for-row-shape');
        expect(codes(row('<li><Show when={ row.ok }><span>x</span></Show></li>'))).not.toContain('azeroth/for-row-shape');
        expect(codes(row('<g><Dynamic component={ row.tag } /></g>'))).not.toContain('azeroth/for-row-shape');
    });

    it('leaves Show/Match rows alone - only For reconciles by identity', () =>
    {
        const src = 'component C { state on = true; <div><Show when={ on } let={ v }><p>a</p><p>b</p></Show></div> }';
        expect(codes(src)).not.toContain('azeroth/for-row-shape');
    });
});

describe('diagnoseModule - azeroth/bind-target-not-reactive', () =>
{
    // GRAMMAR requires a writable REACTIVE lvalue. The codegen rewrite already rejects the
    // non-writable half (a `derived` target); this rule is the other half. A plain local passed
    // both gates and compiled to a HALF-dead binding: typing updated the variable, but nothing
    // could update the input, because the value effect closed over a non-reactive local.
    it('flags a bind: target declared as a plain let', () =>
    {
        expect(codes('component C { let name = "a"; <input bind:value={name} /> }'))
            .toContain('azeroth/bind-target-not-reactive');
    });

    it('flags a const target, which additionally throws on the first keystroke', () =>
    {
        expect(codes('component C { const name = "a"; <input bind:value={name} /> }'))
            .toContain('azeroth/bind-target-not-reactive');
    });

    it('names the variable and prescribes state', () =>
    {
        const found = find('component C { let name = "a"; <input bind:value={name} /> }', 'azeroth/bind-target-not-reactive');
        expect(found?.severity).toBe('error');
        expect(found?.message).toContain('`name`');
        expect(found?.message).toContain('state name');
    });

    it('anchors the span at the bind attribute, not the component', () =>
    {
        const src = 'component C { let name = "a"; <input bind:value={name} /> }';
        const found = find(src, 'azeroth/bind-target-not-reactive');
        expect(src.slice(found?.start ?? 0, found?.end ?? 0)).toContain('bind:value');
    });

    // The false-positive half. Every case below is code that must keep compiling - the shipped
    // examples depend on the form-field and store-path shapes, and rejecting them would be worse
    // than the defect this rule closes.
    it('does NOT flag a state target', () =>
    {
        expect(codes('component C { state name = "a"; <input bind:value={name} /> }'))
            .not.toContain('azeroth/bind-target-not-reactive');
    });

    it('does NOT flag a form field - a member expression, and form is not a source kind', () =>
    {
        expect(codes('component C { form login = { email: "" }; <input bind:value={login.email} /> }'))
            .not.toContain('azeroth/bind-target-not-reactive');
    });

    it('flags a store path: the handle is a function, and no rewrite exists for paths through it', () =>
    {
        // An earlier version of this test pinned the store path as NOT flagged - a diagnostics-only
        // blessing of a spelling that crashes at mount (`s.a` reads a property off the useStore
        // FUNCTION). The first executed probe overturned it.
        const found = find('component C { store s = () => ({ a: 1 }); <input bind:value={s.a} /> }',
            'azeroth/bind-target-not-reactive');
        expect(found?.message).toContain('store');
        expect(found?.message).toContain('s()');
    });

    it('flags a props path and an import, which are read-only, and leaves undeclared names alone', () =>
    {
        // Both compiled to silently broken write-backs: `props.v = ...` on a getter-only props
        // object throws per keystroke, and an assignment to an import is a TypeError. A name the
        // module never declares is left alone - it may be anything.
        expect(find('component C(props: { v: string }) { <input bind:value={props.v} /> }',
            'azeroth/bind-target-not-reactive')?.message).toContain('prop');
        expect(find('import { external } from "./x"; component C { <input bind:value={external} /> }',
            'azeroth/bind-target-not-reactive')?.message).toContain('import');
        expect(codes('component C { <input bind:value={somethingAmbient} /> }'))
            .not.toContain('azeroth/bind-target-not-reactive');
    });

    it('does NOT flag a plain local that is never bound', () =>
    {
        expect(codes('component C { let helper = 1; state v = "a"; <input bind:value={v} /> }'))
            .not.toContain('azeroth/bind-target-not-reactive');
    });

    it('reports a derived bind as read-only, so every surface sees it before codegen throws', () =>
    {
        // The rewrite guard only fires during CODEGEN, which the language server never runs - so
        // `bind:value={derived}` showed no diagnostic in the editor and then failed the build.
        // The coded rule reports it first; the guard stays as the backstop for plain assignments.
        const found = find('component C { state a = 1; derived d = a + 1; <input bind:value={d} /> }',
            'azeroth/bind-target-not-reactive');
        expect(found?.message).toContain('`derived` value');
        expect(found?.message).toContain('read-only');
    });
});

describe('diagnoseModule - bind-target scope awareness', () =>
{
    // A first version of the rule matched on the NAME alone, so an unrelated component-level
    // local made a genuinely reactive nested binding fail to build - and renaming that local was
    // the only cure. These pin the scope rules that replaced it.
    it('does NOT flag a nested state that shares a name with an outer plain local', () =>
    {
        const src = 'component Composer { let draft = "seed"; state rows = [1, 2]; '
            + '<div><p>{draft}</p>{rows.map(() => { state draft = ""; return <input bind:value={draft} />; })}</div> }';
        expect(codes(src)).not.toContain('azeroth/bind-target-not-reactive');
    });

    it('does NOT flag a nested state inside a render-function attribute', () =>
    {
        const src = 'component C { let v = ""; state on = false; '
            + '<Show when={on} fallback={() => { state v = ""; return <input bind:value={v} />; }}><p>ok</p></Show> }';
        expect(codes(src)).not.toContain('azeroth/bind-target-not-reactive');
    });

    it('flags a bind: onto a For row binding, which compiles to an assignment to a call', () =>
    {
        // Previously silent: `bind:value={item}` emitted `item() = value`, which parses and then
        // throws ReferenceError on the first keystroke. Same defect class as the plain local.
        const found = find('component C { state items = ["a"]; <For each={items} let={item}><input bind:value={item} /></For> }',
            'azeroth/bind-target-not-reactive');
        expect(found?.severity).toBe('error');
        expect(found?.message).toContain('row binding');
    });

    it('reports the row binding as a row binding even when an outer local shares its name', () =>
    {
        // The name resolves to the row, so "declare it as state" would be wrong advice.
        const src = 'component C { let item = "helper"; state items = ["a"]; '
            + '<For each={items} let={item}><input bind:value={item} /></For> }';
        const found = find(src, 'azeroth/bind-target-not-reactive');
        expect(found?.message).toContain('row binding');
        expect(found?.message).not.toContain('plain variable');
    });
});

describe('diagnoseModule - bind-target row scan uses the semantics gate', () =>
{
    // `let`/`index` only DECLARE a subtree name on a built-in that binds them. Treating the
    // attribute as a row binding on any element let an ordinary author attribute shadow a real
    // component source, so a valid `state` binding was rejected and a program that built at HEAD
    // stopped building - with no way to suppress it.
    it('does NOT treat let= on a user component as a row binding', () =>
    {
        const src = 'import Panel from "./Panel.azeroth"; '
            + 'component C { state x = "a"; <Panel let={x}><input bind:value={x} /></Panel> }';
        expect(codes(src)).not.toContain('azeroth/bind-target-not-reactive');
    });

    it('does NOT treat a static let="x" on a host element as a row binding', () =>
    {
        const src = 'component C { state x = "a"; <div let="x"><input bind:value={x} /></div> }';
        expect(codes(src)).not.toContain('azeroth/bind-target-not-reactive');
    });

    it('still recognises a real For row binding', () =>
    {
        const src = 'component C { state items = ["a"]; <For each={items} let={item}><input bind:value={item} /></For> }';
        expect(find(src, 'azeroth/bind-target-not-reactive')?.message).toContain('row binding');
    });

    it('still reports a plain local as a plain variable, not as a row binding', () =>
    {
        const src = 'component C { let x = "a"; <input bind:value={x} /> }';
        expect(find(src, 'azeroth/bind-target-not-reactive')?.message).toContain('plain variable');
    });
});

describe('diagnoseModule - azeroth/for-missing-key', () =>
{
    // `<For>` declares `key` non-optional and calls `props.key(item, i)` unconditionally on both
    // the reconcile and hydrate paths. Keyless, the page SERVED and then threw on mount - the
    // worst shape of failure, since SSR looked healthy. The type already forbade it; the compiler
    // now says so too, rather than shipping an index fallback that would break row identity.
    it('rejects a <For> with no key', () =>
    {
        const found = find('component C { state items = [1]; <For each={items} let={i}><li>{i}</li></For> }',
            'azeroth/for-missing-key');
        expect(found?.severity).toBe('error');
        expect(found?.message).toContain('key={(item) => item.id}');
    });

    it('accepts a keyed <For>, and stays silent when key arrives through a spread', () =>
    {
        expect(codes('component C { state items = [1]; <For each={items} key={(i) => i} let={i}><li>{i}</li></For> }'))
            .not.toContain('azeroth/for-missing-key');
        // A spread is opaque - the language cannot see its keys, so it must not be second-guessed.
        expect(codes('component C { state items = [1]; <For each={items} {...rest} let={i}><li>{i}</li></For> }'))
            .not.toContain('azeroth/for-missing-key');
    });

    it('rejects a keyless <For> in every position the emitter compiles one', () =>
    {
        const shapes = [
            'component C { state items = [1]; state c = true; <div>{ c ? <For each={items} let={i}><li>{i}</li></For> : null }</div> }',
            'component C { state items = [1]; const frag = <For each={items} let={i}><li>{i}</li></For>; <div>{frag}</div> }'
        ];
        for (const src of shapes)
        {
            expect(codes(src)).toContain('azeroth/for-missing-key');
        }
    });
});

describe('diagnoseModule - a <For> row must be an element, not any expression', () =>
{
    // The row-shape exemption admitted ANY expression child, which let through two shapes the
    // runtime cannot render - the same serve-then-die split as a keyless <For>.
    it('rejects a function REFERENCE row, which SSR renders and the client throws on', () =>
    {
        expect(codes('component C { state x = [1]; <For each={x} key={(i) => i}>{renderRow}</For> }'))
            .toContain('azeroth/for-row-shape');
    });

    it('rejects a bare hole row, which throws in BOTH modes', () =>
    {
        // `let=` binds a row name for a row ELEMENT; a bare hole never receives it.
        expect(codes('component C { state x = [{ n: 1 }]; <For each={x} key={(i) => i} let={item}>{ item.n }</For> }'))
            .toContain('azeroth/for-row-shape');
    });

    it('still defers a function LITERAL child to the callback-children rule', () =>
    {
        // Not double-reported: callback children were removed from the language, and that rule
        // has the message that names the replacement.
        const found = codes('component C { state x = [{ n: 1 }]; <For each={x} key={(i) => i}>{(item) => <li>{item().n}</li>}</For> }');
        expect(found).toContain('azeroth/callback-children-removed');
        expect(found).not.toContain('azeroth/for-row-shape');
    });

    it('accepts the element row', () =>
    {
        expect(codes('component C { state x = [{ n: 1 }]; <For each={x} key={(i) => i} let={item}><li>{item.n}</li></For> }'))
            .toEqual([]);
    });
});

describe('diagnoseModule - azeroth/markup-value-reused', () =>
{
    // A markup value is a NODE. `const frag = <b/>; <p>{frag}{frag}</p>` serializes TWO copies on
    // the server and mounts ONE on the client, because appending the same node twice moves it -
    // measured, not assumed: ssr `<p><b>X</b><b>X</b></p>` against a client with one <b>. GRAMMAR
    // makes mode equivalence unconditional for accepted programs, so the language refuses this
    // rather than picking a winner; making it equivalent would mean markup values were
    // re-renderable templates, which is a different language.
    it('rejects a markup value placed twice, pointing at the placement that vanishes', () =>
    {
        const src = 'component C { const frag = <b>X</b>; <p>{frag}{frag}</p> }';
        const found = find(src, 'azeroth/markup-value-reused');
        // A warning: the divergence is real, but the rule decides it from syntax alone, and a
        // build-stopping rule has to be right every time.
        expect(found?.severity).toBe('warning');
        // The SECOND placement is the one the client discards, so that is what is flagged.
        expect(src.slice(found?.start ?? 0, found?.end ?? 0)).toBe('frag');
        expect(found?.start).toBeGreaterThan(src.indexOf('{frag}') + 1);
    });

    it('reports every extra placement, not just the first', () =>
    {
        const all = diagnoseModule('component C { const f = <b>X</b>; <p>{f}{f}{f}</p> }')
            .filter(d => d.code === 'azeroth/markup-value-reused');
        expect(all).toHaveLength(2);
    });

    it('accepts a markup value used once, and two values used once each', () =>
    {
        expect(codes('component C { const frag = <b>X</b>; <p>{frag}</p> }')).toEqual([]);
        expect(codes('component C { const a = <b>A</b>; const z = <i>Z</i>; <p>{a}{z}</p> }')).toEqual([]);
    });

    it('accepts a markup value named twice in ONE placement (a ternary picks one)', () =>
    {
        // The first version of this test named TWO DIFFERENT values, each once - so it passed with
        // no ternary handling at all and could not fail for the case its own title describes. The
        // rule did reject this shape, contradicting the CHANGELOG, and the test could not see it.
        expect(codes('component C { state c = true; const frag = <b>X</b>; <p>{ c ? frag : frag }</p> }'))
            .toEqual([]);
        expect(codes('component C { state c = true; const a = <b>A</b>; const z = <i>Z</i>; <p>{ c ? a : z }</p> }'))
            .toEqual([]);
    });

    it('counts PLACEMENTS, not reads: a handler, an attribute, or a shadowing binding is not one', () =>
    {
        // Counting every identifier read rejected code that measurably does NOT diverge - a value
        // read in a handler beside one placement, a value never placed at all, and a <For> row
        // parameter that merely shares the name.
        const frag = 'const frag = <b>X</b>;';
        expect(codes(`component C { ${ frag } <div onClick={() => console.log(frag)}>{frag}</div> }`)).toEqual([]);
        expect(codes(`component C { ${ frag } <p data-a={String(frag).length} data-b={String(frag).length}>t</p> }`)).toEqual([]);
        expect(codes(`component C { ${ frag } <p>{[1].map((frag) => frag)}{frag}</p> }`)).toEqual([]);
        // A single reference inside markup embedded in a hole is ONE reference, not two - whether
        // it was flagged used to depend on how TypeScript error-recovered the hole text.
        expect(codes(`component C { ${ frag } <div>{true && <div>{frag}</div>}</div> }`)).toEqual([]);
        // TWO child holes that merely READ the value are still zero placements - the discriminating
        // case for the gate, since counting happens per hole.
        expect(codes(`component C { ${ frag } <p>{String(frag).length}{String(frag).length}</p> }`)).toEqual([]);
    });

    it('says nothing about a non-markup local used twice', () =>
    {
        expect(codes('component C { const n = 5; <p>{n}{n}</p> }')).toEqual([]);
    });
});

describe('diagnoseModule - a row binding shadows a markup local of the same name', () =>
{
    // The placement walk had no scope, so a `<For let={frag}>` row named like a markup local was
    // counted as placing that local - an unsuppressable failure on a program that compiled before,
    // and the exact case this rule's own comment claims is NOT counted.
    it('does not count a For row binding as a placement of the local it shadows', () =>
    {
        expect(codes('component C { state items = ["a"]; const frag = <b>x</b>; void frag;'
            + ' <p><For each={items} key={(i) => i} let={frag}><i>{frag}{frag}</i></For></p> }'))
            .not.toContain('azeroth/markup-value-reused');
    });

    it('does not count a Show row binding either', () =>
    {
        expect(codes('component C { state v = true; const frag = <b>x</b>;'
            + ' <p>{frag}<Show when={v} let={frag}><i>{frag}</i></Show></p> }'))
            .not.toContain('azeroth/markup-value-reused');
    });

    it('still rejects a genuine reuse in the same component', () =>
    {
        expect(codes('component C { state items = ["a"]; const frag = <b>x</b>;'
            + ' <p>{frag}{frag}<For each={items} key={(i) => i} let={row}><i>{row}</i></For></p> }'))
            .toContain('azeroth/markup-value-reused');
    });
});
